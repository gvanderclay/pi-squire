// The delegation records and the result message. A delegation is recorded in
// the parent session when it starts, and again when it is closed; when the
// provider claims a reply that answers a recorded task, this listener takes
// the message over, shows the parent one delegate result and records the
// result. Local records own result processing; the shared tree registry owns
// cross-process admission accounting.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { type ChildOutcome, ChildTasks } from "./child-tasks.ts";
import type { ApprovedCheck } from "./delegate-check.ts";
import type { DelegateHost } from "./host.ts";
import { renderMessage } from "./render.ts";
import { type CheckResult, runChecks } from "./result-check.ts";
import { closeOutcome, goneOutcome } from "./result-close.ts";
import { resultBodyBudget, resultDetails, resultText } from "./result-message.ts";
import { restoreRecords } from "./result-restore.ts";
import { finishedModel, locateSession, sessionIdOf } from "./result-sessions.ts";
import {
	type AttemptState,
	type Delegation,
	type Inbound,
	isStarted,
	type Recorded,
	type Result,
	recordedName,
	START_TYPE,
	type StartedRecorded,
	type WorkspaceAttempt,
} from "./result-types.ts";
import { ResultsPresentation } from "./results-presentation.ts";
import { routingEvidence } from "./routing-provenance.ts";
import { sessionUsage } from "./session-usage.ts";
import { inspectWorkspace } from "./snapshot.ts";
import { locatedRecord } from "./tmux.ts";

export { findSession, finishedModel, sessionHeaderCwd, sessionIdOf } from "./result-sessions.ts";
export type {
	AttemptState,
	Delegation,
	Envelope,
	Inbound,
	MessageDetails,
	Recorded,
	RequestCopy,
	ResourceFacts,
	Result,
	StartedRecorded,
	TaskQuote,
	WorkspaceAttempt,
} from "./result-types.ts";
export { isStarted, locateSession };

/** The session entry type both delegation records and results use. */
export const CUSTOM_TYPE = "delegate";
/** The footer entry that counts delegations whose result has not arrived. */
export const STATUS_KEY = "delegate";
/** The `pi.events` channel a provider emits claimed envelopes on. */
const INBOUND = "message:inbound";

export type Results = {
	/** Presentation-only observers; never part of task accounting or the completion barrier. */
	subscribe(listener: () => void): () => void;
	/** Keep the legacy count for non-TUI/cap-zero views without replacing any footer. */
	setCountVisible(visible: boolean): void;
	/** Rebuild the records from the session's custom entries, as on a resume. */
	restore(ctx: ExtensionContext): void;
	/** Record a delegation and show it as running; it supersedes an attempt with the same id. */
	recordStart(delegation: Delegation, ctx: ExtensionContext): void;
	/** Record a workspace attempt, or its next state; never counted as running. */
	recordAttempt(attempt: WorkspaceAttempt, ctx: ExtensionContext): void;
	/** Record a close; does nothing when there is no such delegation or it is already closed. */
	recordClose(id: string, wake?: boolean): void;
	/** Import only confirmed own direct-child closes; no foreign semantic writes. */
	syncCloses(wake?: boolean): void;
	/** Delegations with no result, no recorded close and no gone-window record. */
	running(): StartedRecorded[];
	/** Record that the window is gone with no result, and tell the parent once. False when it no longer applies. */
	recordGone(id: string): boolean;
	/** Every delegation, in the order it was recorded. */
	list(): Recorded[];
	/** One delegation by id. */
	find(id: string): Recorded | undefined;
	/** No unfinished direct-child task or unprocessed terminal outcome. */
	completionReady(): boolean;
	/** Refuse unhealthy local facts; optionally persist a preflight snapshot before launch effects. */
	checkStorage(write?: boolean): void;
};

export type { WindowState } from "./window-state.ts";

/**
 * A delegation's state. `closed` is a recorded `delegation_close`; `gone` is
 * closed without a result (the poll found the window missing); `window-closed`
 * is a window tmux no longer lists, seen when asked directly.
 */
export type DelegationState =
	| "closed"
	| "done"
	| "gone"
	| "running"
	| "window-closed"
	| "unknown"
	| AttemptState["phase"];

export { delegateName, deriveState, recordedName } from "./result-types.ts";

