// Deferred descendant-scoped cleanup. Durable records prove creation, not current safety.
import { readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readChildRecords } from "./child-tasks.ts";
import {
	type CleanupGitDeps,
	type CleanupOutcome,
	type CleanupResource,
	cleanGit,
	cleanupRemains,
	previewCleanupGit,
} from "./cleanup-git.ts";
import { type CleanupPaseoDeps, cleanupPaseo } from "./cleanup-paseo.ts";
import { readIdentity } from "./identity.ts";
import { paseoLocator } from "./paseo-locator.ts";
import { findSession, sessionHeaderCwd, sessionIdOf } from "./result-sessions.ts";
import { isStarted, type Recorded, type StartedRecorded } from "./result-types.ts";
import { sessionIsOwned } from "./session-owner.ts";
import { type DelegateHost, recordLocator, sameWindowLocator } from "./tmux.ts";
import { type ToolDef, toolResult } from "./tracking.ts";
import { below } from "./tree-fence.ts";
import { processAlive } from "./tree-lock.ts";
import { descendants, readTree, readTreeDisplay, type TreeEntry, type TreeState } from "./tree-registry.ts";
import { askWindowStates, type WindowStates } from "./window-state.ts";
import { canonical, inQueue } from "./worktree.ts";

export type CleanupItem = CleanupOutcome & { id: string };
export type CleanupSelection = {
	total: number;
	processed: number;
	omitted: number;
	omittedIds: string[];
	notice: string;
};
export type CleanupResult = {
	items: CleanupItem[];
	counts: { removed: number; kept: number; partial: number; alreadyClean: number };
	selection?: CleanupSelection;
};
type Candidate = { resource: CleanupResource; records: Recorded[]; ids: string[]; order: number };
type Discovery = { groups: Candidate[]; records: Map<string, Recorded> };
type Request = { ids?: string[]; all?: boolean };
export type CleanupDeps = CleanupGitDeps &
	CleanupPaseoDeps & {
		host: DelegateHost;
		assertActive: () => void;
		maxGroups?: number;
		maxMs?: number;
	};

function resource(record: Recorded): CleanupResource | undefined {
	if (isStarted(record)) {
		const workspace = record.workspace;
		if (workspace?.mode !== "managed") return undefined;
		return {
			source: workspace.source,
			destination: workspace.cwd,
			branch: workspace.createdBranch,
			baseCommit: workspace.baseCommit,
		};
	}
	const attempt = record.attempt;
	if (
		attempt.resources.kind !== "worktree" ||
		!["created", "retained", "interrupted"].includes(attempt.phase) ||
		(attempt.phase === "interrupted" && attempt.lastPhase !== "created")
	)
		return undefined;
	if (attempt.resources.cwd !== record.plan.destination || attempt.resources.branch !== record.plan.branch)
		throw new Error(`attempt ${record.id} resources differ from its plan`);
	return record.plan;
}

