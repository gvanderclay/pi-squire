// Explicit close only. Shared structural facts fence admission; each owner
// separately imports confirmed closes into its own semantic processing inbox.
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { TmuxClient, TmuxWindow } from "./tmux.ts";
import { below } from "./tree-fence.ts";
import { descendants, readTree, treeTransaction } from "./tree-registry.ts";
import type { TreeClose, TreeEntry, TreeState } from "./tree-types.ts";

const MemberSchema = Type.Object({
	id: Type.String(),
	sessionId: Type.String(),
	windowId: Type.Optional(Type.String()),
	windowName: Type.Optional(Type.String()),
	outcome: Type.Union(
		["killed", "absent", "already-closed", "not-started", "pending", "error"].map((s) => Type.Literal(s)),
	),
	closed: Type.Boolean(),
	killed: Type.Boolean(),
	error: Type.Optional(Type.String()),
});
export const CloseSchema = Type.Object({
	id: Type.String(),
	windowId: Type.Optional(Type.String()),
	windowName: Type.Optional(Type.String()),
	closed: Type.Boolean({ description: "True only when every member is confirmed closed or never dispatched." }),
	complete: Type.Boolean(),
	alreadyClosed: Type.Boolean(),
	killed: Type.Boolean(),
	members: Type.Array(MemberSchema),
	error: Type.Optional(Type.String()),
});
export type CloseMember = {
	id: string;
	sessionId: string;
	windowId?: string;
	windowName?: string;
	outcome: "killed" | "absent" | "already-closed" | "not-started" | "pending" | "error";
	closed: boolean;
	killed: boolean;
	error?: string;
};
export type CloseDetails = {
	id: string;
	windowId?: string;
	windowName?: string;
	closed: boolean;
	complete: boolean;
	alreadyClosed: boolean;
	killed: boolean;
	members: CloseMember[];
	error?: string;
};
export type CloseResult = { text: string; details: CloseDetails };

/** Atomic capture/fence; rootAll has no entry, so also fence root admission. */
export function beginTreeClose(root: string, actor: string, id?: string): TreeClose {
	return treeTransaction(root, (state) => {
		const target: string = closeTarget(state, actor, id);
		const existing: TreeClose | undefined = state.closes?.find((close) => close.target === target);
		if (existing) return existing;
		const ids: Set<string> = new Set(descendants(state, target).map((entry) => entry.id));
		const entries: TreeEntry[] = state.entries.filter((entry) => entry.sessionId === target || ids.has(entry.id));
		for (const entry of entries) {
			entry.closing = true;
			if (entry.phase === "reserved") entry.phase = "not-started";
		}
		const close: TreeClose = { id: randomUUID(), target, entries: entries.map((entry) => entry.id) };
		state.closes = [...(state.closes ?? []), close];
		return close;
	});
}
function closeTarget(state: TreeState, actor: string, id: string | undefined): string {
	if (id === undefined) {
		if (actor !== state.root) throw new Error("only the root may close all delegations");
		return state.root;
	}
	const entry: TreeEntry | undefined = state.entries.find((item) => item.id === id);
	if (!entry || entry.sessionId === actor || !below(state, entry.identity.parent, actor))
		throw new Error(`no delegation ${JSON.stringify(id)} in this session's descendant tree; close refused`);
	const successor: TreeEntry | undefined = state.entries.find(
		(item) => item.resumedFrom === id && item.phase !== "not-started",
	);
	if (successor)
		throw new Error(`delegation ${id} was resumed as ${successor.id}; close the newest delegation instead`);
	return entry.sessionId;
}
function member(entry: TreeEntry, outcome: CloseMember["outcome"], error?: string): CloseMember {
	return {
		id: entry.id,
		sessionId: entry.sessionId,
		...(entry.windowId ? { windowId: entry.windowId } : {}),
		...(entry.windowName ? { windowName: entry.windowName } : {}),
		outcome,
		closed: !["pending", "error"].includes(outcome),
		killed: outcome === "killed",
		...(error ? { error } : {}),
	};
}
function sameLocator(a: TreeEntry, b: TreeEntry): boolean {
	return a.windowId === b.windowId && a.windowName === b.windowName && !b.createPending;
}
/** Publish only positive window/no-start facts; never invent a task result. */
function confirm(root: string, close: TreeClose, previous: TreeEntry): boolean {
	return treeTransaction(root, (state) => {
		const entry: TreeEntry | undefined = state.entries.find((item) => item.id === previous.id);
		if (!entry || !sameLocator(previous, entry)) return false;
		if (!entry.closed && !state.closes?.some((item) => item.id === close.id)) return false;
		entry.closed = true;
		return true;
	});
}
function finishClose(root: string, token: string): boolean {
	return treeTransaction(root, (state) => {
		state.closes = (state.closes ?? []).filter((close) =>
			close.entries.some((id) => {
				const entry: TreeEntry | undefined = state.entries.find((item) => item.id === id);
				return !entry || (!entry.closed && entry.phase !== "not-started");
			}),
		);
		return !state.closes.some((close) => close.id === token);
	});
}
async function closeMember(
	root: string,
	close: TreeClose,
	entry: TreeEntry,
	tmux: TmuxClient,
	assertActive: () => void,
): Promise<CloseMember> {
	if (entry.phase === "not-started") return member(entry, "not-started");
	if (entry.closed) return member(entry, "already-closed");
	if (entry.createPending || entry.phase === "dispatched" || !entry.windowId || !entry.windowName)
		return member(
			entry,
			"pending",
			"create outcome/current window locator is unknown; reservation remains charged and fenced",
		);
	const windows: TmuxWindow[] = await tmux.listWindows();
	assertActive();
	const current: TreeEntry | undefined = readTree(root).entries.find((item) => item.id === entry.id);
	if (!current || !sameLocator(entry, current))
		return member(entry, "pending", "current window locator changed; retry close");
	if (current.closed) return member(current, "already-closed");
	const window: TmuxWindow | undefined = windows.find(
		(item) => item.id === entry.windowId && item.name === entry.windowName,
	);
	if (window) await tmux.kill(window.id);
	assertActive();
	try {
		if (!confirm(root, close, entry))
			return { ...member(entry, "pending", "window changed before close publication; retry close"), killed: !!window };
	} catch (error) {
		return {
			...member(
				entry,
				"error",
				`window was ${window ? "killed" : "already absent"}, but close publication failed: ${String(error)}`,
			),
			killed: !!window,
		};
	}
	return member(entry, window ? "killed" : "absent");
}

