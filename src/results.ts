// The delegation records and the result message. A delegation is recorded in
// the parent session when it starts, and again when it is closed; when the
// provider claims a reply that answers a recorded task, this listener takes
// the message over, shows the parent one delegate result and records the
// result. The records are the one source of truth for a delegation's state,
// for the footer, `delegation_status` and `delegation_close`.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { readMarks } from "./limits.ts";
import { cwdLine, modelLabel, renderMessage, snapshotLines, workspaceLine } from "./render.ts";
import { finishedModel, locateSession } from "./result-sessions.ts";
import {
	type AttemptState,
	isStarted,
	type Recorded,
	type StartedRecorded,
	type WorkspaceAttempt,
} from "./result-types.ts";
import { inspectWorkspace, type WorkspaceSnapshot } from "./snapshot.ts";
import type { Workspace } from "./workspace.ts";

export { findSession, finishedModel } from "./result-sessions.ts";
export type { AttemptState, Recorded, ResourceFacts, StartedRecorded, WorkspaceAttempt } from "./result-types.ts";
export { isStarted, locateSession };

/** The session entry type both delegation records and results use. */
export const CUSTOM_TYPE = "delegate";
/** The footer entry that counts delegations whose result has not arrived. */
export const STATUS_KEY = "delegate";
/** A task quoted into the result header is cut at this many UTF-8 bytes. */
const TASK_CAP = 2 * 1024;
/** A result body is cut at this many UTF-8 bytes. */
const BODY_CAP = 32 * 1024;
/** The `pi.events` channel a provider emits claimed envelopes on. */
const INBOUND = "message:inbound";

/** One delegation, as recorded and rebuilt on resume. It holds no task text. */
export type Delegation = {
	id: string;
	agent: string;
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

type ResultDetails = Extract<MessageDetails, { kind: "result" }>;

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

/** How much of a delegation id a delegate's session name carries. */
const SHORT_ID = 8;

/**
 * A delegate's name, used for both its session and its window: its agent and
 * the label, or the first 8 characters of its id when there is no label.
 */
export function delegateName(agent: string, id: string, label?: string): string {
	return `${agent}-${label ?? id.slice(0, SHORT_ID)}`;
}

/** The recorded name, or the pre-label name for records from before labels. */
export function recordedName(record: Recorded): string {
	return record.name ?? delegateName(record.agent, record.id);
}

/** A delegation's state: a recorded close, then a result, then a gone record, then the window. */
export function deriveState(record: Recorded, window: WindowState): DelegationState {
	if (!isStarted(record)) return record.attempt.phase;
	if (record.closed === true) return "closed";
	if (record.result !== undefined) return "done";
	if (record.gone === true) return "gone";
	if (window === "open") return "running";
	if (window === "gone") return "window-closed";
	return "unknown";
}

/** Cut `text` to at most `max` UTF-8 bytes on a character boundary; undefined when it already fits. */
function cap(text: string, max: number): string | undefined {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= max) return undefined;
	let end = max;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--; // back off a split character
	return bytes.subarray(0, end).toString("utf8");
}

/** The line naming a usage-limit mark this delegation recorded, if any; a `done` delegation finished on a fallback. */
function limitLine(id: string, status: string): string | undefined {
	const now = Date.now();
	const mark = readMarks(now).find((item) => item.delegations.includes(id));
	if (mark === undefined) return undefined;
	const scope = mark.scope.includes("/") ? `model ${mark.scope}` : `provider ${mark.scope}`;
	const until = new Date(mark.clearsAt).toISOString();
	return `Usage limit: the delegate hit a usage limit on ${scope}; ${
		mark.clearsAt > now ? `it is marked until ${until} and later delegations skip it.` : `it was marked until ${until}.`
	}${status === "done" ? " It finished on a fallback model; its session names which." : ""}`;
}

