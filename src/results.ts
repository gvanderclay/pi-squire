// The delegation records and the result message. A delegation is recorded in
// the parent session when it starts, and again when it is closed; when the
// provider claims a reply that answers a recorded task, this listener takes
// the message over, shows the parent one delegate result and records the
// result. Local records own result processing; the shared tree registry owns
// cross-process admission accounting.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { ChildTasks } from "./child-tasks.ts";
import type { Identity } from "./identity.ts";
import { cwdLine, modelLabel, renderMessage, workspaceLine } from "./render.ts";
import { resultDetails, resultText, resumeDetails } from "./result-message.ts";
import { restoreRecords } from "./result-restore.ts";
import { finishedModel, locateSession, sessionIdOf } from "./result-sessions.ts";
import {
	type AttemptState,
	isStarted,
	type Recorded,
	recordedName,
	type StartedRecorded,
	type WorkspaceAttempt,
} from "./result-types.ts";
import { inspectWorkspace, type WorkspaceSnapshot } from "./snapshot.ts";
import type { Workspace } from "./workspace.ts";

export { findSession, finishedModel, sessionHeaderCwd, sessionIdOf } from "./result-sessions.ts";
export type { AttemptState, Recorded, ResourceFacts, StartedRecorded, WorkspaceAttempt } from "./result-types.ts";
export { isStarted, locateSession };

/** The session entry type both delegation records and results use. */
export const CUSTOM_TYPE = "delegate";
/** The footer entry that counts delegations whose result has not arrived. */
export const STATUS_KEY = "delegate";
/** The `pi.events` channel a provider emits claimed envelopes on. */
const INBOUND = "message:inbound";

/** One delegation, as recorded and rebuilt on resume. It holds no task text. */
export type Delegation = {
	/** Read-only registry projection with no authoritative launch/result record. Never local tracking. */
	accountingOnly?: boolean;
	/** Durable launch identity; older single-level records may lack it. */
	identity?: Identity;
	id: string;
	agent: string;
	/** The agent's `display_name` at launch, shown instead of `agent`; absent when it had none. */
	displayName?: string;
	model: string;
	thinking: string;
	/** The delegate's session and window name; absent in records from before labels, where it was `<agent>-<8 id characters>`. */
	name?: string;
	windowId: string;
	windowName: string;
	requestId: string;
	/** Whether the delegate closes its own window after a normal completion; absent in records from before auto-exit. */
	autoExit?: boolean;
	/** The directory its window opened in; absent in records from before it was recorded, where it is unknown. */
	cwd?: string;
	/** The session-storage directory passed as `--session-dir`; absent in older records. */
	sessionDir?: string;
	/** The delegate's session file once found; never set at launch, when the file may not exist yet. */
	sessionPath?: string;
	/** How its directory was chosen and its Git checkout at launch; absent in older records. */
	workspace?: Workspace;
	/** The delegation this one resumed, when it reopened that delegation's session. */
	resumedFrom?: string;
	/** The Pi session id; absent means `id`. A resumed delegation holds the session id of the one it resumed. */
	sessionId?: string;
};

/**
 * An envelope on the `message:inbound` payload. `delegate` declares its own
 * copy of the provider's shape; the provider's README owns the contract.
 */
export type Envelope = {
	id: string;
	from: string;
	to: string;
	in_reply_to: string[];
	status: string;
	ts: string;
	body: string;
};

/** A reply's request copy from the parent's `sent/`. */
export type RequestCopy = { envelope: Envelope; path: string };

/** A result, appended to the session so it is shown once and survives a resume. */
export type Result = {
	/** The envelope's status: `done`, `failed` or `stopped`. */
	status: string;
	/** The reply envelope's id, so the same reply is never shown twice. */
	replyId: string;
	/** The reply envelope's path in the parent's `cur/`. */
	envelopePath: string;
	/** The delegate's session file, when it could be found. */
	sessionPath?: string;
	/** The `provider/model` of the delegate's last assistant message, when its session file holds one. */
	finishedModel?: string;
	/** The checkout as observed when the result arrived; absent in results from before it was kept. */
	workspaceSnapshot?: WorkspaceSnapshot;
};

