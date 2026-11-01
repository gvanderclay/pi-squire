// One registry per root owns structural/admission accounting. Parent-local
// child facts and frozen worker replies remain semantic authorities. No bodies,
// mailboxes, processing inboxes, or ancestor-liveness policy live here.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readChildRecords } from "./child-tasks.ts";
import type { Identity } from "./identity.ts";
import { readState, writeState } from "./local-state.ts";
import { sessionIdOf } from "./result-sessions.ts";
import { isStarted, type Recorded } from "./result-types.ts";
import { sessionIsOwned } from "./session-owner.ts";
import { readTaskState, taskStatePath } from "./task-store.ts";
import type { TmuxClient, TmuxWindow } from "./tmux.ts";
import { checkResumeFence, fenced } from "./tree-fence.ts";
import { processAlive, withTreeLock } from "./tree-lock.ts";
import { treeCaps } from "./tree-settings.ts";
import type { Reservation, TreeCounts, TreeEntry, TreeIntent, TreeState } from "./tree-types.ts";
import { assertRootPlacement } from "./window-placement.ts";
import { listWindows } from "./windows.ts";

export type { Reservation, TreeCounts, TreeEntry, TreeIntent, TreeState } from "./tree-types.ts";

export function treePath(root: string): string {
	return join(getAgentDir(), "squire", "trees", `${encodeURIComponent(root)}.json`);
}
/** Discovery only; callers choose notice/view scope, never adopt another root. */
export function listTreeRoots(): string[] {
	try {
		return readdirSync(join(getAgentDir(), "squire", "trees"))
			.filter((name) => name.endsWith(".json"))
			.map((name) => decodeURIComponent(name.slice(0, -5)));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}
function load(root: string): TreeState {
	const saved: TreeState | undefined = readState<TreeState>(treePath(root));
	const state: TreeState = saved === undefined ? { version: 1, root, entries: [] } : saved;
	if (state?.version !== 1 || state.root !== root || !Array.isArray(state.entries))
		throw new Error(`invalid tree registry for ${root}; admission blocked`);
	const ids: Set<string> = new Set();
	for (const entry of state.entries) {
		if (
			!entry ||
			typeof entry.id !== "string" ||
			ids.has(entry.id) ||
			typeof entry.sessionId !== "string" ||
			entry.identity?.root !== root ||
			typeof entry.identity.parent !== "string" ||
			!Number.isSafeInteger(entry.ownerPid) ||
			entry.ownerPid < 1 ||
			!["reserved", "dispatched", "started", "not-started"].includes(entry.phase)
		)
			throw new Error(`invalid entry in tree registry for ${root}; admission blocked`);
		validateFields(entry);
		ids.add(entry.id);
	}
	validateCloses(state, ids);
	return state;
}

function validateCloses(state: TreeState, ids: Set<string>): void {
	if (state.closes === undefined) return;
	if (!Array.isArray(state.closes)) throw new Error("invalid close fences; admission blocked");
	const tokens: Set<string> = new Set();
	for (const close of state.closes) {
		if (
			!close ||
			typeof close.id !== "string" ||
			!close.id ||
			tokens.has(close.id) ||
			typeof close.target !== "string" ||
			(close.target !== state.root && !state.entries.some((entry) => entry.sessionId === close.target)) ||
			!Array.isArray(close.entries) ||
			!close.entries.every((id) => typeof id === "string" && ids.has(id)) ||
			new Set(close.entries).size !== close.entries.length
		)
			throw new Error(`invalid close fence for ${state.root}; admission blocked`);
		tokens.add(close.id);
	}
}

function validateFields(entry: TreeEntry): void {
	const own = entry.identity;
	assertRootPlacement(own.rootPlacement);
	if (
		!Number.isSafeInteger(own.depth) ||
		own.depth < 1 ||
		typeof own.agent !== "string" ||
		!Array.isArray(own.chain) ||
		!own.chain.every((name) => typeof name === "string") ||
		typeof own.autoExit !== "boolean"
	)
		throw new Error(`invalid identity in tree entry ${entry.id}`);
	for (const key of ["finished", "gone", "closed", "closing", "createPending"] as const)
		if (entry[key] !== undefined && typeof entry[key] !== "boolean")
			throw new Error(`invalid ${key} in tree entry ${entry.id}`);
	for (const key of ["requestId", "windowId", "windowName", "cwd", "sessionDir", "resumedFrom"] as const)
		if (entry[key] !== undefined && typeof entry[key] !== "string")
			throw new Error(`invalid ${key} in tree entry ${entry.id}`);
}
/** Shared close/launch boundary. Callback is synchronous; never await tmux/UI. */
export function treeTransaction<T>(root: string, work: (state: TreeState) => T): T {
	return withTreeLock(`${treePath(root)}.lock`, () => {
		const state: TreeState = load(root);
		const result: T = work(state);
		writeState(treePath(root), state);
		return result;
	});
}
export function readTree(root: string, timeoutMs = 5000): TreeState {
	return withTreeLock(`${treePath(root)}.lock`, () => load(root), timeoutMs);
}
export function treeCounts(state: TreeState): TreeCounts {
	const charged: TreeEntry[] = state.entries.filter((entry) => entry.phase !== "not-started");
	return {
		lifetime: charged.length,
		concurrent: charged.filter(
			(entry) =>
				!entry.finished &&
				!entry.closed &&
				(!entry.gone ||
					(!state.entries.some((next) => next.resumedFrom === entry.id && next.phase !== "not-started") &&
						sessionIsOwned(entry.sessionId))),
		).length,
	};
}

/** Session-based ancestry survives a coordinator's absent process and resumes. */
export function descendants(state: TreeState, ancestor: string): TreeEntry[] {
	const sessions: Set<string> = new Set([ancestor]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const entry of state.entries)
			if (sessions.has(entry.identity.parent) && !sessions.has(entry.sessionId)) {
				sessions.add(entry.sessionId);
				changed = true;
			}
	}
	return state.entries.filter((entry) => sessions.has(entry.identity.parent));
}
function entryFor(state: TreeState, token: Reservation): TreeEntry {
	const entry: TreeEntry | undefined = state.entries.find((entry) => entry.id === token.id);
	if (!entry) throw new Error(`missing tree reservation ${token.id}`);
	return entry;
}

