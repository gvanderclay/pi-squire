import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChildOutcome } from "./child-tasks.ts";
import { cwdLine, modelLabel, workspaceLine } from "./render.ts";
import { resumeDetails } from "./result-message.ts";
import { finishedModel, locateSession, sessionIdOf } from "./result-sessions.ts";
import { recordedName, type StartedRecorded } from "./result-types.ts";
import type { MessageDetails } from "./results.ts";
import { sessionUsage, usageText } from "./session-usage.ts";
import { windowPresentation } from "./tmux.ts";

/**
 * The usage line for a delegation that ended without a result: its session file
 * is the only record of what it spent, so it is read now. A missing or
 * unreadable file means no line, never an error.
 */
function usageLine(record: StartedRecorded, session: string | undefined): string[] {
	const usage = sessionUsage(session);
	if (usage === undefined) return [];
	return [`Usage: ${usageText(usage, (record.resumedFrom ?? record.forkedFrom) !== undefined)}`];
}

/** A missing/canceled task, never a fabricated result envelope. */
export function closeOutcome(record: StartedRecorded, ctx: ExtensionContext | undefined): ChildOutcome {
	const session: string | undefined = locateSession(record, ctx?.sessionManager.getSessionDir());
	const finished: string | undefined = finishedModel(session);
	const details: MessageDetails = {
		kind: "gone",
		reason: "explicit-close",
		name: recordedName(record),
		agent: record.agent,
		model: record.model,
		id: record.id,
		...resumeDetails(record),
		requestId: record.requestId,
		windowName: windowPresentation(record).windowName,
		...(finished ? { finishedModel: finished } : {}),
		...(session ? { sessionPath: session } : {}),
		cwd: record.cwd,
		sessionDir: record.sessionDir,
		workspace: record.workspace,
	};
	const content: string = [
		`[delegate] Delegation ${record.id} (${record.agent}, ${modelLabel(record.model, finished)}), request ${record.requestId}, canceled by explicit close without a result. This is missing work, not successful completion.`,
		...usageLine(record, session),
		`Working directory: ${cwdLine(record.cwd)}`,
		...(record.workspace ? [`Workspace: ${workspaceLine(record.workspace)}`] : []),
		`Delegate session: ${session ?? sessionIdOf(record)}`,
		"A genuine reply that arrives later is still delivered. Only the direct parent may resume this session as a new delegation.",
	].join("\n");
	return { key: `closed:${record.id}`, content, details };
}

/** A delegation whose window went away with no result, worded for the direct parent's processing inbox. */
export function goneOutcome(record: StartedRecorded, session: string | undefined): ChildOutcome {
	const finished: string | undefined = finishedModel(session);
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
		windowName: windowPresentation(record).windowName,
	};
	const content: string = [
		`[delegate] Delegation ${record.id}${record.resumedFrom === undefined ? "" : ` (resumed from ${record.resumedFrom})`}${record.forkedFrom === undefined ? "" : ` (forked from ${record.forkedFrom})`} (${record.agent}, ${modelLabel(record.model, finished)}), request ${record.requestId}, closed without a result: its window ${windowPresentation(record).windowName} is gone and no reply arrived.`,
		...usageLine(record, session),
		`Working directory: ${cwdLine(record.cwd)}`,
		...(record.workspace === undefined ? [] : [`Workspace: ${workspaceLine(record.workspace)}`]),
		`Delegate session: ${session ?? sessionIdOf(record)}`,
		"A reply that arrives later is still delivered. To continue the delegate's session in a new window, call delegation_resume with this delegation's id.",
	].join("\n");
	return { key: `gone:${record.id}`, content, details };
}