function descendantRecords(state: TreeState, actor: string): Map<string, Recorded> {
	const entries: TreeEntry[] = descendants(state, actor);
	const sessions: Set<string> = new Set([actor, ...entries.map((entry) => entry.sessionId)]);
	const records: Map<string, Recorded> = new Map();
	for (const session of sessions) {
		for (const record of readChildRecords(session)) {
			const parent: string = isStarted(record) ? (record.identity?.parent ?? session) : record.parentId;
			if (parent !== session || !below(state, parent, actor))
				throw new Error("inconsistent child record authority; cleanup refused");
			records.set(record.id, record);
		}
	}
	return records;
}
/** Include attempts and grandchildren; display projections deliberately omit some of these. */
function discover(state: TreeState, actor: string): Discovery {
	const records: Map<string, Recorded> = descendantRecords(state, actor);
	const groups: Map<string, Candidate> = new Map();
	let order = 0;
	for (const record of records.values()) {
		const found: CleanupResource | undefined = resource(record);
		if (!found) continue;
		const key: string = JSON.stringify([found.source.commonDir, found.destination, found.branch]);
		const group: Candidate = groups.get(key) ?? {
			resource: found,
			records: [],
			ids: [],
			order: state.entries.length + order++,
		};
		const ordinal: number = state.entries.findIndex((entry) => entry.id === record.id);
		if (ordinal >= 0) group.order = Math.min(group.order, ordinal);
		group.records.push(record);
		group.ids.push(record.id);
		groups.set(key, group);
	}
	return { groups: [...groups.values()].sort((a, b) => a.order - b.order), records };
}
const inside = (path: string, root: string): boolean => path === root || path.startsWith(`${root}${sep}`);
function overlap(path: string, root: string, symmetric = false): boolean {
	const resolved: string = canonical(path);
	return inside(resolved, root) || (symmetric && inside(root, resolved));
}
function names(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}
function trees(): TreeState[] {
	const dir: string = join(getAgentDir(), "squire", "trees");
	return names(dir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => readTreeDisplay(decodeURIComponent(name.slice(0, -5))));
}
type GoneStarts = ReadonlyMap<string, StartedRecorded>;
function checkEntry(entry: TreeEntry, group: Candidate, actor: string, gone: GoneStarts): void {
	if (entry.sessionId === actor) return;
	const path: string = group.resource.destination;
	if (
		["reserved", "dispatched"].includes(entry.phase) &&
		processAlive(entry.ownerPid) &&
		(entry.cwd === undefined || overlap(entry.cwd, path, true))
	)
		throw new Error("live pending delegation reservation");
	const previous: StartedRecorded | undefined = gone.get(entry.id);
	const judgedGone: boolean =
		previous !== undefined &&
		previous.identity?.root === entry.identity.root &&
		sessionIdOf(previous) === entry.sessionId &&
		sameWindowLocator(previous, entry);
	if (
		entry.phase === "started" &&
		!entry.finished &&
		!entry.closed &&
		!entry.gone &&
		!judgedGone &&
		[entry.cwd, entry.workspace?.cwd].some((cwd) => cwd !== undefined && overlap(cwd, path, true))
	)
		throw new Error("live started delegation overlaps worktree; close it with delegation_close first");
	if (group.ids.includes(entry.id)) return;
	if (
		sessionIsOwned(entry.sessionId) &&
		[entry.cwd, entry.workspace?.cwd].some((cwd) => cwd !== undefined && overlap(cwd, path, true))
	)
		throw new Error("owned registry session overlaps worktree");
}
function sessionDirs(entries: TreeEntry[], id: string, ctx: ExtensionContext): string[] {
	const dirs: (string | undefined)[] = [
		...entries.filter((entry) => entry.sessionId === id).map((entry) => entry.sessionDir),
		ctx.sessionManager.getSessionDir(),
	];
	const root: string = join(getAgentDir(), "sessions");
	dirs.push(...names(root).map((name) => join(root, name)));
	return [...new Set(dirs.filter((dir): dir is string => dir !== undefined))];
}
/** Synchronous registry/owner/header proof; repeated immediately before Git removal. */
export function cleanupLiveCheck(group: Candidate, actor: string, ctx: ExtensionContext, gone: GoneStarts): void {
	const entries: TreeEntry[] = trees().flatMap((state) => state.entries);
	for (const entry of entries) checkEntry(entry, group, actor, gone);
	const owners: string = join(getAgentDir(), "squire", "owners");
	for (const name of names(owners).filter((name) => name.endsWith(".json"))) {
		const id: string = decodeURIComponent(name.slice(0, -5));
		if (id === actor || !sessionIsOwned(id)) continue;
		const file: string | undefined = sessionDirs(entries, id, ctx)
			.map((dir) => findSession(dir, id))
			.find((path) => path !== undefined);
		const cwd: string | undefined = file ? sessionHeaderCwd(file) : undefined;
		if (cwd !== undefined && overlap(cwd, group.resource.destination))
			throw new Error("owned session cwd inside worktree");
	}
}
function preflight(group: Candidate, windows: WindowStates): string | undefined {
	for (const record of group.records) {
		if (!isStarted(record)) continue;
		if (paseoLocator(recordLocator(record))) continue;
		const state: string = windows.state(record);
		if (state === "running") return "running delegation window; close it with delegation_close first";
		if (state !== "gone") return "window state unknown; no live user not proved";
	}
	return undefined;
}
function kept(id: string, reason: string, candidate?: Candidate): CleanupItem {
	return {
		id,
		outcome: "kept",
		reason,
		remains: candidate ? cleanupRemains(candidate.resource) : [],
	};
}
function validate(request: Request): void {
	if ((request.ids !== undefined) === (request.all === true))
		throw new Error("pass ids or all: true, not both and not neither");
	if (
		request.ids &&
		(!request.ids.length || request.ids.length > 50 || new Set(request.ids).size !== request.ids.length)
	)
		throw new Error("ids must contain 1 to 50 unique delegation ids");
}
function counts(items: CleanupItem[]): CleanupResult["counts"] {
	return {
		removed: items.filter((item) => item.outcome === "removed").length,
		kept: items.filter((item) => item.outcome === "kept").length,
		partial: items.filter((item) => item.outcome === "partial").length,
		alreadyClean: items.filter((item) => item.outcome === "already-clean").length,
	};
}
type Selection = { groups: Candidate[]; ids: string[] };
function select(found: Discovery, request: Request, state: TreeState, actor: string): Selection {
	const ids: string[] = request.ids ?? found.groups.flatMap((group) => group.ids);
	for (const id of ids) {
		const record: Recorded | undefined = found.records.get(id);
		const entry: TreeEntry | undefined = state.entries.find((item) => item.id === id);
		if (!record && (!entry || entry.sessionId === actor || !below(state, entry.identity.parent, actor)))
			throw new Error(`no delegation ${JSON.stringify(id)} in this session's descendant tree; cleanup refused`);
	}
	return { groups: found.groups.filter((group) => group.ids.some((id) => ids.includes(id))), ids };
}
async function finishGroup(current: Candidate, deps: CleanupDeps, liveCheck: () => void): Promise<CleanupOutcome> {
	const preview: CleanupOutcome | undefined = previewCleanupGit(current.resource, liveCheck, deps);
	if (preview && preview.outcome !== "already-clean") return preview;
	const paseo = await cleanupPaseo(current.resource, current.records, deps);
	if (paseo.outcome) return paseo.outcome;
	const result: CleanupOutcome = cleanGit(current.resource, liveCheck, deps);
	if (paseo.archived && result.outcome === "kept") result.outcome = "partial";
	if (paseo.archived && result.outcome === "already-clean") {
		result.outcome = "removed";
		result.reason = "Paseo workspace archived; worktree and branch already absent";
	} else if (paseo.archived) result.reason += "; Paseo workspace archived";
	return result;
}
async function processGroup(
	group: Candidate,
	deps: CleanupDeps,
	ctx: ExtensionContext,
	actor: string,
	root: string,
	signal?: AbortSignal,
): Promise<CleanupOutcome> {
	return inQueue(group.resource.source.commonDir, signal, async () => {
		try {
			// Snapshot records before windows: a later start cannot be judged by an old listing.
			// Do both inside the queue so a queued managed launch has finished publishing first.
			const found: Discovery = discover(readTree(root), actor);
			const current: Candidate | undefined = found.groups.find(
				(candidate) =>
					candidate.resource.source.commonDir === group.resource.source.commonDir &&
					candidate.resource.destination === group.resource.destination &&
					candidate.resource.branch === group.resource.branch &&
					group.ids.every((id) => candidate.ids.includes(id)),
			);
			if (!current) return kept("", "worktree records changed since selection; nothing removed", group);
			const windows: WindowStates = await askWindowStates(deps.host);
			const reason: string | undefined = preflight(current, windows);
			if (reason) return kept("", reason, current);
			// Only these pre-listing starts may be exempted by the synchronous live check.
			// Bind the proof to the exact locator as well, so a same-id reopen cannot reuse it.
			const gone: Map<string, StartedRecorded> = new Map();
			for (const record of found.records.values())
				if (isStarted(record) && windows.state(record) === "gone") gone.set(record.id, record);
			return finishGroup(current, deps, () => cleanupLiveCheck(current, actor, ctx, gone));
		} catch (error) {
			return kept("", (error as Error).message, group);
		}
	});
}

