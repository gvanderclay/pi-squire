// Admission and explicit close share session ancestry, never tmux session names.
import type { TreeEntry, TreeIntent, TreeState } from "./tree-types.ts";

export function below(state: TreeState, session: string, ancestor: string): boolean {
	const seen: Set<string> = new Set();
	let current: string = session;
	while (!seen.has(current)) {
		if (current === ancestor) return true;
		seen.add(current);
		const entry: TreeEntry | undefined = state.entries.find((item) => item.sessionId === current);
		if (!entry) return false;
		current = entry.identity.parent;
	}
	throw new Error("invalid delegation ancestry; operation refused");
}

export function activeFence(state: TreeState, session: string): boolean {
	return (state.closes ?? []).some((close) => below(state, session, close.target));
}

export function fenced(state: TreeState, parent: string): boolean {
	if (activeFence(state, parent)) return true;
	return state.entries.some(
		(entry) =>
			entry.closing &&
			entry.phase !== "not-started" &&
			!state.entries.some((next) => next.resumedFrom === entry.id && next.phase !== "not-started") &&
			below(state, parent, entry.sessionId),
	);
}

/** The caller already passed 06 authority/owner checks; enforce the shared chain atomically too. */
export function checkResumeFence(state: TreeState, intent: TreeIntent): void {
	if (activeFence(state, intent.sessionId)) throw new Error("delegation subtree is closing; resume refused");
	if (!intent.resumedFrom) return;
	const previous: TreeEntry | undefined = state.entries.find((entry) => entry.id === intent.resumedFrom);
	// 06 has already authenticated a parent-local record. With no shared session
	//history there is no historical fence/chain to supersede; do not invent one.
	if (!previous && !state.entries.some((entry) => entry.sessionId === intent.sessionId)) return;
	const successor: TreeEntry | undefined = state.entries.find(
		(entry) => entry.resumedFrom === intent.resumedFrom && entry.phase !== "not-started",
	);
	if (successor?.phase === "reserved") throw new Error(`delegation ${intent.resumedFrom} is already being resumed`);
	if (
		!previous ||
		previous.sessionId !== intent.sessionId ||
		previous.identity.parent !== intent.identity.parent ||
		successor
	)
		throw new Error("obsolete or inconsistent shared resume chain; resume refused");
}