/** Read-only preflight also reused under the admission lock against races. */
export function assertParentPlacement(state: TreeState, identity: Identity): void {
	if (
		state.entries.some(
			(entry) => entry.sessionId === identity.parent && entry.identity.rootPlacement !== identity.rootPlacement,
		)
	)
		throw new Error("conflicting rootPlacement with recorded direct parent; launch refused");
}

export function reserveTree(intent: TreeIntent): Reservation {
	assertRootPlacement(intent.identity.rootPlacement);
	const root: string = intent.identity.root;
	return treeTransaction(root, (state) => {
		reconcileFacts(state);
		assertParentPlacement(state, intent.identity);
		const caps = treeCaps();
		const counts: TreeCounts = treeCounts(state);
		if (fenced(state, intent.identity.parent)) throw new Error("delegation subtree is closing; launch refused");
		checkResumeFence(state, intent);
		if (state.entries.some((entry) => entry.id === intent.id)) throw new Error(`duplicate reservation ${intent.id}`);
		if (state.entries.some((entry) => entry.sessionId === intent.sessionId && entry.phase === "dispatched"))
			throw new Error(
				`session ${intent.sessionId} has an earlier launch whose outcome is unknown; another resume is refused while its reservation remains charged. Its start in a window or a terminal result can resolve the uncertainty.`,
			);
		for (const [key, count] of [
			["maxConcurrentDelegates", counts.concurrent],
			["maxDelegatesPerRoot", counts.lifetime],
		] as const)
			if (caps[key] > 0 && count >= caps[key])
				throw new Error(`${key}: current count ${count}, limit ${caps[key]}; launch refused (no queue)`);
		state.entries.push({ ...intent, ownerPid: process.pid, phase: "reserved" });
		return { root, id: intent.id };
	});
}

