import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChildOutcome } from "./child-tasks.ts";
import { cwdLine, modelLabel, workspaceLine } from "./render.ts";
import { resumeDetails } from "./result-message.ts";
import { finishedModel, locateSession, sessionIdOf } from "./result-sessions.ts";
import { recordedName, type StartedRecorded } from "./result-types.ts";
import type { MessageDetails } from "./results.ts";

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
		windowName: record.windowName,
		...(finished ? { finishedModel: finished } : {}),
		...(session ? { sessionPath: session } : {}),
		cwd: record.cwd,
		sessionDir: record.sessionDir,
		workspace: record.workspace,
	};
	const content: string = [
		`[delegate] Delegation ${record.id} (${record.agent}, ${modelLabel(record.model, finished)}), request ${record.requestId}, canceled by explicit close without a result. This is missing work, not successful completion.`,
		`Working directory: ${cwdLine(record.cwd)}`,
		...(record.workspace ? [`Workspace: ${workspaceLine(record.workspace)}`] : []),
		`Delegate session: ${session ?? sessionIdOf(record)}`,
		"A genuine reply that arrives later is still delivered. Only the direct parent may resume this session as a new delegation.",
	].join("\n");
	return { key: `closed:${record.id}`, content, details };
}
