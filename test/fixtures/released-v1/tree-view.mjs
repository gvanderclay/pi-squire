// Frozen executable v0.20.2 (c27b082d19662bdca37f5d4fb02e94b3037ed4ac) src/tree-view.ts.
// Type annotations stripped; only import paths relocated. See README.md.
// Read-only projection. Shared ancestry locates records; only each direct
// parent's local child facts carry semantic results. Never imports outcomes.

import { readChildRecords } from "./child-tasks.mjs";
import { maxDepth, readIdentity } from "../../../src/identity.ts";
import { isStarted, sessionIdOf } from "./results.mjs";
import { sessionIsOwned } from "../../../src/session-owner.ts";
import { descendants, readTree } from "./tree-registry.mjs";
import { assertRootPlacement } from "../../../src/window-placement.ts";

export function recordedIdentity(record) {
	const durable = readIdentity(sessionIdOf(record));
	if (
		durable &&
		record.identity &&
		(durable.parent !== record.identity.parent ||
			durable.root !== record.identity.root ||
			durable.rootPlacement !== record.identity.rootPlacement ||
			durable.depth !== record.identity.depth)
	)
		throw new Error(`conflicting ownership for delegation ${record.id}`);
	const own = durable ?? record.identity;
	if (own) assertRootPlacement(own.rootPlacement);
	return own;
}
export function belongsTo(record, ctx) {
	if (!isStarted(record)) return record.parentId === ctx.sessionManager.getSessionId();
	if (record.identity?.parent && record.identity.parent !== ctx.sessionManager.getSessionId()) return false;
	if (!record.identity && ctx.sessionManager.getHeader?.()?.parentSession) return false;
	const identity = recordedIdentity(record);
	if (identity) return identity.parent === ctx.sessionManager.getSessionId();
	// Legacy starts without identity may be restored by their original session,
	// never by a branch copied into a fresh session file.
	return !ctx.sessionManager.getHeader?.()?.parentSession;
}
export function assertChildAuthority(record, ctx, operation) {
	const child = recordedIdentity(record);
	if (!belongsTo(record, ctx))
		throw new Error(
			`only direct parent ${child?.parent ?? "(original session)"} may ${operation} delegation ${record.id}; reopen that parent session`,
		);
	if (!child) throw new Error(`delegation ${record.id} has no original root placement identity; ${operation} refused`);
	const parent = readIdentity(ctx.sessionManager.getSessionId());
	if (
		child.root !== (parent?.root ?? ctx.sessionManager.getSessionId()) ||
		child.depth !== (parent?.depth ?? 0) + 1 ||
		(parent && child.rootPlacement !== parent.rootPlacement)
	)
		throw new Error(
			`delegation ${record.id} has inconsistent root/depth or rootPlacement ownership; ${operation} refused`,
		);
	if (child.depth > maxDepth())
		throw new Error(
			`delegation ${record.id} depth ${child.depth} exceeds maxDepth ${maxDepth()} in squire/settings.json`,
		);
}
export function assertResumeAuthority(record, ctx) {
	assertChildAuthority(record, ctx, "resume");
	const child = recordedIdentity(record);
	if (!child) throw new Error(`delegation ${record.id} has no original root placement identity; resume refused`);
	const state = readTree(child.root);
	const newer = newestSuccessor(state.entries, record.id);
	if (newer)
		throw new Error(
			`delegation ${record.id} was already resumed; resume its newest delegation ${newer.id} instead (it continues the same session)`,
		);
}
function newestSuccessor(entries, id) {
	const seen = new Set([id]);
	let newest;
	let current = id;
	for (;;) {
		const next = entries.find(
			(entry) => entry.resumedFrom === current && (entry.phase === "started" || entry.phase === "dispatched"),
		);
		if (!next) return newest;
		if (seen.has(next.id)) throw new Error("invalid shared resume chain; resume refused");
		seen.add(next.id);
		newest = next;
		current = next.id;
	}
}

export function visibleRecords(results, ctx) {
	return visibleRecordFacts(results, ctx).records;
}