export function bindTree(
	token: Reservation,
	facts: Partial<Pick<TreeEntry, "requestId" | "windowName" | "cwd" | "workspace">>,
): void {
	treeTransaction(token.root, (state) => Object.assign(entryFor(state, token), facts));
}
export function dispatchTree(token: Reservation): void {
	treeTransaction(token.root, (state) => {
		const entry: TreeEntry = entryFor(state, token);
		if (entry.phase !== "reserved" || entry.closing || fenced(state, entry.identity.parent))
			throw new Error("tree reservation is no longer dispatchable");
		entry.phase = "dispatched";
		entry.createPending = true;
	});
}
export function openedTree(token: Reservation, windowId: string): void {
	treeTransaction(token.root, (state) => {
		const entry: TreeEntry = entryFor(state, token);
		entry.phase = "started";
		entry.windowId = windowId;
		entry.createPending = false;
	});
}
/** A child can locate its own window even if its opener lost tmux's response. */
export function claimTree(root: string, session: string, window: { id: string; name: string } | undefined): void {
	treeTransaction(root, (state) => {
		const candidates: TreeEntry[] = state.entries.filter(
			(entry) =>
				entry.sessionId === session &&
				(entry.phase === "dispatched" || entry.phase === "started") &&
				!entry.finished &&
				!entry.closed &&
				!state.entries.some((next) => next.resumedFrom === entry.id && next.phase !== "not-started"),
		);
		if (candidates.length !== 1) return;
		const entry: TreeEntry | undefined = candidates[0];
		if (!entry) return;
		entry.phase = "started";
		if (window) {
			entry.windowId = window.id;
			entry.windowName = window.name;
			entry.createPending = false;
		}
	});
}
/** Only a confirmed pre-start failure may refund lifetime. Unknown stays charged. */
export function failedTree(token: Reservation, notOpened = false): void {
	treeTransaction(token.root, (state) => {
		const entry: TreeEntry = entryFor(state, token);
		if (entry.phase === "reserved" || (entry.phase === "dispatched" && notOpened && !entry.finished)) {
			entry.phase = "not-started";
			entry.createPending = false;
		}
	});
}

function applyRecord(entry: TreeEntry, record: Recorded): void {
	if (!isStarted(record)) return;
	entry.launch = { ...record };
	// Do not store semantic results or child processing facts in this index.
	delete (entry.launch as Partial<typeof record>).result;
	delete (entry.launch as Partial<typeof record>).gone;
	delete (entry.launch as Partial<typeof record>).closed;
	entry.phase = "started";
	entry.createPending = false;
	// A same-id manual reopen can positively locate a newer window. Historical
	// parent facts must not overwrite that current locator at the next admission.
	if (!entry.windowId || (!entry.closed && (!entry.gone || !sessionIsOwned(entry.sessionId)))) {
		entry.windowId = record.windowId;
		entry.windowName = record.windowName;
	}
	entry.requestId = record.requestId;
	entry.cwd = record.cwd;
	entry.workspace = record.workspace;
	entry.sessionDir = record.sessionDir;
	if (record.result) entry.finished = true;
	if (record.gone) entry.gone = true;
	if (record.closed) entry.closed = true;
}

/** Publish only already-durable local facts. It never acknowledges outcomes. */
export function publishTreeRecords(root: string, parent: string, records: Recorded[]): void {
	if (!records.some(isStarted)) return;
	treeTransaction(root, (state) => {
		for (const record of records) {
			if (!isStarted(record)) continue;
			let entry: TreeEntry | undefined = state.entries.find((item) => item.id === record.id);
			if (!entry && record.identity?.root === root) {
				entry = {
					id: record.id,
					sessionId: sessionIdOf(record),
					identity: record.identity,
					ownerPid: process.pid,
					phase: "started",
					resumedFrom: record.resumedFrom,
				};
				state.entries.push(entry);
			}
			if (entry?.identity.parent === parent) applyRecord(entry, record);
		}
	});
}

