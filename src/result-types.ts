import type { Delegation } from "./results.ts";
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