/** Same scoped projection, with unoverlaid parent facts and explicit coverage for read-only summaries. */
export function visibleRecordFacts(results, ctx, timeoutMs = 5000, notify = true, read = readTree) {
	const session = ctx.sessionManager.getSessionId();
	const root = readIdentity(session)?.root ?? session;
	const records = new Map(results.list().map((record) => [record.id, record]));
	const semantic = new Map(records);
	const parents = new Map();
	let complete = true;
	let entries;
	try {
		entries = descendants(read(root, timeoutMs), session).filter((entry) => entry.phase !== "not-started");
	} catch (error) {
		if (notify)
			ctx.ui.notify(
				`delegate: descendant accounting unavailable: ${String(error)}; showing saved local children only.`,
				"warning",
			);
		return {
			records: [...records.values()],
			facts: [...records.values()].map((record) => ({ record, semantic: record })),
			complete: false,
		};
	}
	for (const entry of entries) {
		const local = cachedParent(parents, entry.identity.parent, ctx, notify).find((record) => record.id === entry.id);
		if (rememberSemantic(semantic, entry.id, local)) complete = false;
		const record = local ?? entry.launch ?? registryView(entry);
		if (reattached(entry, record) && isStarted(record)) {
			records.set(entry.id, {
				...record,
				identity: entry.identity,
				windowId: entry.windowId ?? record.windowId,
				windowName: entry.windowName ?? record.windowName,
			});
		} else if (!records.has(entry.id)) records.set(entry.id, { ...record, identity: entry.identity });
	}
	const ordered = hierarchy(withCloses(records, entries), session);
	return {
		records: ordered,
		facts: ordered.map((record) => ({
			record,
			semantic: semantic.get(record.id),
			entry: entries.find((entry) => entry.id === record.id),
		})),
		complete,
	};
}
function cachedParent(parents, parent, ctx, notify) {
	let records = parents.get(parent);
	if (!records) {
		records = parentRecords(parent, ctx, notify);
		parents.set(parent, records);
	}
	return records;
}
function rememberSemantic(semantic, id, local) {
	if (local && !semantic.has(id)) semantic.set(id, local);
	return !semantic.has(id);
}
function reattached(entry, record) {
	return entry.gone === true && !entry.finished && sessionIsOwned(entry.sessionId) && isStarted(record);
}
function withCloses(records, entries) {
	for (const entry of entries) {
		const record = records.get(entry.id);
		if (entry.closed && record && isStarted(record)) records.set(entry.id, { ...record, closed: true });
	}
	return [...records.values()];
}
function parentRecords(parent, ctx, notify) {
	try {
		return readChildRecords(parent);
	} catch (error) {
		if (notify)
			ctx.ui.notify(
				`delegate: child facts for ${parent} unavailable: ${String(error)}; showing registry metadata only.`,
				"warning",
			);
		return [];
	}
}
export function restoredStarts(ctx) {
	const session = ctx.sessionManager.getSessionId();
	const root = readIdentity(session)?.root ?? session;
	return readTree(root)
		.entries.filter((entry) => entry.identity.parent === session && entry.phase === "started")
		.flatMap((entry) => (entry.launch && entry.requestId && entry.windowId ? [entry.launch] : []));
}
function registryView(entry) {
	return {
		id: entry.id,
		sessionId: entry.sessionId,
		identity: entry.identity,
		accountingOnly: true,
		agent: entry.identity.agent,
		autoExit: entry.identity.autoExit,
		model: "unknown",
		thinking: "unknown",
		windowId: entry.windowId ?? "not-recorded",
		windowName: entry.windowName ?? "not-recorded",
		requestId: entry.requestId ?? "not-recorded",
		cwd: entry.cwd,
		sessionDir: entry.sessionDir,
		workspace: entry.workspace,
		resumedFrom: entry.resumedFrom,
		forkedFrom: entry.forkedFrom,
	};
}
function hierarchy(records, viewer) {
	const byParent = new Map();
	const latest = new Map();
	for (const record of records) {
		const parent = isStarted(record) ? (record.identity?.parent ?? viewer) : record.parentId;
		byParent.set(parent, [...(byParent.get(parent) ?? []), record]);
		if (isStarted(record)) latest.set(sessionIdOf(record), record.id);
	}
	const ordered = [];
	const seen = new Set();
	const walk = (parent) => {
		for (const record of byParent.get(parent) ?? []) {
			if (seen.has(record.id)) continue;
			seen.add(record.id);
			ordered.push(record);
			if (isStarted(record) && latest.get(sessionIdOf(record)) === record.id) walk(sessionIdOf(record));
		}
	};
	walk(viewer);
	return [...ordered, ...records.filter((record) => !seen.has(record.id))];
}
/** A view can know terminal accounting while its owner has not received mail. */
export function accountingFor(record) {
	if (!record.identity) return undefined;
	let entry;
	try {
		entry = readTree(record.identity.root).entries.find((item) => item.id === record.id);
	} catch {
		return "unavailable";
	}
	if (!entry) return undefined;
	if (entry.closed) return "closed";
	if (entry.closing) return "closing";
	if (entry.finished) return "finished";
	if (entry.gone) return sessionIsOwned(entry.sessionId) ? "reattached" : "gone";
	return entry.phase;
}
export function historicalRecord(id, ctx) {
	for (const entry of ctx.sessionManager.getEntries())
		if (entry.type === "custom" && entry.customType === "delegate") {
			const value = entry.data;
			if (value?.id === id && typeof value.requestId === "string") return value;
		}
	return undefined;
}