/** What both delegate messages carry for their view, beside the text the model reads. */
type CommonDetails = {
	name: string;
	agent: string;
	/** The model the delegation was launched on. */
	model: string;
	finishedModel?: string;
	id: string;
	/** The delegation this one resumed. */
	resumedFrom?: string;
	/** The Pi session id when it is not `id`: a resumed delegation's. */
	sessionId?: string;
	requestId: string;
	sessionPath?: string;
	cwd?: string;
	sessionDir?: string;
	workspace?: Workspace;
};

/** The task as the result quotes it: its text and copy path, or why there is none. */
export type TaskQuote = { text: string; path: string } | { note: string };

/** The details of a delegate message; the renderer draws from these. */
export type MessageDetails =
	| (CommonDetails & {
			kind: "result";
			/** The envelope's status: `done`, `failed` or `stopped`. */
			status: string;
			envelopePath: string;
			limit?: string;
			task: TaskQuote;
			/** The reply body, capped. */
			body: string;
			/** The checkout when the result arrived, the same value as the recorded result's; absent in older messages. */
			workspaceSnapshot?: WorkspaceSnapshot;
	  })
	| (CommonDetails & { kind: "gone"; windowName: string });

/** The provider's payload on `message:inbound`. */
export type Inbound = {
	envelope: Envelope;
	path: string;
	requests: RequestCopy[];
	handled: boolean;
};

