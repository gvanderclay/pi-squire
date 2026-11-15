// Async Paseo preflight and archive; Git is synchronously re-proved after this returns.
import { isAbsolute } from "node:path";
import type { PaseoWorkspace } from "@getpaseo/client";
import { CHANGED_CONFIRMATION, type CleanupOutcome, type CleanupResource, cleanupRemains } from "./cleanup-git.ts";
import { createPaseoApi, type PaseoApi } from "./paseo-api.ts";
import { isStarted, type Recorded } from "./result-types.ts";
import { canonical, type PaseoReceipt } from "./worktree.ts";

export type CleanupPaseoDeps = { paseoApi?: (home?: string) => PaseoApi };
type Proof = { api: PaseoApi; receipt: PaseoReceipt; workspace: PaseoWorkspace | null };
type Progress = { dispatched: boolean; ids: Set<string> };
export class PaseoUnavailableError extends Error {}
async function available(api: PaseoApi, allowAbsent = false): Promise<boolean> {
	const state = await api.availability();
	if (state.state === "available") return true;
	if (allowAbsent && state.state === "absent") return false;
	throw new PaseoUnavailableError(state.reason);
}
/** Preserve the overall refusal while reporting independent resource observations. */
export function unverifiedPaseo(error: unknown, resource: CleanupResource, gitAbsent = false): CleanupOutcome {
	return {
		outcome: "kept",
		reason: `${gitAbsent ? "Git already-clean (worktree and branch already absent); " : ""}Paseo workspace unverified: ${(error as Error).message}`,
		remains: cleanupRemains(resource),
		resources: { ...(gitAbsent ? { git: "already-clean" as const } : {}), paseo: "unverified" },
	};
}
export function withCleanGit(outcome: CleanupOutcome, git?: { tip: string | null; exists: boolean }): CleanupOutcome {
	if (git && (git.tip !== null || git.exists)) return outcome;
	return {
		...outcome,
		reason: `Git already-clean (worktree and branch already absent); ${outcome.reason}`,
		resources: { ...outcome.resources, git: "already-clean" },
	};
}
const FOREIGN = "Paseo workspace not created by Squire; kept";
const foreignReason = (count: number): string => `${FOREIGN}${count === 1 ? "; use /delegate-cleanup" : ""}`;
const key = (receipt: PaseoReceipt): string => JSON.stringify([receipt.home, receipt.workspaceId]);
function receipts(records: Recorded[]): PaseoReceipt[] {
	return records.flatMap((record) => {
		if (!isStarted(record) || record.workspace?.mode !== "managed" || record.workspace.paseo === undefined) return [];
		const receipt = record.workspace.paseo;
		if (
			!receipt ||
			typeof receipt !== "object" ||
			typeof receipt.home !== "string" ||
			!isAbsolute(receipt.home) ||
			![receipt.workspaceId, receipt.directory, receipt.projectId].every(
				(value) => typeof value === "string" && value !== "",
			) ||
			!["created", "opened", "reused"].includes(receipt.provenance)
		)
			throw new Error("Paseo workspace receipt unreadable");
		return [receipt];
	});
}
function blocker(workspace: PaseoWorkspace, resource: CleanupResource, receipt: PaseoReceipt): string | undefined {
	if (
		!workspace.workspaceDirectory ||
		canonical(workspace.workspaceDirectory) !== resource.destination ||
		canonical(receipt.directory) !== resource.destination ||
		workspace.projectId !== receipt.projectId
	)
		return "Paseo workspace identity changed";
	if (workspace.internal === true) return "internal Paseo workspace";
	if (workspace.archivingAt !== null) return "Paseo workspace already archiving";
	if (workspace.gitRuntime?.isPaseoOwnedWorktree === true) return "Paseo-owned worktree";
	if (workspace.setupStatus === "running") return "Paseo workspace setup running";
	if (workspace.scripts.some((script) => script.lifecycle === "running")) return "Paseo workspace script running";
	return undefined;
}
async function noUsers(api: PaseoApi, id: string, dir: string): Promise<void> {
	if ((await api.agentsUsing(id, dir)).length)
		throw new Error("live Paseo agent uses workspace; close it with delegation_close first");
	if ((await api.terminalsUsing(id, dir)).length) throw new Error("live Paseo terminal uses workspace");
}
async function legacyCheck(api: PaseoApi, dir: string, progress: Progress): Promise<void> {
	if (!(await available(api, true))) return;
	const workspaces = await api.workspaceAt(dir);
	for (const workspace of workspaces) progress.ids.add(workspace.id);
	if (workspaces.length) throw new Error(foreignReason(new Set(workspaces.map((workspace) => workspace.id)).size));
}
async function proofs(
	found: PaseoReceipt[],
	resource: CleanupResource,
	factory: (home?: string) => PaseoApi,
): Promise<Proof[]> {
	const created = new Set(found.filter((receipt) => receipt.provenance === "created").map(key));
	const foreign = new Set(found.filter((receipt) => !created.has(key(receipt))).map(key));
	if (foreign.size) throw new Error(foreignReason(foreign.size));
	const selected: Map<string, Proof> = new Map();
	for (const receipt of found) {
		if (selected.has(key(receipt))) continue;
		const api = factory(receipt.home);
		await available(api);
		const workspace = await api.workspace(receipt.workspaceId);
		const reason = workspace ? blocker(workspace, resource, receipt) : undefined;
		if (reason) throw new Error(reason);
		await noUsers(api, receipt.workspaceId, resource.destination);
		// A foreign workspace at the same path would be stranded by Git removal.
		const others = await api.workspaceAt(resource.destination);
		const foreignIds = new Set(
			others.filter((other) => !created.has(key({ ...receipt, workspaceId: other.id }))).map((other) => other.id),
		);
		if (foreignIds.size) throw new Error(foreignReason(foreignIds.size));
		selected.set(key(receipt), { api, receipt, workspace });
	}
	return [...selected.values()];
}
async function archive(selected: Proof[], dir: string, progress: Progress): Promise<void> {
	for (const { api, receipt, workspace } of selected) {
		if (workspace) {
			// An archive error can be an ambiguous reply after the daemon mutated.
			progress.dispatched = true;
			await api.archiveWorkspace(receipt.workspaceId);
		}
		if (await api.workspace(receipt.workspaceId)) throw new Error("Paseo workspace remains after archive");
		progress.ids.delete(receipt.workspaceId);
		await noUsers(api, receipt.workspaceId, dir);
	}
}
// WorkspaceDescriptorPayloadSchema (@getpaseo/protocol 0.15.4) also carries volatile
// activity/status/diff/forge/health observations. Bind only identity and safety facts.
type StableWorkspace = Pick<
	PaseoWorkspace,
	| "id"
	| "projectId"
	| "workspaceDirectory"
	| "name"
	| "title"
	| "createdAt"
	| "internal"
	| "archivingAt"
	| "setupStatus"
