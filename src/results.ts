// The delegation records and the result message. A delegation is recorded in
// the parent session when it starts, and again when it is closed; when the
// provider claims a reply that answers a recorded task, this listener takes
// the message over, shows the parent one delegate result and records the
// result. The records are the one source of truth for a delegation's state,
// for the footer, `delegation_status` and `delegation_close`.
import { readdirSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { readMarks } from "./limits.ts";

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
};

/** One delegation as it stands: what was recorded at its start, plus what came after. */
export type Recorded = Delegation & {
	/** Set when a result arrived. */
	result?: Result;
	/** Set when `delegation_close` recorded a close. */
	closed?: boolean;
	/** Set when the poll found the window gone with no result; a result outranks it. */
	gone?: boolean;
};

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
	/** Record a delegation and show it as running. */
	recordStart(delegation: Delegation, ctx: ExtensionContext): void;
	/** Record a close; does nothing when there is no such delegation or it is already closed. */
	recordClose(id: string): void;
	/** Delegations with no result, no recorded close and no gone-window record. */
	running(): Recorded[];
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
export type DelegationState = "closed" | "done" | "gone" | "running" | "window-closed" | "unknown";

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

/** The delegate's session file in `dir`, found by its `_<id>.jsonl` suffix. */
export function findSession(dir: string | undefined, id: string): string | undefined {
	if (dir === undefined) return undefined;
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return undefined;
	}
	const name = names.find((candidate) => candidate.endsWith(`_${id}.jsonl`));
	return name === undefined ? undefined : join(dir, name);
}

/** The line naming a usage-limit mark this delegation's failure recorded, if any. */
function limitLine(id: string): string | undefined {
	const now = Date.now();
	const mark = readMarks(now).find((item) => item.delegations.includes(id));
	if (mark === undefined) return undefined;
	const scope = mark.scope.includes("/") ? `model ${mark.scope}` : `provider ${mark.scope}`;
	const until = new Date(mark.clearsAt).toISOString();
	return `Usage limit: the delegate hit a usage limit on ${scope}; ${
		mark.clearsAt > now ? `it is marked until ${until} and later delegations skip it.` : `it was marked until ${until}.`
	}`;
}

/** The one message the parent sees for a settled delegation. */
function resultText(delegation: Delegation, payload: Inbound, session: string | undefined): string {
	const reply = payload.envelope;
	const copy = payload.requests.find((request) => request.envelope?.id === delegation.requestId);
	let quote: string;
	if (copy === undefined) {
		quote = `[delegate] The task ${delegation.requestId} has no copy in sent/; only its id is known.`;
	} else {
		const cut = cap(copy.envelope.body, TASK_CAP);
		const lines =
			cut === undefined ? copy.envelope.body : `${cut}\n[delegate] Task cut at 2 KiB; the full copy is ${copy.path}`;
		quote = `Task, quoted from ${copy.path}:\n${lines
			.split("\n")
			.map((line) => `> ${line}`)
			.join("\n")}`;
	}
	const cut = cap(reply.body, BODY_CAP);
	const result =
		cut === undefined ? reply.body : `${cut}\n[delegate] Body cut at 32 KiB; the full envelope is ${payload.path}`;
	const limit = reply.status === "failed" ? limitLine(delegation.id) : undefined;
	return [
		`[delegate] Result from ${delegation.agent} (${delegation.model}), delegation ${delegation.id}, request ${delegation.requestId}.`,
		`Status: ${reply.status}`,
		...(limit === undefined ? [] : [limit]),
		quote,
		`Envelope: ${payload.path}`,
		`Delegate session: ${session ?? delegation.id}`,
		"",
		result,
	].join("\n");
}

