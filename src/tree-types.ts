import type { Identity } from "./identity.ts";
import type { Delegation } from "./results.ts";
import type { Workspace } from "./workspace.ts";

/** Shared structural/admission facts, never parent outcome-processing state. */
export type TreeEntry = {
	id: string;
	sessionId: string;
	identity: Identity;
	ownerPid: number;
	phase: "reserved" | "dispatched" | "started" | "not-started";
	requestId?: string;
	windowId?: string;
	windowName?: string;
	cwd?: string;
	sessionDir?: string;
	workspace?: Workspace;
	resumedFrom?: string;
	launch?: Delegation;
	finished?: boolean;
	gone?: boolean;
	closed?: boolean;
	/** Reserved for the explicit-close consumer; admission and dispatch fence it. */
	closing?: boolean;
};
export type TreeState = { version: 1; root: string; entries: TreeEntry[] };
export type Reservation = { root: string; id: string };
export type TreeIntent = Pick<TreeEntry, "id" | "sessionId" | "identity" | "resumedFrom" | "sessionDir">;
export type TreeCounts = { concurrent: number; lifetime: number };