> & {
	isPaseoOwnedWorktree?: boolean;
	scripts: Pick<PaseoWorkspace["scripts"][number], "scriptName" | "lifecycle">[];
};
function stableWorkspace(workspace: PaseoWorkspace | null): StableWorkspace | null {
	if (!workspace) return null;
	const { id, projectId, workspaceDirectory, name, title, createdAt, internal, archivingAt, setupStatus } = workspace;
	return {
		id,
		projectId,
		workspaceDirectory,
		name,
		title,
		createdAt,
		internal,
		archivingAt,
		setupStatus,
		isPaseoOwnedWorktree: workspace.gitRuntime?.isPaseoOwnedWorktree,
		scripts: workspace.scripts.map(({ scriptName, lifecycle }) => ({ scriptName, lifecycle })),
	};
}
export type CleanupPaseoPreview = {
	binding: string;
	foreignId?: string;
	workspace?: StableWorkspace;
	archives: { home: string; workspaceId: string }[];
};
type CommandProof = { preview: CleanupPaseoPreview; selected: Proof[] };
async function commandHome(
	resource: CleanupResource,
	found: PaseoReceipt[],
	api: PaseoApi,
	home?: string,
): Promise<Proof[]> {
	const own = found.filter((receipt) => receipt.home === home);
	const at = await api.workspaceAt(resource.destination);
	const ids = [
		...new Set([...own.map((receipt) => receipt.workspaceId), ...at.map((workspace) => workspace.id)]),
	].sort();
	const selected: Proof[] = [];
	for (const id of ids) {
		const workspace = await api.workspace(id);
		if (workspace && workspace.id !== id) throw new Error("Paseo workspace identity changed");
		const receipt = own.find((item) => item.workspaceId === id) ?? {
			home: home ?? "",
			workspaceId: id,
			directory: resource.destination,
			projectId: workspace?.projectId ?? "",
			provenance: "opened" as const,
		};
		const reason = workspace ? blocker(workspace, resource, receipt) : undefined;
		if (reason) throw new Error(reason);
		await noUsers(api, id, resource.destination);
		selected.push({ api, receipt, workspace });
	}
	return selected;
}
/** Read every policy-independent blocker before offering a foreign-workspace override. */
async function commandProof(
	resource: CleanupResource,
	records: Recorded[],
	deps: CleanupPaseoDeps,
): Promise<CommandProof> {
	const found = receipts(records);
	const factory = deps.paseoApi ?? createPaseoApi;
	const homes = [...new Set(found.map((receipt) => receipt.home))];
	const selected: Proof[] = [];
	const unavailableHomes: string[] = [];
	for (const home of homes.length ? homes : [undefined]) {
		const api = factory(home);
		const state = await api.availability();
		if (state.state !== "available") {
			if (found.length || state.state === "ambiguous") throw new PaseoUnavailableError(state.reason);
			unavailableHomes.push(state.reason);
			continue;
		}
		selected.push(...(await commandHome(resource, found, api, home)));
	}
	const created = new Set(found.filter((receipt) => receipt.provenance === "created").map(key));
	const foreign = selected.filter((item) => item.workspace && !created.has(key(item.receipt)));
	if (foreign.length > 1)
		throw new Error("multiple foreign Paseo workspaces use this path; keep and resolve individually in Paseo");
	return {
		selected,
		preview: {
			binding: JSON.stringify({
				receipts: found,
				unavailableHomes,
				workspaces: selected.map(({ receipt, workspace }) => ({ receipt, workspace: stableWorkspace(workspace) })),
			}),
			workspace:
				stableWorkspace((foreign[0] ?? selected.find((item) => item.workspace))?.workspace ?? null) ?? undefined,
			archives: selected
				.filter((item) => item.workspace)
				.map(({ receipt }) => ({
					home: receipt.home,
					workspaceId: receipt.workspaceId,
				})),
			...(foreign[0] ? { foreignId: foreign[0].receipt.workspaceId } : {}),
		},
	};
}
export async function previewCleanupPaseo(
	resource: CleanupResource,
	records: Recorded[],
	deps: CleanupPaseoDeps,
): Promise<CleanupPaseoPreview> {
	return (await commandProof(resource, records, deps)).preview;
}
export type CleanupPaseoConfirmation = {
	preview: CleanupPaseoPreview;
	beforeArchive: () => void;
};
function failedPaseo(
	resource: CleanupResource,
	progress: Progress,
	error: unknown,
): { archived: boolean; outcome: CleanupOutcome } {
	if (error instanceof PaseoUnavailableError && !progress.dispatched) {
		const outcome = unverifiedPaseo(error, resource);
		outcome.remains.push(...[...progress.ids].map((id) => `paseo workspace: ${id}`));
		return { archived: false, outcome };
	}
	return {
		archived: progress.dispatched,
		outcome: {
			outcome: progress.dispatched ? "partial" : "kept",
			reason: `${(error as Error).message}${progress.dispatched ? "; archive may be incomplete; Git cleanup skipped" : ""}`,
			remains: [...cleanupRemains(resource), ...[...progress.ids].map((id) => `paseo workspace: ${id}`)],
		},
	};
}
/** Returns whether archive was dispatched, or an outcome that stops before Git mutation. */
export async function cleanupPaseo(
	resource: CleanupResource,
	records: Recorded[],
	deps: CleanupPaseoDeps,
	confirmed?: CleanupPaseoConfirmation,
): Promise<{
	archived: boolean;
	outcome?: CleanupOutcome;
}> {
	const progress: Progress = { dispatched: false, ids: new Set() };
	try {
		const found = receipts(records);
		for (const receipt of found) progress.ids.add(receipt.workspaceId);
		if (confirmed) {
			const checked = await commandProof(resource, records, deps);
			if (JSON.stringify(checked.preview) !== JSON.stringify(confirmed.preview)) throw new Error(CHANGED_CONFIRMATION);
			confirmed.beforeArchive();
			for (const { receipt } of checked.selected) progress.ids.add(receipt.workspaceId);
			await archive(checked.selected, resource.destination, progress);
			return { archived: progress.dispatched };
		}
		const factory = deps.paseoApi ?? createPaseoApi;
		if (found.length) await archive(await proofs(found, resource, factory), resource.destination, progress);
		else await legacyCheck(factory(), resource.destination, progress);
		return { archived: progress.dispatched };
	} catch (error) {
		return failedPaseo(resource, progress, error);
	}
}