export function createResults(
	pi: ExtensionAPI,
	processesChildren: () => boolean = () => false,
	publish: (ctx: ExtensionContext, records: Recorded[]) => void = () => {},
	active: () => boolean = () => true,
	closedChildren: (ctx: ExtensionContext) => string[] = () => [],
	host?: DelegateHost,
): Results {
	pi.registerMessageRenderer(CUSTOM_TYPE, renderMessage);
	/** Every recorded delegation by its id, in the order recorded. */
	const byId = new Map<string, Recorded>();
	const tasks = new ChildTasks();
	const save = (): void => {
		try {
			tasks.save([...byId.values()]);
		} catch (error) {
			tasks.failed = true;
			ctx?.ui.notify(
				`delegate: could not persist child tasks: ${String(error)}; keep this session open, repair storage and run again. Completion is blocked.`,
				"error",
			);
			throw error;
		}
		try {
			if (ctx) publish(ctx, [...byId.values()]);
		} catch (error) {
			ctx?.ui.notify(
				`delegate: could not publish shared accounting: ${String(error)}. Local child facts are saved; the next admission reconciles them before checking caps.`,
				"warning",
			);
		}
	};
	let replay: ReturnType<typeof setImmediate> | undefined;
	/** Started records by their request's envelope id, for matching replies; attempts never match a reply. */
	const byRequest = new Map<string, StartedRecorded>();
	/** Reply envelope ids a result message has already been sent for. */
	const shown = new Set<string>();
	const checking = new Map<string, { controller: AbortController; ids: Set<string> }>();
	const checkFor = (id: string) => [...checking.values()].find((check) => check.ids.has(id));
	function stopChecks(): void {
		for (const check of checking.values()) check.controller.abort();
		checking.clear();
	}
	/** The latest session context, for the footer and the session directory. */
	let ctx: ExtensionContext | undefined;
	const presentation = new ResultsPresentation();

	/**
	 * A delegation still going: no result, no recorded close, and not resumed.
	 * A resumed one's process is gone (resuming proved it), so the poll must not
	 * report it closed without a result; a late reply to it is still delivered.
	 */
	const running = (): StartedRecorded[] => {
		const records = [...byId.values()];
		const resumed = new Set(records.flatMap((record) => (isStarted(record) ? (record.resumedFrom ?? []) : [])));
		return records.filter(
			(record): record is StartedRecorded =>
				isStarted(record) &&
				record.result === undefined &&
				record.closed !== true &&
				record.gone !== true &&
				!resumed.has(record.id),
		);
	};

	/** The started record for `id`, if it is one. */
	const startedById = (id: unknown): StartedRecorded | undefined => {
		const record = typeof id === "string" ? byId.get(id) : undefined;
		return record !== undefined && isStarted(record) ? record : undefined;
	};

	/** The footer counts the running delegations, and hides itself at zero. */
	function updateFooter(): void {
		presentation.update(ctx, running().length);
	}

	/** Rebuild the records from the session's entries, so a resume still recognises replies. */
	function restore(context: ExtensionContext): void {
		if (replay) clearImmediate(replay);
		stopChecks();
		ctx = context;
		byId.clear();
		byRequest.clear();
		shown.clear();
		for (const record of restoreRecords(context, tasks)) {
			byId.set(record.id, record);
			if (isStarted(record)) {
				byRequest.set(record.requestId, record);
				if (record.result) shown.add(record.result.replyId);
			}
		}
		if (tasks.storageProblem())
			context.ui.notify(
				`delegate: could not restore child tasks: ${tasks.storageProblem()}; task completion is blocked.`,
				"error",
			);
		syncCloses(false);
		updateFooter();
		// Mail is already claimed. Recover unfinished checks and unprocessed
		// outcomes without recreating any worker.
		if (!tasks.failed && (tasks.outcomes.length || tasks.checkReplies.size)) {
			const session = context.sessionManager.getSessionId();
			replay = setImmediate(() => {
				replay = undefined;
				if (!active() || ctx?.sessionManager.getSessionId() !== session) return;
				if (tasks.outcomes.length) {
					tasks.replay(pi, processesChildren());
					save();
				}
				for (const payload of tasks.checkReplies.values()) takeReply({ ...payload, handled: false });
			});
		}
	}

	function recordStart(delegation: Delegation, context: ExtensionContext): void {
		ctx = context;
		const record: StartedRecorded = locatedRecord(delegation);
		pi.appendEntry(START_TYPE, { ...record });
		byId.set(record.id, record);
		byRequest.set(record.requestId, record);
		save();
		updateFooter();
	}

	function recordAttempt(attempt: WorkspaceAttempt, context: ExtensionContext): void {
		ctx = context;
		pi.appendEntry(CUSTOM_TYPE, attempt);
		byId.set(attempt.id, { ...attempt });
		save();
	}

	function recordClose(id: string, wake = true): void {
		const record = startedById(id);
		if (record === undefined || record.closed === true) return;
		record.closed = true;
		const checking = checkFor(id);
		checking?.controller.abort();
		const settled = record.result !== undefined || record.gone === true || checking !== undefined;
		if (!settled) record.settledAt = Date.now(); // a close after a result or gone keeps the earlier time
		const at = record.settledAt;
		const outcome = settled ? undefined : closeOutcome(record, ctx, host);
		if (outcome) {
			tasks.outcomes.push(outcome);
			if (wake) tasks.paused = false;
		}
		save(); // Close and its processing obligation persist together, before transcript/display effects.
		pi.appendEntry(CUSTOM_TYPE, { id, closed: true, ...(at === undefined ? {} : { settledAt: at }) });
		if (outcome && wake) {
			pi.sendMessage(
				{ customType: CUSTOM_TYPE, content: outcome.content, details: outcome.details, display: true },
				{ triggerTurn: true, deliverAs: processesChildren() ? "steer" : "followUp" },
			);
			tasks.delivered(outcome.key);
			save();
		}
		updateFooter();
	}

	function syncCloses(wake = true): boolean {
		if (!ctx || !active() || tasks.failed) return false;
		try {
			for (const id of closedChildren(ctx)) recordClose(id, wake);
			return true;
		} catch (error) {
			ctx.ui.notify(
				`delegate: confirmed close import unavailable: ${String(error)}; pending children remain unresolved.`,
				"warning",
			);
			return false;
		}
	}

	function recordGone(id: string): boolean {
		const record = startedById(id);
		if (
			record === undefined ||
			record.result !== undefined ||
			record.closed === true ||
			record.gone === true ||
			checkFor(id) !== undefined
		)
			return false;
		const session = locateSession(record, ctx?.sessionManager.getSessionDir());
		const settledAt = Date.now();
		record.gone = true;
		record.settledAt = settledAt;
		const outcome = goneOutcome(record, session, host);
		tasks.paused = false; // A fresh outcome is new work, not replay of the stopped turn.
		tasks.outcomes.push(outcome);
		save(); // The obligation persists before the semantic fact and any transcript effect.
		pi.appendEntry(CUSTOM_TYPE, {
			id,
			gone: true,
			settledAt,
			...(session === undefined ? {} : { sessionPath: session }),
		});
		pi.sendMessage(
			{ customType: CUSTOM_TYPE, details: outcome.details, content: outcome.content, display: true },
			{ triggerTurn: true, deliverAs: processesChildren() ? "steer" : "followUp" },
		);
		tasks.delivered(outcome.key);
		save();
		updateFooter();
		return true;
	}

	function takeReply(payload: Inbound): void {
		if (payload?.handled === true) return;
		const reply = payload?.envelope;
		if (reply === undefined || !Array.isArray(reply.in_reply_to) || reply.in_reply_to.length === 0) return;
		// Only the delegate's own reply counts: `from` must be the delegation's session id.
		const matches = reply.in_reply_to
			.map((id) => byRequest.get(id))
			.filter((record): record is StartedRecorded => record !== undefined && sessionIdOf(record) === reply.from);
		if (matches.length === 0) return;
		payload.handled = true;
		// Transport retries have fresh envelope ids. Correlate on every task id,
		// not just the envelope, and never present an already answered task again.
		const pending = matches.filter((record) => record.result === undefined);
		if (shown.has(reply.id) || pending.length === 0 || pending.some((record) => checkFor(record.id))) return;
		const delegation = pending.at(-1) as StartedRecorded;
		shown.add(reply.id);
		const session = locateSession(delegation, ctx?.sessionManager.getSessionDir());
		const usage = sessionUsage(session);
		const evidence = delegation.routing ? routingEvidence(delegation.routing, session) : undefined;
		const finished = delegation.routing ? evidence?.served.at(-1)?.model : finishedModel(session);
		// After the claim above, so a slow or failing inspection cannot let the provider or a duplicate deliver it too.
		const snapshot = inspectWorkspace(delegation.workspace?.cwd, delegation.workspace?.git);
		const name = recordedName(delegation);
		const budget = resultBodyBudget((text) => ctx?.ui.notify(text, "error"));
		const details = resultDetails(delegation, name, payload, session, finished, snapshot, evidence, budget, usage);
		const result: Result = {
			...(usage === undefined ? {} : { usage }),
			...(evidence ? { routingEvidence: evidence } : {}),
			status: reply.status,
			replyId: reply.id,
			envelopePath: payload.path,
			...(session === undefined ? {} : { sessionPath: session }),
			...(finished === undefined ? {} : { finishedModel: finished }),
			workspaceSnapshot: snapshot,
		};
		const approved = delegation.check;
		const closingKnown = approved === undefined || syncCloses();
		// A check on a failed or stopped reply can pass on half-done work, so only
		// a done reply runs one; the others deliver as if nothing was approved.
		if (!approved || reply.status !== "done" || delegation.closed === true || delegation.gone === true) {
			finishReply(pending, result, details);
		} else if (!closingKnown) {
			const check: CheckResult = { status: "error", runs: [], error: "could not verify the delegation was still open" };
			finishReply(pending, { ...result, check }, { ...details, check });
		} else {
			tasks.checkReplies.set(reply.id, { ...payload, handled: false });
			save(); // The owner may remove its staged envelope as soon as this handler returns.
			checkReply(approved, pending, result, details);
		}
	}

	type ReplyDetails = Extract<ChildOutcome["details"], { kind: "result" }>;

	function checkReply(
		approved: ApprovedCheck,
		pending: StartedRecorded[],
		result: Result,
		details: ReplyDetails,
	): void {
		const id = result.replyId;
		const job = { controller: new AbortController(), ids: new Set(pending.map((record) => record.id)) };
		checking.set(id, job);
		void runChecks(approved, job.controller.signal)
			.catch((error: unknown): CheckResult => ({ status: "error", runs: [], error: String(error) }))
			.then((check) => {
				if (checking.get(id) !== job || !ctx || !active()) return;
				try {
					syncCloses();
					finishReply(pending, { ...result, check }, { ...details, check });
				} catch (error) {
					ctx.ui.notify(`delegate: checked result ${id} could not be delivered: ${String(error)}`, "error");
				} finally {
					checking.delete(id);
				}
			});
	}

	function finishReply(pending: StartedRecorded[], result: Result, details: ReplyDetails): void {
		const settledAt = Date.now();
		for (const record of pending) {
			record.result = result;
			record.settledAt = settledAt;
		}
		const content = resultText(details);
		const answered = new Set(pending.map((record) => record.id));
		tasks.outcomes = tasks.outcomes.filter(
			(outcome) => outcome.details.kind !== "gone" || !answered.has(outcome.details.id),
		);
		tasks.paused = false; // Only old replay is held by a root stop, not a new live result.
		tasks.checkReplies.delete(result.replyId);
		tasks.outcomes.push({ key: result.replyId, content, details });
		save(); // The obligation persists before the semantic fact and the steer.
		for (const record of pending) pi.appendEntry(CUSTOM_TYPE, { id: record.id, result, settledAt });
		// Persist first, then steer. A crash before injection is recovered from
		// the processing inbox, not from the provider's already-claimed mail.
		pi.sendMessage(
			{ customType: CUSTOM_TYPE, content, details, display: true },
			{ triggerTurn: true, deliverAs: "steer" },
		);
		tasks.delivered(result.replyId);
		save();
		updateFooter();
	}

	pi.on("context", () => {
		syncCloses();
	});
	pi.on("agent_before_settle", () => {
		syncCloses();
	});
	pi.on("agent_settled", () => {
		syncCloses();
	});
	tasks.register(
		pi,
		() => [...byId.values()],
		() => ctx,
		processesChildren,
	);

	pi.on("session_shutdown", () => {
		if (replay) clearImmediate(replay);
		replay = undefined;
		stopChecks();
		ctx = undefined;
	});
	pi.events.on(INBOUND, (data) => takeReply(data as Inbound));

	return {
		subscribe: presentation.subscribe,
		setCountVisible: presentation.setCountVisible,
		restore,
		recordStart,
		recordAttempt,
		recordClose,
		syncCloses,
		running,
		recordGone,
		list: () => [...byId.values()],
		find: (id) => byId.get(id),
		completionReady: () =>
			!tasks.failed && running().length === 0 && tasks.outcomes.length === 0 && tasks.checkReplies.size === 0,
		checkStorage: (write = false) => {
			const problem = tasks.storageProblem();
			if (problem) throw new Error(problem);
			if (write) save();
		},
	};
}
