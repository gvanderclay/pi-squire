// Async Paseo preflight and archive; Git is synchronously re-proved after this returns.
import type { PaseoWorkspace } from "@getpaseo/client";
import { type CleanupOutcome, type CleanupResource, cleanupRemains } from "./cleanup-git.ts";
import { createPaseoApi, type PaseoApi } from "./paseo-api.ts";
import { isStarted, type Recorded } from "./result-types.ts";
import { canonical, type PaseoReceipt } from "./worktree.ts";

export type CleanupPaseoDeps = { paseoApi?: (home?: string) => PaseoApi };
type Proof = { api: PaseoApi; receipt: PaseoReceipt; workspace: PaseoWorkspace | null };
type Progress = { dispatched: boolean; ids: Set<string> };
const FOREIGN = "Paseo workspace not created by Squire; kept";
const key = (receipt: PaseoReceipt): string => JSON.stringify([receipt.home, receipt.workspaceId]);
function receipts(records: Recorded[]): PaseoReceipt[] {
	return records.flatMap((record) =>
		isStarted(record) && record.workspace?.mode === "managed" && record.workspace.paseo ? [record.workspace.paseo] : [],
	);
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
	// unavailable checks the pid file before any dynamic SDK import.
	if (await api.unavailable()) return;
	const workspaces = await api.workspaceAt(dir);
	for (const workspace of workspaces) progress.ids.add(workspace.id);
	if (workspaces.length) throw new Error(FOREIGN);
}
async function proofs(
	found: PaseoReceipt[],
	resource: CleanupResource,
	factory: (home?: string) => PaseoApi,
): Promise<Proof[]> {
	const created = new Set(found.filter((receipt) => receipt.provenance === "created").map(key));
	if (found.some((receipt) => !created.has(key(receipt)))) throw new Error(FOREIGN);
	const selected: Map<string, Proof> = new Map();
	for (const receipt of found) {
		if (selected.has(key(receipt))) continue;
		const api = factory(receipt.home);
		const unavailable = await api.unavailable();
		if (unavailable) throw new Error(unavailable);
		const workspace = await api.workspace(receipt.workspaceId);
		const reason = workspace ? blocker(workspace, resource, receipt) : undefined;
		if (reason) throw new Error(reason);
		await noUsers(api, receipt.workspaceId, resource.destination);
		// A foreign workspace at the same path would be stranded by Git removal.
		const others = await api.workspaceAt(resource.destination);
		if (others.some((other) => !created.has(key({ ...receipt, workspaceId: other.id })))) throw new Error(FOREIGN);
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
/** Returns whether archive was dispatched, or an outcome that stops before Git mutation. */
export async function cleanupPaseo(
	resource: CleanupResource,
	records: Recorded[],
	deps: CleanupPaseoDeps,
): Promise<{
	archived: boolean;
	outcome?: CleanupOutcome;
}> {
	const found = receipts(records);
	const progress: Progress = { dispatched: false, ids: new Set(found.map((receipt) => receipt.workspaceId)) };
	try {
		const factory = deps.paseoApi ?? createPaseoApi;
		if (found.length) await archive(await proofs(found, resource, factory), resource.destination, progress);
		else await legacyCheck(factory(), resource.destination, progress);
		return { archived: progress.dispatched };
	} catch (error) {
		return {
			archived: progress.dispatched,
			outcome: {
				outcome: progress.dispatched ? "partial" : "kept",
				reason: `${(error as Error).message}${progress.dispatched ? "; archive may be incomplete; Git cleanup skipped" : ""}`,
				remains: [...cleanupRemains(resource), ...[...progress.ids].map((id) => `paseo workspace: ${id}`)],
			},
		};
	}
}
