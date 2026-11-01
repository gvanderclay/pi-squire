// The text and details of the one message the parent receives for a settled delegation.
import { readMarks } from "./limits.ts";
import { cwdLine, modelLabel, snapshotLines } from "./render.ts";
import { sessionIdOf } from "./result-sessions.ts";
import type { StartedRecorded } from "./result-types.ts";
import type { Inbound, MessageDetails, TaskQuote } from "./results.ts";
import type { WorkspaceSnapshot } from "./snapshot.ts";

/** A task quoted into the result header is cut at this many UTF-8 bytes. */
const TASK_CAP = 2 * 1024;
/** A result body is cut at this many UTF-8 bytes. */
const BODY_CAP = 32 * 1024;

type ResultDetails = Extract<MessageDetails, { kind: "result" }>;

/** Cut `text` to at most `max` UTF-8 bytes on a character boundary; undefined when it already fits. */
function cap(text: string, max: number): string | undefined {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= max) return undefined;
	let end = max;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--; // back off a split character
	return bytes.subarray(0, end).toString("utf8");
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
export function resumeDetails(record: StartedRecorded): { resumedFrom?: string; sessionId?: string } {
	return {
		...(record.resumedFrom === undefined ? {} : { resumedFrom: record.resumedFrom }),
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
	const limit = reply.status === "stopped" ? undefined : limitLine(sessionIdOf(delegation), reply.status);
	return {
		kind: "result",
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
		`[delegate] Result from ${details.agent} (${modelLabel(details.model, details.finishedModel)}), delegation ${details.id}${details.resumedFrom === undefined ? "" : ` (resumed from ${details.resumedFrom})`}, request ${details.requestId}.`,
		`Status: ${details.status}`,
		...(details.limit === undefined ? [] : [details.limit]),
		taskLine,
		`Working directory: ${cwdLine(details.cwd)}`,
		...(details.workspaceSnapshot === undefined ? [] : checkoutText(details.workspaceSnapshot)),
		`Envelope: ${details.envelopePath}`,
		`Delegate session: ${details.sessionPath ?? details.sessionId ?? details.id}`,
		"",
		details.body,
	].join("\n");
}