export function createResults(pi: ExtensionAPI): Results {
	/** Every recorded delegation by its id, in the order recorded. */
	const byId = new Map<string, Recorded>();
	/** The same records by their request's envelope id, for matching replies. */
	const byRequest = new Map<string, Recorded>();
	/** Reply envelope ids a result message has already been sent for. */
	const shown = new Set<string>();
	/** The latest session context, for the footer and the session directory. */
	let ctx: ExtensionContext | undefined;
	/** Whether the footer currently shows the entry, so a clear is sent only when needed. */
	let footerShown = false;

	/** A delegation still going: no result and no recorded close. */
	const running = (): Recorded[] =>
		[...byId.values()].filter(
			(record) => record.result === undefined && record.closed !== true && record.gone !== true,
		);

	/** The footer counts the running delegations, and hides itself at zero. */
	function updateFooter(): void {
		if (ctx?.hasUI !== true) return;
		const count = running().length;
		const visible = count > 0;
		if (!visible && !footerShown) return;
		footerShown = visible;
		ctx.ui.setStatus(STATUS_KEY, visible ? `⇄ ${count} running` : undefined);
	}

	/** Rebuild the records from the session's entries, so a resume still recognises replies. */
	function restore(context: ExtensionContext): void {
		ctx = context;
		byId.clear();
		byRequest.clear();
		shown.clear();
		for (const entry of context.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
			const data = entry.data as Partial<Delegation & { result: Result; closed: boolean; gone: boolean }> | undefined;
			if (data === undefined || typeof data.id !== "string") continue;
			if (typeof data.requestId === "string") {
				const record: Recorded = { ...(data as Delegation) };
				byId.set(record.id, record);
				byRequest.set(record.requestId, record);
			} else if (typeof data.result?.replyId === "string") {
				shown.add(data.result.replyId);
				const record = byId.get(data.id);
				if (record !== undefined) record.result = data.result;
			} else if (data.closed === true) {
				const record = byId.get(data.id);
				if (record !== undefined) record.closed = true;
			} else if (data.gone === true) {
				const record = byId.get(data.id);
				if (record !== undefined) record.gone = true;
			}
		}
		updateFooter();
	}

	function recordStart(delegation: Delegation, context: ExtensionContext): void {
		ctx = context;
		pi.appendEntry(CUSTOM_TYPE, delegation);
		const record: Recorded = { ...delegation };
		byId.set(record.id, record);
		byRequest.set(record.requestId, record);
		updateFooter();
	}

	function recordClose(id: string): void {
		const record = byId.get(id);
		if (record === undefined || record.closed === true) return;
		pi.appendEntry(CUSTOM_TYPE, { id, closed: true });
		record.closed = true;
		updateFooter();
	}

	function recordGone(id: string): boolean {
		const record = byId.get(id);
		if (record === undefined || record.result !== undefined || record.closed === true || record.gone === true)
			return false;
		const session = findSession(ctx?.sessionManager.getSessionDir(), record.id);
		pi.appendEntry(CUSTOM_TYPE, { id, gone: true });
		record.gone = true;
		pi.sendMessage(
			{
				customType: CUSTOM_TYPE,
				content: [
					`[delegate] Delegation ${record.id} (${record.agent}, ${record.model}), request ${record.requestId}, closed without a result: its window ${record.windowName} is gone and no reply arrived.`,
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
		const delegation = byRequest.get(requestId) as Recorded;
		shown.add(reply.id);
		const session = findSession(ctx?.sessionManager.getSessionDir(), delegation.id);
		pi.sendMessage(
			{ customType: CUSTOM_TYPE, content: resultText(delegation, payload, session), display: true },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		const result: Result = {
			status: reply.status,
			replyId: reply.id,
			envelopePath: payload.path,
			...(session === undefined ? {} : { sessionPath: session }),
		};
		pi.appendEntry(CUSTOM_TYPE, { id: delegation.id, result });
		delegation.result = result;
		updateFooter();
	}

	pi.events.on(INBOUND, (data) => takeReply(data as Inbound));

	return {
		restore,
		recordStart,
		recordClose,
		running,
		recordGone,
		list: () => [...byId.values()],
		find: (id) => byId.get(id),
	};
}
