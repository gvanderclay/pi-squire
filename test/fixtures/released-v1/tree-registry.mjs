// Frozen executable v0.20.2 (c27b082d19662bdca37f5d4fb02e94b3037ed4ac) src/tree-registry.ts.
// Type annotations stripped; only import paths relocated. See README.md.
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readChildRecords } from "./child-tasks.mjs";

import { readState, writeState } from "../../../src/local-state.ts";
import { sessionIdOf } from "../../../src/result-sessions.ts";
import { isStarted } from "../../../src/result-types.ts";
import { sessionIsOwned } from "../../../src/session-owner.ts";
import { readTaskState, taskStatePath } from "../../../src/task-store.ts";

import { checkResumeFence, fenced } from "../../../src/tree-fence.ts";
import { processAlive, withTreeLock } from "../../../src/tree-lock.ts";
import { treeCaps } from "../../../src/tree-settings.ts";

import { assertRootPlacement } from "../../../src/window-placement.ts";
import { listWindows } from "./windows.mjs";

export function treePath(root) {
	return join(getAgentDir(), "squire", "trees", `${encodeURIComponent(root)}.json`);
}
function load(root) {
	const saved = readState(treePath(root));
	const state = saved === undefined ? { version: 1, root, entries: [] } : saved;
	if (state?.version !== 1 || state.root !== root || !Array.isArray(state.entries))
		throw new Error(`invalid tree registry for ${root}; admission blocked`);
	const ids = new Set();
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

function validateCloses(state, ids) {
	if (state.closes === undefined) return;
	if (!Array.isArray(state.closes)) throw new Error("invalid close fences; admission blocked");
	const tokens = new Set();
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

function validateFields(entry) {
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
	for (const key of ["finished", "gone", "closed", "closing", "createPending"])
		if (entry[key] !== undefined && typeof entry[key] !== "boolean")
			throw new Error(`invalid ${key} in tree entry ${entry.id}`);
	for (const key of ["requestId", "windowId", "windowName", "cwd", "sessionDir", "resumedFrom", "forkedFrom"])
		if (entry[key] !== undefined && typeof entry[key] !== "string")
			throw new Error(`invalid ${key} in tree entry ${entry.id}`);
}
/** Shared close/launch boundary. Callback is synchronous; never await tmux/UI. */
export function treeTransaction(root, work) {
	return withTreeLock(`${treePath(root)}.lock`, () => {
		const state = load(root);
		const result = work(state);
		writeState(treePath(root), state);
		return result;
	});
}
export function readTree(root, timeoutMs = 5000) {
	return withTreeLock(`${treePath(root)}.lock`, () => load(root), timeoutMs);
}
/** Atomic file replacement gives display readers a whole snapshot without writer admission. */
export function readTreeDisplay(root) {
	return load(root);
}
export function treeCounts(state) {
	const charged = state.entries.filter((entry) => entry.phase !== "not-started");
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
export function descendants(state, ancestor) {
	const sessions = new Set([ancestor]);
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
function entryFor(state, token) {
	const entry = state.entries.find((entry) => entry.id === token.id);
	if (!entry) throw new Error(`missing tree reservation ${token.id}`);
	return entry;
}

/** Read-only preflight also reused under the admission lock against races. */
export function assertParentPlacement(state, identity) {
	if (
		state.entries.some(
			(entry) => entry.sessionId === identity.parent && entry.identity.rootPlacement !== identity.rootPlacement,
		)
	)
		throw new Error("conflicting rootPlacement with recorded direct parent; launch refused");
}

export function reserveTree(intent) {
	assertRootPlacement(intent.identity.rootPlacement);
	const root = intent.identity.root;
	return treeTransaction(root, (state) => {
		reconcileFacts(state);
		assertParentPlacement(state, intent.identity);
		const caps = treeCaps();
		const counts = treeCounts(state);
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
		])
			if (caps[key] > 0 && count >= caps[key])
				throw new Error(`${key}: current count ${count}, limit ${caps[key]}; launch refused (no queue)`);
		state.entries.push({ ...intent, ownerPid: process.pid, phase: "reserved" });
		return { root, id: intent.id };
	});
}

export function bindTree(token, facts) {
	treeTransaction(token.root, (state) => Object.assign(entryFor(state, token), facts));
}
export function dispatchTree(token) {
	treeTransaction(token.root, (state) => {
		const entry = entryFor(state, token);
		if (entry.phase !== "reserved" || entry.closing || fenced(state, entry.identity.parent))
			throw new Error("tree reservation is no longer dispatchable");
		entry.phase = "dispatched";
		entry.createPending = true;
	});
}
export function openedTree(token, windowId) {
	treeTransaction(token.root, (state) => {
		const entry = entryFor(state, token);
		entry.phase = "started";
		entry.windowId = windowId;
		entry.createPending = false;
	});
}
/** A child can locate its own window even if its opener lost tmux's response. */
export function claimTree(root, session, window) {
	treeTransaction(root, (state) => {
		const candidates = state.entries.filter(
			(entry) =>
				entry.sessionId === session &&
				(entry.phase === "dispatched" || entry.phase === "started") &&
				!entry.finished &&
				!entry.closed &&
				!state.entries.some((next) => next.resumedFrom === entry.id && next.phase !== "not-started"),
		);
		if (candidates.length !== 1) return;
		const entry = candidates[0];
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
export function failedTree(token, notOpened = false) {
	treeTransaction(token.root, (state) => {
		const entry = entryFor(state, token);
		if (entry.phase === "reserved" || (entry.phase === "dispatched" && notOpened && !entry.finished)) {
			entry.phase = "not-started";
			entry.createPending = false;
		}
	});
}

function applyRecord(entry, record) {
	if (!isStarted(record)) return;
	entry.launch = { ...record };
	// Do not store semantic results or child processing facts in this index.
	delete entry.launch.result;
	delete entry.launch.gone;
	delete entry.launch.closed;
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
export function publishTreeRecords(root, parent, records) {
	if (!records.some(isStarted)) return;
	treeTransaction(root, (state) => {
		for (const record of records) {
			if (!isStarted(record)) continue;
			let entry = state.entries.find((item) => item.id === record.id);
			if (!entry && record.identity?.root === root) {
				entry = {
					id: record.id,
					sessionId: sessionIdOf(record),
					identity: record.identity,
					ownerPid: process.pid,
					phase: "started",
					resumedFrom: record.resumedFrom,
					forkedFrom: record.forkedFrom,
				};
				state.entries.push(entry);
			}
			if (entry?.identity.parent === parent) applyRecord(entry, record);
		}
	});
}

/** The worker invokes this after freezing its reply, before transport/dequeue. */
export function finishTree(root, session, requests) {
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
function bindOrphanRequest(state, session, requests) {
	const candidates = state.entries.filter(
		(entry) => entry.sessionId === session && !entry.requestId && entry.phase === "started",
	);
	const unknown = requests.filter((id) => !state.entries.some((entry) => entry.requestId === id));
	if (candidates.length === 1 && unknown.length === 1) {
		const candidate = candidates[0];
		if (candidate) candidate.requestId = unknown[0];
	}
}
function markFinished(entry) {
	entry.finished = true;
	entry.phase = "started";
}
function reconcileTask(state, entry) {
	const task = readTaskState(taskStatePath(entry.sessionId));
	if (task && (!Array.isArray(task.outbox) || !Array.isArray(task.requests)))
		throw new Error(`invalid task outbox for ${entry.sessionId}`);
	if (task?.parent === entry.identity.parent)
		bindOrphanRequest(
			state,
			entry.sessionId,
			task.requests.map((request) => request.id),
		);
	if (entry.requestId && task?.outbox.some((reply) => reply.ids.includes(entry.requestId))) markFinished(entry);
}
function reconcileFacts(state) {
	const parents = new Map();
	for (const entry of state.entries) {
		const parent = entry.identity.parent;
		if (!parents.has(parent)) parents.set(parent, readChildRecords(parent));
		const record = parents.get(parent)?.find((record) => record.id === entry.id);
		if (record) applyRecord(entry, record);
		reconcileTask(state, entry);
		if (entry.phase === "reserved" && !processAlive(entry.ownerPid)) entry.phase = "not-started";
	}
}
function reconcileWindows(state, snapshot, windows) {
	for (const previous of snapshot.entries) {
		if (previous.phase !== "started" || !previous.windowId) continue;
		const entry = state.entries.find((item) => item.id === previous.id);
		if (!entry || entry.windowId !== previous.windowId || entry.windowName !== previous.windowName) continue;
		const window = windows.find((window) => window.id === entry.windowId && window.name === entry.windowName);
		if (!window || window.exited) entry.gone = true;
	}
}
/** Snapshot before tmux: a newly started child cannot be judged by an old list. */
export async function reconcileTree(root, tmux) {
	const snapshot = readTree(root);
	const windows = snapshot.entries.some(
		(entry) => entry.phase === "started" && !entry.finished && !entry.gone && !entry.closed,
	)
		? await listWindows(tmux)
		: undefined;
	treeTransaction(root, (state) => {
		reconcileFacts(state);
		if (windows) reconcileWindows(state, snapshot, windows);
	});
}