/** Selection is authorized in full before any mutation, so a bad id never permits a partial request. */
export async function cleanup(
	request: Request,
	deps: CleanupDeps,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<CleanupResult> {
	validate(request);
	deps.assertActive();
	const actor: string = ctx.sessionManager.getSessionId();
	const root: string = readIdentity(actor)?.root ?? actor;
	const state: TreeState = readTree(root);
	const found: Discovery = discover(state, actor);
	const selected: Selection = select(found, request, state, actor);
	const results: Map<string, CleanupItem> = new Map();
	const omitted: Candidate[] = [];
	const start: number = Date.now();
	let processed = 0;
	for (const group of selected.groups) {
		if (processed >= (deps.maxGroups ?? 50) || Date.now() - start >= (deps.maxMs ?? 120_000) || signal?.aborted) {
			omitted.push(group);
			continue;
		}
		const result: CleanupOutcome = await processGroup(group, deps, ctx, actor, root, signal);
		processed++;
		for (const id of group.ids) results.set(id, { ...result, id });
	}
	const omittedIds: string[] = omitted.flatMap((group) => group.ids);
	const items: CleanupItem[] = selected.ids
		.filter((id) => !omittedIds.includes(id))
		.map((id) => results.get(id) ?? kept(id, "not a Squire-created worktree"));
	return {
		items,
		counts: counts(items),
		...(request.all || omitted.length
			? {
					selection: {
						total: selected.groups.length,
						processed,
						omitted: omitted.length,
						omittedIds,
						notice: omitted.length
							? "Stops starting new worktrees after about 120 s; the rest are listed in omittedIds. Pass ids for them."
							: "All selected groups processed.",
					},
				}
			: {}),
	};
}
function itemLine(item: CleanupItem): string {
	const ignored: string = item.ignoredRemoved ? `; ${item.ignoredRemoved.total} ignored entries removed` : "";
	const remains: string = item.remains.length ? `; remains: ${item.remains.join(", ")}` : "";
	return `${item.id}: ${item.outcome} — ${item.reason}${ignored}${remains}`;
}
export function cleanupText(result: CleanupResult): string {
	const lines: string[] = [];
	const groups: Map<string, string[]> = new Map();
	for (const item of result.items) {
		if (item.outcome === "kept") {
			groups.set(item.reason, [...(groups.get(item.reason) ?? []), item.id]);
		} else {
			lines.push(itemLine(item));
		}
	}
	for (const [reason, ids] of groups)
		lines.push(
			`kept: ${reason} — ${ids.slice(0, 10).join(", ")}${ids.length > 10 ? ` and ${ids.length - 10} more` : ""}`,
		);
	if (result.selection?.omitted) lines.push(result.selection.notice);
	return lines.join("\n") || "No Squire-created worktrees selected.";
}
const ItemSchema = Type.Object({
	id: Type.String(),
	outcome: Type.Enum(["removed", "kept", "partial", "already-clean"]),
	reason: Type.String(),
	remains: Type.Array(Type.String()),
	ignoredRemoved: Type.Optional(Type.Object({ total: Type.Number(), paths: Type.Array(Type.String()) })),
});
export const CleanupSchema = Type.Object({
	items: Type.Array(ItemSchema),
	counts: Type.Object({
		removed: Type.Number(),
		kept: Type.Number(),
		partial: Type.Number(),
		alreadyClean: Type.Number(),
	}),
	selection: Type.Optional(
		Type.Object({
			total: Type.Number(),
			processed: Type.Number(),
			omitted: Type.Number(),
			omittedIds: Type.Array(Type.String()),
			notice: Type.String(),
		}),
	),
});
export function cleanupTool(deps: CleanupDeps): ToolDef & { exposure: "deferred"; promptGuidelines: string[] } {
	return {
		name: "delegation_cleanup",
		label: "Clean up delegations",
		exposure: "deferred",
		description:
			"Remove finished delegations' Squire-created worktrees and local branches when they are merged, unused and have no uncommitted or untracked changes; ignored files in them (node_modules, a hand-made .env) are deleted too. Archives Paseo workspaces Squire created for them. Anything unproved is kept with a reason. Close running delegations with delegation_close first.",
		promptGuidelines: [
			"Call delegation_cleanup after a delegate's work is merged, not while you still need its worktree.",
		],
		parameters: Type.Object({
			ids: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 50, uniqueItems: true })),
			all: Type.Optional(Type.Literal(true)),
		}),
		outputSchema: CleanupSchema,
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
		async execute(
			_id: string,
			request: Request,
			signal: AbortSignal | undefined,
			_update: unknown,
			ctx: ExtensionContext,
		): Promise<ReturnType<typeof toolResult>> {
			const result: CleanupResult = await cleanup(request, deps, ctx, signal);
			return {
				...toolResult(cleanupText(result), result),
				...(result.counts.partial ? { isError: true } : {}),
			};
		},
	};
}
