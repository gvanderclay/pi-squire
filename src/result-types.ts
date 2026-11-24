import type { ApprovedCheck } from "./delegate-check.ts";
import type { OpenProgress } from "./host.ts";
import type { Identity } from "./identity.ts";
import type { CheckResult } from "./result-check.ts";
import type { DelegationState, WindowState } from "./results.ts";
import type { SessionUsage } from "./session-usage.ts";
import type { WorkspaceSnapshot } from "./snapshot.ts";
import { validWindowLocator, type WindowRecord } from "./tmux.ts";
import type { Workspace } from "./workspace.ts";
import type { WorktreePlan } from "./worktree.ts";

/** One delegation, as recorded and rebuilt on resume. It holds no task text. */
export type Delegation = WindowRecord & {
	/** Read-only registry projection with no authoritative launch/result record. Never local tracking. */
	accountingOnly?: boolean;
	/** Durable launch identity; older single-level records may lack it. */
	identity?: Identity;
	id: string;
	agent: string;
	/** The agent's `display_name` at launch, shown instead of `agent`; absent when it had none. */
	displayName?: string;
	model: string;
	thinking: string;
	/** Presence survives a missing routing payload, so restoration cannot downgrade a routed attempt to legacy. */
	routingVersion?: 1;
	routing?: import("./routing-types.ts").RoutingRecord;
	/** The delegate's session and window name; absent in records from before labels, where it was `<agent>-<8 id characters>`. */
	name?: string;
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
	check?: ApprovedCheck;
	/** The delegation this one resumed, when it reopened that delegation's session. */
	resumedFrom?: string;
	/** The delegation whose context this new session copied. */
	forkedFrom?: string;
	/** The Pi session id; absent means `id`. A resumed delegation holds the session id of the one it resumed. */
	sessionId?: string;
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
	usage?: SessionUsage;
	check?: CheckResult;
	routingEvidence?: import("./routing-types.ts").RoutingEvidence;
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

/** The provider's payload on `message:inbound`. */
export type Inbound = {
	envelope: Envelope;
	path: string;
	requests: RequestCopy[];
	handled: boolean;
};

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
			usage?: SessionUsage;
			check?: CheckResult;
			/** The envelope's status: `done`, `failed` or `stopped`. */
			status: string;
			envelopePath: string;
			limit?: string;
			task: TaskQuote;
			/** The reply body, capped. */
			body: string;
			/** How many UTF-8 bytes the cap dropped from the middle; absent when the reply fits. */
			bodyOmitted?: number;
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
	result?: Result;
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
/** A managed launch without a published start; progress does not prove an agent is live. */
export type WorkspaceAttempt = OpenProgress & {
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
