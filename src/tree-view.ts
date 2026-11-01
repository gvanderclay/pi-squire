// Read-only projection. Shared ancestry locates records; only each direct
// parent's local child facts carry semantic results. Never imports outcomes.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readChildRecords } from "./child-tasks.ts";
import { type Identity, maxDepth, readIdentity } from "./identity.ts";
import { isStarted, type Recorded, type Results, type StartedRecorded, sessionIdOf } from "./results.ts";
import { sessionIsOwned } from "./session-owner.ts";
import { descendants, readTree, type TreeEntry } from "./tree-registry.ts";

export function recordedIdentity(record: StartedRecorded): Identity | undefined {
	const durable: Identity | undefined = readIdentity(sessionIdOf(record));
	if (
		durable &&
		record.identity &&
		(durable.parent !== record.identity.parent ||
			durable.root !== record.identity.root ||
			durable.depth !== record.identity.depth)
	)
		throw new Error(`conflicting ownership for delegation ${record.id}`);
	return durable ?? record.identity;
}
export function belongsTo(record: Recorded, ctx: ExtensionContext): boolean {
	if (!isStarted(record)) return record.parentId === ctx.sessionManager.getSessionId();
	if (record.identity?.parent && record.identity.parent !== ctx.sessionManager.getSessionId()) return false;
	if (!record.identity && ctx.sessionManager.getHeader?.()?.parentSession) return false;
	const identity: Identity | undefined = recordedIdentity(record);
	if (identity) return identity.parent === ctx.sessionManager.getSessionId();
	// Legacy starts without identity may be restored by their original session,
	// never by a branch copied into a fresh session file.
	return !ctx.sessionManager.getHeader?.()?.parentSession;
}
export function assertResumeAuthority(record: StartedRecorded, ctx: ExtensionContext): void {
	const child: Identity | undefined = recordedIdentity(record);
	if (!belongsTo(record, ctx))
		throw new Error(
			`only direct parent ${child?.parent ?? "(original session)"} may resume delegation ${record.id}; reopen that parent session`,
		);
	if (!child) return;
	const parent: Identity | undefined = readIdentity(ctx.sessionManager.getSessionId());
	if (child.root !== (parent?.root ?? ctx.sessionManager.getSessionId()) || child.depth !== (parent?.depth ?? 0) + 1)
		throw new Error(`delegation ${record.id} has inconsistent root/depth ownership; resume refused`);
	if (child.depth > maxDepth())
		throw new Error(
			`delegation ${record.id} depth ${child.depth} exceeds maxDepth ${maxDepth()} in squire/settings.json`,
		);
	const state = readTree(child.root);
	const newer: TreeEntry | undefined = newestSuccessor(state.entries, record.id);
	if (newer)
		throw new Error(
			`delegation ${record.id} was already resumed; resume its newest delegation ${newer.id} instead (it continues the same session)`,
		);
}
function newestSuccessor(entries: TreeEntry[], id: string): TreeEntry | undefined {
	const seen: Set<string> = new Set([id]);
	let newest: TreeEntry | undefined;
	let current: string = id;
	for (;;) {
		const next: TreeEntry | undefined = entries.find(
			(entry) => entry.resumedFrom === current && (entry.phase === "started" || entry.phase === "dispatched"),
		);
		if (!next) return newest;
		if (seen.has(next.id)) throw new Error("invalid shared resume chain; resume refused");
		seen.add(next.id);
		newest = next;
		current = next.id;
	}
}
export function visibleRecords(results: Results, ctx: ExtensionContext): Recorded[] {
	const session: string = ctx.sessionManager.getSessionId();
	const root: string = readIdentity(session)?.root ?? session;
	const records: Map<string, Recorded> = new Map(results.list().map((record) => [record.id, record]));
	const parents: Map<string, Recorded[]> = new Map();
	let entries: TreeEntry[];
	try {
		entries = descendants(readTree(root), session).filter((entry) => entry.phase !== "not-started");
	} catch (error) {
		ctx.ui.notify(
			`delegate: descendant accounting unavailable: ${String(error)}; showing saved local children only.`,
			"warning",
		);
		return [...records.values()];
	}
	for (const entry of entries) {
		if (!parents.has(entry.identity.parent))
			parents.set(entry.identity.parent, parentRecords(entry.identity.parent, ctx));
		const local: Recorded | undefined = parents.get(entry.identity.parent)?.find((record) => record.id === entry.id);
		const record: Recorded = local ?? entry.launch ?? registryView(entry);
		if (entry.gone && !entry.finished && sessionIsOwned(entry.sessionId) && isStarted(record)) {
			records.set(entry.id, {
				...record,
				identity: entry.identity,
				windowId: entry.windowId ?? record.windowId,
				windowName: entry.windowName ?? record.windowName,
			});
		} else if (!records.has(entry.id)) records.set(entry.id, { ...record, identity: entry.identity });
	}
	return hierarchy(withCloses(records, entries), session);
}
function withCloses(records: Map<string, Recorded>, entries: TreeEntry[]): Recorded[] {
	for (const entry of entries) {
		const record: Recorded | undefined = records.get(entry.id);
		if (entry.closed && record && isStarted(record)) records.set(entry.id, { ...record, closed: true });
	}
	return [...records.values()];
}
function parentRecords(parent: string, ctx: ExtensionContext): Recorded[] {
	try {
		return readChildRecords(parent);
	} catch (error) {
		ctx.ui.notify(
			`delegate: child facts for ${parent} unavailable: ${String(error)}; showing registry metadata only.`,
			"warning",
		);
		return [];
	}
}
export function restoredStarts(ctx: ExtensionContext): StartedRecorded[] {
	const session: string = ctx.sessionManager.getSessionId();
	const root: string = readIdentity(session)?.root ?? session;
	return readTree(root)
		.entries.filter((entry) => entry.identity.parent === session && entry.phase === "started")
		.flatMap((entry) => (entry.launch && entry.requestId && entry.windowId ? [entry.launch] : []));
}
function registryView(entry: TreeEntry): StartedRecorded {
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
	};
}
function hierarchy(records: Recorded[], viewer: string): Recorded[] {
	const byParent: Map<string, Recorded[]> = new Map();
	const latest: Map<string, string> = new Map();
	for (const record of records) {
		const parent: string = isStarted(record) ? (record.identity?.parent ?? viewer) : record.parentId;
		byParent.set(parent, [...(byParent.get(parent) ?? []), record]);
		if (isStarted(record)) latest.set(sessionIdOf(record), record.id);
	}
	const ordered: Recorded[] = [];
	const seen: Set<string> = new Set();
	const walk = (parent: string): void => {
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
export function accountingFor(record: StartedRecorded): string | undefined {
	if (!record.identity) return undefined;
	let entry: TreeEntry | undefined;
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
export function historicalRecord(id: string, ctx: ExtensionContext): StartedRecorded | undefined {
	for (const entry of ctx.sessionManager.getEntries())
		if (entry.type === "custom" && entry.customType === "delegate") {
			const value = entry.data as StartedRecorded | undefined;
			if (value?.id === id && typeof value.requestId === "string") return value;
		}
	return undefined;
}
