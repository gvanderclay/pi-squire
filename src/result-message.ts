// The text and details of the one message the parent receives for a settled delegation.
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readMarks } from "./limits.ts";
import { cwdLine, modelLabel, snapshotLines } from "./render.ts";
import { sessionIdOf } from "./result-sessions.ts";
import type { StartedRecorded } from "./result-types.ts";
import type { Inbound, MessageDetails, TaskQuote } from "./results.ts";
import { servedSummary } from "./routing-provenance.ts";
import type { RoutingEvidence } from "./routing-types.ts";
import { type SessionUsage, usageText } from "./session-usage.ts";
import { DEFAULT_RESULT_BODY_BYTES, resultBodyBytes } from "./settings.ts";
import type { WorkspaceSnapshot } from "./snapshot.ts";

/** A task quoted into the result header is cut at this many UTF-8 bytes. */
const TASK_CAP = 2 * 1024;
/** The head is this fraction of a result body's budget; the tail keeps the rest. */
const HEAD_SHARE = 4;

type ResultDetails = Extract<MessageDetails, { kind: "result" }>;

/** The offset of the first whole character at or before `end` in `bytes`. */
function headEnd(bytes: Buffer, end: number): number {
	let at = Math.min(end, bytes.length);
	while (at > 0 && (bytes[at] & 0xc0) === 0x80) at--; // back off a split character
	return at;
}

/** The offset of the first whole character at or after `start` in `bytes`. */
function tailStart(bytes: Buffer, start: number): number {
	let at = Math.max(start, 0);
	while (at < bytes.length && (bytes[at] & 0xc0) === 0x80) at++; // step over a split character
	return at;
}

/** Cut `text` to at most `max` UTF-8 bytes on a character boundary; undefined when it already fits. */
function cap(text: string, max: number): string | undefined {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= max) return undefined;
	return bytes.subarray(0, headEnd(bytes, max)).toString("utf8");
}

/** A body cut to a head and a tail around what it dropped; undefined when it already fits. */
function headTail(text: string, max: number): { head: string; tail: string; omitted: number } | undefined {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= max) return undefined;
	const headMax = Math.floor(max / HEAD_SHARE);
	const end = headEnd(bytes, headMax);
	const start = tailStart(bytes, bytes.length - (max - headMax));
	return {
		head: bytes.subarray(0, end).toString("utf8"),
		tail: bytes.subarray(start).toString("utf8"),
		omitted: start - end,
	};
}

/** How many KiB a cut dropped, rounded up so a small omission never reads as none. */
function omittedKiB(bytes: number): number {
	return Math.ceil(bytes / 1024);
}

/**
 * The result body budget. A refused setting warns and uses the default: a
 * claimed reply must still be handled, and losing it is worse than a warning.
 */
export function resultBodyBudget(warn: (text: string) => void): number {
	try {
		return resultBodyBytes(getAgentDir());
	} catch (error) {
		warn(`delegate: ${String(error)}; this result keeps the default 16 KiB.`);
		return DEFAULT_RESULT_BODY_BYTES;
	}
}

/** The line naming a usage-limit mark this delegation recorded, if any; a `done` delegation finished on a fallback. */
function limitLine(sessionId: string, status: string): string | undefined {
	const now = Date.now();
	const mark = readMarks(now).find((item) => item.delegations.includes(sessionId));
	if (mark === undefined) return undefined;
	const scope = mark.scope.includes("/") ? `model ${mark.scope}` : `provider ${mark.scope}`;
	const until = new Date(mark.clearsAt).toISOString();
	return `Usage limit: the delegate hit a usage limit on ${scope}; ${
		mark.clearsAt > now ? `it is marked until ${until} and later delegations skip it.` : `it was marked until ${until}.`
	}${status === "done" ? " It finished on a fallback model; its session names which." : ""}`;
}

/** The details that say a delegation reopened an earlier one's session. */
export function resumeDetails(record: StartedRecorded): {
	resumedFrom?: string;
	forkedFrom?: string;
	sessionId?: string;
} {
	return {
		...(record.resumedFrom === undefined ? {} : { resumedFrom: record.resumedFrom }),
		...(record.forkedFrom === undefined ? {} : { forkedFrom: record.forkedFrom }),
		...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
	};
}

/** The details of a settled delegation's result message. */
export function resultDetails(
	delegation: StartedRecorded,
	name: string,
	payload: Inbound,
	session: string | undefined,
	finished: string | undefined,
	snapshot: WorkspaceSnapshot,
	evidence?: RoutingEvidence,
	bodyBytes: number = resultBodyBytes(getAgentDir()),
	usage?: SessionUsage,
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
	const cut = headTail(reply.body, bodyBytes);
	const body =
		cut === undefined
			? reply.body
			: `${cut.head}\n[delegate] ${omittedKiB(cut.omitted)} KiB omitted here; the full reply is ${payload.path}\n${cut.tail}`;
	const limit = reply.status === "stopped" ? undefined : limitLine(sessionIdOf(delegation), reply.status);
	return {
		kind: "result",
		...(usage === undefined ? {} : { usage }),
		...(delegation.routing ? { routing: delegation.routing, routingEvidence: evidence } : {}),
		status: reply.status,
		name,
		agent: delegation.agent,
		model: delegation.model,
		...(finished === undefined ? {} : { finishedModel: finished }),
		id: delegation.id,
		...resumeDetails(delegation),
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

function checkoutText(snapshot: WorkspaceSnapshot): string[] {
	const [first] = snapshotLines(snapshot);
	return [`Checkout when the result arrived: ${first}`];
}

/** The one message the parent model reads for a settled delegation. */
export function resultText(details: ResultDetails): string {
	const { task } = details;
	const taskLine = "note" in task ? task.note : `Task: ${task.path}`;
	return [
		`[delegate] Result from ${details.agent} (${modelLabel(details.model, details.finishedModel)}), delegation ${details.id}${details.resumedFrom === undefined ? "" : ` (resumed from ${details.resumedFrom})`}${details.forkedFrom === undefined ? "" : ` (forked from ${details.forkedFrom})`}, request ${details.requestId}.`,
		`Status: ${details.status}`,
		...(details.routing
			? [
					`Routing: ${details.routing.profile}/${details.routing.request.category}, policy v${details.routing.policyVersion} ${details.routing.policyDigest}; ${details.routing.reason}.`,
					`Actual served models/efforts: ${servedSummary(details.routingEvidence?.served)}.`,
					`Independent review: ${details.routingEvidence?.independent ?? "unverified"}${details.routingEvidence?.reasons.length ? ` (${details.routingEvidence.reasons.join("; ")})` : ""}. Caller must identify all author sources and keep the candidate stable; this verifies family disjointness relative to supplied active-branch histories, not exhaustive artifact attribution, error independence, review quality or isolation.`,
				]
			: []),
		...(details.limit === undefined ? [] : [details.limit]),
		...(details.usage === undefined
			? []
			: [`Usage: ${usageText(details.usage, (details.resumedFrom ?? details.forkedFrom) !== undefined)}`]),
		taskLine,
		`Working directory: ${cwdLine(details.cwd)}`,
		...(details.workspaceSnapshot === undefined ? [] : checkoutText(details.workspaceSnapshot)),
		`Envelope: ${details.envelopePath}`,
		`Delegate session: ${details.sessionPath ?? details.sessionId ?? details.id}`,
		"",
		details.body,
	].join("\n");
}