/** The worker invokes this after freezing its reply, before transport/dequeue. */
export function finishTree(root: string, session: string, requests: readonly string[]): void {
	treeTransaction(root, (state) => {
		bindOrphanRequest(state, session, requests);
		for (const entry of state.entries)
			if (entry.sessionId === session && entry.requestId && requests.includes(entry.requestId)) {
				entry.finished = true;
				entry.phase = "started";
			}
	});
}

// Resume mails after open. Recover the send/bind crash gap only when both
// the unresolved launch and the as-yet-unbound request are unambiguous.
function bindOrphanRequest(state: TreeState, session: string, requests: readonly string[]): void {
	const candidates: TreeEntry[] = state.entries.filter(
		(entry) => entry.sessionId === session && !entry.requestId && entry.phase === "started",
	);
	const unknown: string[] = requests.filter((id) => !state.entries.some((entry) => entry.requestId === id));
	if (candidates.length === 1 && unknown.length === 1) {
		const candidate: TreeEntry | undefined = candidates[0];
		if (candidate) candidate.requestId = unknown[0];
	}
}
function markFinished(entry: TreeEntry): void {
	entry.finished = true;
	entry.phase = "started";
}
function reconcileTask(state: TreeState, entry: TreeEntry): void {
	const task = readTaskState(taskStatePath(entry.sessionId));
	if (task && (!Array.isArray(task.outbox) || !Array.isArray(task.requests)))
		throw new Error(`invalid task outbox for ${entry.sessionId}`);
	if (task?.parent === entry.identity.parent)
		bindOrphanRequest(
			state,
			entry.sessionId,
			task.requests.map((request) => request.id),
		);
	if (entry.requestId && task?.outbox.some((reply) => reply.ids.includes(entry.requestId as string)))
		markFinished(entry);
}
function reconcileFacts(state: TreeState): void {
	const parents: Map<string, Recorded[]> = new Map();
	for (const entry of state.entries) {
		const parent: string = entry.identity.parent;
		if (!parents.has(parent)) parents.set(parent, readChildRecords(parent));
		const record: Recorded | undefined = parents.get(parent)?.find((record) => record.id === entry.id);
		if (record) applyRecord(entry, record);
		reconcileTask(state, entry);
		if (entry.phase === "reserved" && !processAlive(entry.ownerPid)) entry.phase = "not-started";
	}
}
function reconcileWindows(state: TreeState, snapshot: TreeState, windows: TmuxWindow[]): void {
	for (const previous of snapshot.entries) {
		if (previous.phase !== "started" || !previous.windowId) continue;
		const entry: TreeEntry | undefined = state.entries.find((item) => item.id === previous.id);
		if (!entry || entry.windowId !== previous.windowId || entry.windowName !== previous.windowName) continue;
		const window: TmuxWindow | undefined = windows.find(
			(window) => window.id === entry.windowId && window.name === entry.windowName,
		);
		if (!window || window.exited) entry.gone = true;
	}
}
/** Snapshot before tmux: a newly started child cannot be judged by an old list. */
export async function reconcileTree(root: string, tmux: TmuxClient): Promise<void> {
	const snapshot: TreeState = readTree(root);
	const windows: TmuxWindow[] | undefined = snapshot.entries.some(
		(entry) => entry.phase === "started" && !entry.finished && !entry.gone && !entry.closed,
	)
		? await listWindows(tmux)
		: undefined;
	treeTransaction(root, (state) => {
		reconcileFacts(state);
		if (windows) reconcileWindows(state, snapshot, windows);
	});
}