export type CloseOptions = {
	root: string;
	actor: string;
	id?: string;
	tmux: TmuxClient;
	assertActive(): void;
};
/** Narrow shared control entry point; no UI/mail/foreign semantic writes. */
export async function closeTree(options: CloseOptions): Promise<CloseResult> {
	const { root, actor, id, tmux, assertActive } = options;
	assertActive();
	const close: TreeClose = beginTreeClose(root, actor, id);
	const outcomes: Map<string, CloseMember> = new Map();
	for (let pass = 0; pass < 3; pass++) {
		const entries: TreeEntry[] = readTree(root)
			.entries.filter((entry) => close.entries.includes(entry.id))
			.sort((a, b) => b.identity.depth - a.identity.depth);
		for (const entry of entries) {
			if (outcomes.get(entry.id)?.closed) continue;
			assertActive();
			try {
				outcomes.set(entry.id, await closeMember(root, close, entry, tmux, assertActive));
			} catch (error) {
				outcomes.set(entry.id, member(entry, "error", `could not close window/publication: ${String(error)}`));
			}
		}
		if (![...outcomes.values()].some((item) => item.outcome === "pending")) break;
		if (pass < 2) await new Promise<void>((resolve) => setTimeout(resolve, 25));
		assertActive();
	}
	return closeResult(id ?? root, [...outcomes.values()], finishOperation(root, close.id, assertActive));
}
function finishOperation(root: string, token: string, assertActive: () => void): string | undefined {
	try {
		assertActive();
		if (!finishClose(root, token)) return "shared close still has unresolved members; scope remains fenced";
	} catch (error) {
		return String(error);
	}
	return undefined;
}
function closeResult(id: string, members: CloseMember[], error: string | undefined): CloseResult {
	const complete: boolean = !error && members.every((item) => item.closed);
	const target: CloseMember | undefined = members.find((item) => item.id === id);
	const details: CloseDetails = {
		id,
		...(target?.windowId ? { windowId: target.windowId } : {}),
		...(target?.windowName ? { windowName: target.windowName } : {}),
		closed: complete,
		complete,
		alreadyClosed: members.length > 0 && members.every((item) => item.outcome === "already-closed"),
		killed: members.some((item) => item.killed),
		members,
		...(error ? { error } : {}),
	};
	const lines: string[] = members.map(
		(item) =>
			`- ${item.id}: ${item.outcome}${item.windowId ? ` ${item.windowName} (${item.windowId})` : ""}${item.error ? ` — ${item.error}` : ""}`,
	);
	return {
		text: [
			`${complete ? "Closed" : "Partial close of"} delegation subtree ${id} (${members.length} members).`,
			...lines,
			...(error ? [`Close operation: ${error}`] : []),
			...(complete
				? []
				: ["Unresolved members remain fenced; retry this explicit close after positive window/create evidence."]),
		].join("\n"),
		details,
	};
}