export type Results = {
	/** Rebuild the records from the session's custom entries, as on a resume. */
	restore(ctx: ExtensionContext): void;
	/** Record a delegation and show it as running; it supersedes an attempt with the same id. */
	recordStart(delegation: Delegation, ctx: ExtensionContext): void;
	/** Record a workspace attempt, or its next state; never counted as running. */
	recordAttempt(attempt: WorkspaceAttempt, ctx: ExtensionContext): void;
	/** Record a close; does nothing when there is no such delegation or it is already closed. */
	recordClose(id: string): void;
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

/** What tmux reported for a delegation's window: listed, not listed, or not askable. */
export type WindowState = "open" | "gone" | "unknown";

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
	/** The latest session context, for the footer and the session directory. */
	let ctx: ExtensionContext | undefined;
	/** Whether the footer currently shows the entry, so a clear is sent only when needed. */
	let footerShown = false;
	const icon = Math.random() < 0.5 ? "👨" : "👩";

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
		if (ctx?.hasUI !== true) return;
		const count = running().length;
		const visible = count > 0;
		if (!visible && !footerShown) return;
		footerShown = visible;
		ctx.ui.setStatus(STATUS_KEY, visible ? `${icon} ${count} delegate${count === 1 ? "" : "s"} running` : undefined);
	}

	/** Rebuild the records from the session's entries, so a resume still recognises replies. */
	function restore(context: ExtensionContext): void {
		if (replay) clearImmediate(replay);
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
		updateFooter();
		// Mail is already claimed; replay only outcomes not processed by a
		// settled coordinator run. No live worker is recreated.
		if (!tasks.failed && tasks.outcomes.length) {
			const session = context.sessionManager.getSessionId();
			replay = setImmediate(() => {
				replay = undefined;
				if (!active() || ctx?.sessionManager.getSessionId() !== session) return;
				tasks.replay(pi, processesChildren());
				save();
			});
		}
	}

	function recordStart(delegation: Delegation, context: ExtensionContext): void {
		ctx = context;
		pi.appendEntry(CUSTOM_TYPE, delegation);
		const record: StartedRecorded = { ...delegation };
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

	function recordClose(id: string): void {
		const record = startedById(id);
		if (record === undefined || record.closed === true) return;
		pi.appendEntry(CUSTOM_TYPE, { id, closed: true });
		record.closed = true;
		save();
		updateFooter();
	}

	function recordGone(id: string): boolean {
		const record = startedById(id);
		if (record === undefined || record.result !== undefined || record.closed === true || record.gone === true)
			return false;
		const session = locateSession(record, ctx?.sessionManager.getSessionDir());
		const finished = finishedModel(session);
		pi.appendEntry(CUSTOM_TYPE, { id, gone: true, ...(session === undefined ? {} : { sessionPath: session }) });
		record.gone = true;
		const details: MessageDetails = {
			kind: "gone",
			name: recordedName(record),
			agent: record.agent,
			model: record.model,
			...(finished === undefined ? {} : { finishedModel: finished }),
			id: record.id,
			...resumeDetails(record),
			requestId: record.requestId,
			...(session === undefined ? {} : { sessionPath: session }),
			...(record.cwd === undefined ? {} : { cwd: record.cwd }),
			...(record.sessionDir === undefined ? {} : { sessionDir: record.sessionDir }),
			...(record.workspace === undefined ? {} : { workspace: record.workspace }),
			windowName: record.windowName,
		};
		const content = [
			`[delegate] Delegation ${record.id}${record.resumedFrom === undefined ? "" : ` (resumed from ${record.resumedFrom})`} (${record.agent}, ${modelLabel(record.model, finished)}), request ${record.requestId}, closed without a result: its window ${record.windowName} is gone and no reply arrived.`,
			`Working directory: ${cwdLine(record.cwd)}`,
			...(record.workspace === undefined ? [] : [`Workspace: ${workspaceLine(record.workspace)}`]),
			`Delegate session: ${session ?? sessionIdOf(record)}`,
			"A reply that arrives later is still delivered. To continue the delegate's session in a new window, call delegation_resume with this delegation's id.",
		].join("\n");
		tasks.paused = false; // A fresh outcome is new work, not replay of the stopped turn.
		tasks.outcomes.push({ key: `gone:${record.id}`, content, details });
		save();
		pi.sendMessage(
			{ customType: CUSTOM_TYPE, details, content, display: true },
			{ triggerTurn: true, deliverAs: processesChildren() ? "steer" : "followUp" },
		);
		tasks.delivered(`gone:${record.id}`);
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
		if (shown.has(reply.id) || pending.length === 0) return;
		const delegation = pending.at(-1) as StartedRecorded;
		shown.add(reply.id);
		const session = locateSession(delegation, ctx?.sessionManager.getSessionDir());
		const finished = finishedModel(session);
		// After the claim above, so a slow or failing inspection cannot let the provider or a duplicate deliver it too.
		const snapshot = inspectWorkspace(delegation.workspace?.cwd, delegation.workspace?.git);
		const details = resultDetails(delegation, recordedName(delegation), payload, session, finished, snapshot);
		const result: Result = {
			status: reply.status,
			replyId: reply.id,
			envelopePath: payload.path,
			...(session === undefined ? {} : { sessionPath: session }),
			...(finished === undefined ? {} : { finishedModel: finished }),
			workspaceSnapshot: snapshot,
		};
		for (const record of pending) {
			pi.appendEntry(CUSTOM_TYPE, { id: record.id, result });
			record.result = result;
		}
		const content = resultText(details);
		tasks.paused = false; // Only old replay is held by a root stop, not a new live result.
		tasks.outcomes.push({ key: reply.id, content, details });
		save();
		// Persist first, then steer. A crash before injection is recovered from
		// the processing inbox, not from the provider's already-claimed mail.
		pi.sendMessage(
			{ customType: CUSTOM_TYPE, content, details, display: true },
			{ triggerTurn: true, deliverAs: "steer" },
		);
		tasks.delivered(reply.id);
		save();
		updateFooter();
	}

	tasks.register(
		pi,
		() => [...byId.values()],
		() => ctx,
		processesChildren,
	);

	pi.on("session_shutdown", () => {
		if (replay) clearImmediate(replay);
		replay = undefined;
		ctx = undefined;
	});
	pi.events.on(INBOUND, (data) => takeReply(data as Inbound));

	return {
		restore,
		recordStart,
		recordAttempt,
		recordClose,
		running,
		recordGone,
		list: () => [...byId.values()],
		find: (id) => byId.get(id),
		completionReady: () => !tasks.failed && running().length === 0 && tasks.outcomes.length === 0,
		checkStorage: (write = false) => {
			const problem = tasks.storageProblem();
			if (problem) throw new Error(problem);
			if (write) save();
		},
	};
}
