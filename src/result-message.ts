// The text and details of the one message the parent receives for a settled delegation.
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readMarks } from "./limits.ts";
import { cwdLine, modelLabel } from "./render.ts";
import { checkLines } from "./result-check.ts";
import { sessionIdOf } from "./result-sessions.ts";
import type { StartedRecorded } from "./result-types.ts";
import type { Inbound, MessageDetails, TaskQuote } from "./results.ts";
import { servedSummary } from "./routing-provenance.ts";
import type { RoutingEvidence } from "./routing-types.ts";
import type { SessionUsage } from "./session-usage.ts";
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

/** Where the whole reply is, or that its path is unknown. */
function fullReply(envelopePath: string | undefined): string {
	return typeof envelopePath === "string" && envelopePath !== ""
		? `the full reply is ${envelopePath}`
		: "the full reply's path is unknown";
}

/**
 * The notice before a cut body. The head and tail can keep a verdict while
 * dropping the finding, condition or required step behind it, so the notice
 * says the preview is incomplete and names the whole reply. It precedes the
 * body, so a Markdown fence the reply opens cannot swallow it. The provider
 * writes the envelope as JSON with the whole reply in its `body` field
 * (`pi-session-mail`'s `readEnvelope`), so the notice can name that field.
 */
function incompleteNotice(omitted: number, envelopePath: string | undefined): string {
	const read =
		typeof envelopePath === "string" && envelopePath !== ""
			? `read the "body" field of the JSON envelope at ${envelopePath}`
			: "read the full reply, whose envelope path is unknown";
	return `[delegate] Incomplete reply: ${omitted} UTF-8 bytes omitted from the middle. Before acting on this report or treating it as complete, ${read}; findings, conditions, or required steps may be missing.`;
}

/**
 * The result body budget. A refused setting warns and uses the default: a
 * claimed reply must still be handled, and losing it is worse than a warning.
 */
export function resultBodyBudget(warn: (text: string) => void): number {
	try {
		return resultBodyBytes(getAgentDir());
	} catch (error) {
		warn(`delegate: ${String(error)}; this result keeps the default 32 KiB.`);
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
			: `${cut.head}\n[delegate] ${omittedKiB(cut.omitted)} KiB omitted here; ${fullReply(payload.path)}\n${cut.tail}`;
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
		...(cut === undefined ? {} : { bodyOmitted: cut.omitted }),
		workspaceSnapshot: snapshot,
	};
}

const displayReason = (reason: string): string => JSON.stringify(reason).slice(1, -1);

function checkoutSummary(snapshot: WorkspaceSnapshot): string {
	if (snapshot.kind === "non-git") return "not a Git checkout";
	if (snapshot.kind === "unknown") return `Git state unknown: ${displayReason(snapshot.reason)}`;
	const at = snapshot.position.detached ? "detached HEAD" : snapshot.position.branch;
	const parts = [at];
	if (snapshot.ahead > 0) parts.push(`+${snapshot.ahead} commit${snapshot.ahead === 1 ? "" : "s"}`);
	else if (snapshot.head !== snapshot.baseline) parts.push(`@ ${snapshot.head.slice(0, 7)}`);
	parts.push(snapshot.workingState);
	return parts.join(", ");
}

/** Shown only when the child ran outside the parent's cwd or left notable Git state (dirty, moved HEAD, or unknown). */
function cwdSummary(details: ResultDetails): string | undefined {
	const snapshot = details.workspaceSnapshot;
	const nonInherited = details.workspace !== undefined && details.workspace.mode !== "inherited";
	const notableGit =
		snapshot?.kind === "unknown" ||
		(snapshot?.kind === "git" &&
			(snapshot.workingState !== "clean" || snapshot.ahead > 0 || snapshot.head !== snapshot.baseline));
	if (!nonInherited && !notableGit) return undefined;
	const dir = cwdLine(details.cwd);
	return snapshot === undefined ? `cwd: ${dir}` : `cwd: ${dir} (${checkoutSummary(snapshot)})`;
}

/** Shown only when a routed attempt served another or multiple models; the single launched model is already in the header. */
function servedLine(launched: string, evidence: RoutingEvidence | undefined): string | undefined {
	const served = evidence?.served;
	if (!served?.length) return undefined;
	const distinctModels = new Set(served.map((item) => item.model));
	if (distinctModels.size === 1 && distinctModels.has(launched)) return undefined;
	return `Served: ${servedSummary(served)}.`;
}

/**
 * The independent-review line. Omitted when no review was requested and provenance
 * is clean; kept with reasons when provenance had warnings, and kept with its
 * caller caveat whenever an independent review was requested.
 */
function reviewLine(evidence: RoutingEvidence | undefined): string | undefined {
	const verdict = evidence?.independent ?? "unverified";
	const reasons = evidence?.reasons.length ? ` (${evidence.reasons.join("; ")})` : "";
	if (verdict === "not-required") return reasons ? `Independent review: ${verdict}${reasons}.` : undefined;
	return `Independent review: ${verdict}${reasons}. Caller must identify all author sources and keep the candidate stable; this verifies family disjointness relative to supplied active-branch histories, not exhaustive artifact attribution, error independence, review quality or isolation.`;
}

/** The one message the parent model reads for a settled delegation. */
export function resultText(details: ResultDetails): string {
	const { task } = details;
	const modelPart =
		details.finishedModel !== undefined && details.finishedModel !== details.model
			? ` (${modelLabel(details.model, details.finishedModel)})`
			: "";
	const resumed = details.resumedFrom === undefined ? "" : ` (resumed from ${details.resumedFrom})`;
	const forked = details.forkedFrom === undefined ? "" : ` (forked from ${details.forkedFrom})`;
	const origin = `${resumed}${forked}`;
	const served = details.routing ? servedLine(details.model, details.routingEvidence) : undefined;
	const review = details.routing ? reviewLine(details.routingEvidence) : undefined;
	const cwd = cwdSummary(details);
	return [
		`[delegate] ${details.agent} ${details.id}${modelPart}${origin} · ${details.status}`,
		...(details.limit === undefined ? [] : [details.limit]),
		...(served === undefined ? [] : [served]),
		...(review === undefined ? [] : [review]),
		...("note" in task ? [task.note] : []),
		...(cwd === undefined ? [] : [cwd]),
		...(details.check === undefined ? [] : ["", ...checkLines(details.check)]),
		"",
		...(details.bodyOmitted === undefined ? [] : [incompleteNotice(details.bodyOmitted, details.envelopePath)]),
		details.body,
	].join("\n");
}