/** The details of a settled delegation's result message. */
function resultDetails(
	delegation: StartedRecorded,
	payload: Inbound,
	session: string | undefined,
	finished: string | undefined,
	snapshot: WorkspaceSnapshot,
): ResultDetails {
	const reply = payload.envelope;
	const copy = payload.requests.find((request) => request.envelope?.id === delegation.requestId);
	let task: TaskQuote;
	if (copy === undefined) {
		task = { note: `[delegate] The task ${delegation.requestId} has no copy in sent/; only its id is known.` };
	} else {
		const cut = cap(copy.envelope.body, TASK_CAP);
		const text =
			cut === undefined ? copy.envelope.body : `${cut}\n[delegate] Task cut at 2 KiB; the full copy is ${copy.path}`;
		task = { text, path: copy.path };
	}
	const cut = cap(reply.body, BODY_CAP);
	const body =
		cut === undefined ? reply.body : `${cut}\n[delegate] Body cut at 32 KiB; the full envelope is ${payload.path}`;
	const limit = reply.status === "stopped" ? undefined : limitLine(delegation.id, reply.status);
	return {
		kind: "result",
		status: reply.status,
		name: recordedName(delegation),
		agent: delegation.agent,
		model: delegation.model,
		...(finished === undefined ? {} : { finishedModel: finished }),
		id: delegation.id,
		requestId: delegation.requestId,
		envelopePath: payload.path,
		...(session === undefined ? {} : { sessionPath: session }),
		...(delegation.cwd === undefined ? {} : { cwd: delegation.cwd }),
		...(delegation.sessionDir === undefined ? {} : { sessionDir: delegation.sessionDir }),
		...(delegation.workspace === undefined ? {} : { workspace: delegation.workspace }),
		...(limit === undefined ? {} : { limit }),
		task,
		body,
		workspaceSnapshot: snapshot,
	};
}

/** The snapshot lines of the result text: a heading line, then its path lists indented. */
function checkoutText(snapshot: WorkspaceSnapshot): string[] {
	const [first, ...rest] = snapshotLines(snapshot);
	return [`Checkout when the result arrived: ${first}`, ...rest.map((line) => `  ${line}`)];
}

/** The one message the parent model reads for a settled delegation. */
function resultText(details: ResultDetails): string {
	const { task } = details;
	const quote =
		"note" in task
			? task.note
			: `Task, quoted from ${task.path}:\n${task.text
					.split("\n")
					.map((line) => `> ${line}`)
					.join("\n")}`;
	return [
		`[delegate] Result from ${details.agent} (${modelLabel(details.model, details.finishedModel)}), delegation ${details.id}, request ${details.requestId}.`,
		`Status: ${details.status}`,
		...(details.limit === undefined ? [] : [details.limit]),
		quote,
		`Working directory: ${cwdLine(details.cwd)}`,
		...(details.workspace === undefined ? [] : [`Workspace: ${workspaceLine(details.workspace)}`]),
		...(details.workspaceSnapshot === undefined ? [] : checkoutText(details.workspaceSnapshot)),
		`Envelope: ${details.envelopePath}`,
		`Delegate session: ${details.sessionPath ?? details.id}`,
		"",
		details.body,
	].join("\n");
}

