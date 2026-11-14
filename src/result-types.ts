import type { Delegation, DelegationState, WindowState } from "./results.ts";
import type { WorkspaceSnapshot } from "./snapshot.ts";
import { validWindowLocator } from "./tmux.ts";
import type { Workspace } from "./workspace.ts";
import type { WorktreePlan } from "./worktree.ts";

/** What both delegate messages carry for their view, beside the text the model reads. */
type CommonDetails = {
	name: string;
	agent: string;
	/** The model the delegation was launched on. */
	model: string;
	finishedModel?: string;
	routing?: import("./routing-types.ts").RoutingRecord;
	routingEvidence?: import("./routing-types.ts").RoutingEvidence;
	id: string;
	/** The delegation this one resumed. */
	resumedFrom?: string;
	forkedFrom?: string;
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
	| (CommonDetails & { kind: "gone"; windowName: string; reason?: "explicit-close" });

/** Internal opaque-start journal namespace; released transcript readers ignore it. */
export const START_TYPE = "delegate-start-v2";
/** Minimum v2 start shape; ownership is separately validated at restore/action time. */
export function isV2Start(value: unknown): value is StartedRecorded {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<StartedRecorded> & { kind?: unknown };
	return (
		[record.id, record.agent, record.model, record.thinking, record.requestId].every(
			(field) => typeof field === "string",
		) &&
		record.kind !== "workspace-attempt" &&
		validWindowLocator(record.locator)
	);
}

/** One started delegation as it stands: what was recorded at its start, plus what came after. */
export type StartedRecorded = Delegation & {
	result?: import("./results.ts").Result;
	closed?: boolean;
	gone?: boolean;
	/** When the latest result, close or disappearance was recorded (epoch ms); absent in older sessions. */
	settledAt?: number;
};

export function validateSettledAt(record: { settledAt?: unknown }): void {
	if (
		record.settledAt !== undefined &&
		(typeof record.settledAt !== "number" || !Number.isFinite(record.settledAt) || record.settledAt < 0)
	)
		throw new Error("invalid delegation settledAt; restoration blocked");
}
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
	if (window === "running") return "running";
	if (window === "gone") return "window-closed";
	return "unknown";
}
