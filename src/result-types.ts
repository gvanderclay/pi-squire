import type { Delegation, DelegationState, WindowState } from "./results.ts";
import type { WorktreePlan } from "./worktree.ts";

/** One started delegation as it stands: what was recorded at its start, plus what came after. */
export type StartedRecorded = Delegation & { result?: import("./results.ts").Result; closed?: boolean; gone?: boolean };
/** What is known to exist for an attempt; facts, not authorization to remove anything. */
export type ResourceFacts =
	| { kind: "none" }
	| { kind: "branch"; branch: string; head: string }
	| { kind: "worktree"; cwd: string; branch: string; head: string }
	| { kind: "unknown"; reason: string; observedPaths: string[]; observedRefs: string[] };
/** Where a managed launch stands before, or instead of, a window. */
export type AttemptState =
	| { phase: "planned"; resources: ResourceFacts }
	| { phase: "created"; resources: ResourceFacts }
	| { phase: "rolled-back"; resources: { kind: "none" }; cause: string }
	| { phase: "retained"; resources: ResourceFacts; cause: string; recovery: string[] }
	| { phase: "interrupted"; resources: ResourceFacts; lastPhase: "planned" | "created"; reason: string };
/** A managed launch with no window; its request id exists only if mail returned one. */
export type WorkspaceAttempt = {
	kind: "workspace-attempt";
	id: string;
	parentId: string;
	agent: string;
	model: string;
	thinking: string;
	name?: string;
	sessionDir: string;
	plan: WorktreePlan;
	attempt: AttemptState;
	requestId?: string;
};
export type Recorded = StartedRecorded | WorkspaceAttempt;
export function isStarted(record: Recorded): record is StartedRecorded {
	return !("kind" in record && record.kind === "workspace-attempt");
}

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
	if (record.accountingOnly) return "unknown";
	if (record.closed === true) return "closed";
	if (record.result !== undefined) return "done";
	if (record.gone === true) return "gone";
	if (window === "open") return "running";
	if (window === "gone") return "window-closed";
	return "unknown";
}