export function createResults(pi: ExtensionAPI): Results {
	pi.registerMessageRenderer(CUSTOM_TYPE, renderMessage);
	/** Every recorded delegation by its id, in the order recorded. */
	const byId = new Map<string, Recorded>();
	/** Started records by their request's envelope id, for matching replies; attempts never match a reply. */
	const byRequest = new Map<string, StartedRecorded>();
	/** Reply envelope ids a result message has already been sent for. */
	const shown = new Set<string>();
	/** The latest session context, for the footer and the session directory. */
	let ctx: ExtensionContext | undefined;
	/** Whether the footer currently shows the entry, so a clear is sent only when needed. */
	let footerShown = false;
	const icon = Math.random() < 0.5 ? "👨" : "👩";

	/** A delegation still going: no result and no recorded close. */
	const running = (): StartedRecorded[] =>
		[...byId.values()].filter(
			(record): record is StartedRecorded =>
				isStarted(record) && record.result === undefined && record.closed !== true && record.gone !== true,
		);

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
		ctx = context;
		byId.clear();
		byRequest.clear();
		shown.clear();
		for (const entry of context.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
			const data = entry.data as
				| Partial<Delegation & { kind: string; result: Result; closed: boolean; gone: boolean }>
				| undefined;
			if (data === undefined || typeof data.id !== "string") continue;
			// An attempt may carry a real request id; it is checked before the legacy start rule below.
			if (data.kind === "workspace-attempt") {
				const existing = byId.get(data.id);
				if (existing === undefined || !isStarted(existing)) {
					byId.set(data.id, { ...(data as unknown as WorkspaceAttempt) });
				}
			} else if (typeof data.requestId === "string") {
				const record: StartedRecorded = { ...(data as Delegation) };
				byId.set(record.id, record);
				byRequest.set(record.requestId, record);
			} else if (typeof data.result?.replyId === "string") {
				shown.add(data.result.replyId);
				const record = startedById(data.id);
				if (record !== undefined) record.result = data.result;
			} else if (data.closed === true) {
				const record = startedById(data.id);
				if (record !== undefined) record.closed = true;
			} else if (data.gone === true) {
				const record = startedById(data.id);
				if (record === undefined) continue;
				record.gone = true;
				if (typeof data.sessionPath === "string") record.sessionPath = data.sessionPath;
			}
		}
		// A parent that stopped mid-launch cannot say how far it got; nothing is cleaned up or relaunched.
		for (const record of byId.values()) {
			if (isStarted(record)) continue;
			const { phase, resources } = record.attempt;
			if (phase === "planned" || phase === "created") {
				record.attempt = {
					phase: "interrupted",
					resources,
					lastPhase: phase,
					reason: `the parent session ended while the launch was ${phase}; whether anything was created is unknown`,
				};
			}
		}
		updateFooter();
	}

	function recordStart(delegation: Delegation, context: ExtensionContext): void {
		ctx = context;
		pi.appendEntry(CUSTOM_TYPE, delegation);
		const record: StartedRecorded = { ...delegation };
		byId.set(record.id, record);
		byRequest.set(record.requestId, record);
		updateFooter();
	}

	function recordAttempt(attempt: WorkspaceAttempt, context: ExtensionContext): void {
		ctx = context;
		pi.appendEntry(CUSTOM_TYPE, attempt);
		byId.set(attempt.id, { ...attempt });
	}

	function recordClose(id: string): void {
		const record = startedById(id);
		if (record === undefined || record.closed === true) return;
		pi.appendEntry(CUSTOM_TYPE, { id, closed: true });
		record.closed = true;
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
			requestId: record.requestId,
			...(session === undefined ? {} : { sessionPath: session }),
			...(record.cwd === undefined ? {} : { cwd: record.cwd }),
			...(record.sessionDir === undefined ? {} : { sessionDir: record.sessionDir }),
			...(record.workspace === undefined ? {} : { workspace: record.workspace }),
			windowName: record.windowName,
		};
		pi.sendMessage(
			{
				customType: CUSTOM_TYPE,
				details,
				content: [
					`[delegate] Delegation ${record.id} (${record.agent}, ${modelLabel(record.model, finished)}), request ${record.requestId}, closed without a result: its window ${record.windowName} is gone and no reply arrived.`,
					`Working directory: ${cwdLine(record.cwd)}`,
					...(record.workspace === undefined ? [] : [`Workspace: ${workspaceLine(record.workspace)}`]),
					`Delegate session: ${session ?? record.id}`,
					"A reply that arrives later is still delivered.",
				].join("\n"),
				display: true,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		updateFooter();
		return true;
	}

	function takeReply(payload: Inbound): void {
		if (payload?.handled === true) return;
		const reply = payload?.envelope;
		if (reply === undefined || !Array.isArray(reply.in_reply_to) || reply.in_reply_to.length === 0) return;
		// Only the delegate's own reply counts: `from` must be the delegation's id.
		const requestId = reply.in_reply_to.find((id) => byRequest.get(id)?.id === reply.from);
		if (requestId === undefined) return;
		payload.handled = true;
		if (shown.has(reply.id)) return;
		const delegation = byRequest.get(requestId) as StartedRecorded;
		shown.add(reply.id);
		const session = locateSession(delegation, ctx?.sessionManager.getSessionDir());
		const finished = finishedModel(session);
		// After the claim above, so a slow or failing inspection cannot let the provider or a duplicate deliver it too.
		const snapshot = inspectWorkspace(delegation.workspace?.cwd, delegation.workspace?.git);
		const details = resultDetails(delegation, payload, session, finished, snapshot);
		// Steer, not follow-up: a busy parent gets the result before its next model call, not after it has answered.
		pi.sendMessage(
			{ customType: CUSTOM_TYPE, content: resultText(details), details, display: true },
			{ triggerTurn: true, deliverAs: "steer" },
		);
		const result: Result = {
			status: reply.status,
			replyId: reply.id,
			envelopePath: payload.path,
			...(session === undefined ? {} : { sessionPath: session }),
			...(finished === undefined ? {} : { finishedModel: finished }),
			workspaceSnapshot: snapshot,
		};
		pi.appendEntry(CUSTOM_TYPE, { id: delegation.id, result });
		delegation.result = result;
		updateFooter();
	}

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
	};
}
