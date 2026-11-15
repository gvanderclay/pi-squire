// Interactive-only authority to discard unmerged commits or archive one foreign workspace.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type CleanupDeps, discover, kept, processGroup } from "./cleanup.ts";
import {
	CHANGED_CONFIRMATION,
	type CleanupGitPreview,
	type CleanupOutcome,
	type CleanupResource,
	cleanGit,
	inspectCleanupGit,
} from "./cleanup-git.ts";
import { type CleanupPaseoPreview, cleanupPaseo, previewCleanupPaseo } from "./cleanup-paseo.ts";
import { readIdentity } from "./identity.ts";
import { readTree } from "./tree-registry.ts";

export type CleanupPreview = {
	ids: string[];
	resource: CleanupResource;
	git: CleanupGitPreview;
	paseo: CleanupPaseoPreview;
	recordsBinding: string;
};
export type CleanupPreviewItem = { ids: string[]; preview?: CleanupPreview; outcome: CleanupOutcome };
/** Nonmutating command discovery uses the same authority, group limits, queue and live checks as all:true. */
export async function previewCleanup(deps: CleanupDeps, ctx: ExtensionContext): Promise<CleanupPreviewItem[]> {
	deps.assertActive();
	const actor = ctx.sessionManager.getSessionId();
	const root = readIdentity(actor)?.root ?? actor;
	const found = discover(readTree(root), actor);
	const items: CleanupPreviewItem[] = [];
	const start = Date.now();
	let processed = 0;
	for (const group of found.groups) {
		if (processed >= (deps.maxGroups ?? 50) || Date.now() - start >= (deps.maxMs ?? 120_000)) {
			items.push({
				ids: group.ids,
				outcome: kept("", "preview limit reached; run /delegate-cleanup again after resolving earlier items", group),
			});
			continue;
		}
		let preview: CleanupPreview | undefined;
		const result = await processGroup(group, deps, ctx, actor, root, undefined, async (current, liveCheck) => {
			const git = inspectCleanupGit(current.resource, liveCheck, deps);
			const paseo = await previewCleanupPaseo(current.resource, current.records, deps);
			preview = {
				ids: current.ids,
				resource: current.resource,
				git,
				paseo,
				recordsBinding: JSON.stringify(current.records),
			};
			return git.tip === null && !git.exists && !paseo.workspace
				? { outcome: "already-clean", reason: "worktree and branch already absent", remains: [] }
				: kept("", "not confirmed", current);
		});
		processed++;
		items.push({ ids: group.ids, preview, outcome: result });
	}
	return items;
}
/** Command-only entry: the complete proof is re-run against this exact preview, before any archive. */
export async function removeConfirmedCleanup(
	confirmed: CleanupPreview,
	deps: CleanupDeps,
	ctx: ExtensionContext,
): Promise<CleanupOutcome> {
	deps.assertActive();
	const actor = ctx.sessionManager.getSessionId();
	const root = readIdentity(actor)?.root ?? actor;
	let found: ReturnType<typeof discover>;
	try {
		found = discover(readTree(root), actor);
	} catch (error) {
		return kept("", `${CHANGED_CONFIRMATION} (${(error as Error).message})`);
	}
	const group = found.groups.find(
		(item) =>
			JSON.stringify(item.resource) === JSON.stringify(confirmed.resource) &&
			JSON.stringify(item.ids) === JSON.stringify(confirmed.ids),
	);
	if (!group) return kept("", CHANGED_CONFIRMATION);
	const result = await processGroup(group, deps, ctx, actor, root, undefined, async (current, liveCheck) => {
		if (JSON.stringify(current.records) !== confirmed.recordsBinding) throw new Error(CHANGED_CONFIRMATION);
		const checkGit = (): void => {
			try {
				if (JSON.stringify(inspectCleanupGit(current.resource, liveCheck, deps)) !== JSON.stringify(confirmed.git))
					throw new Error(CHANGED_CONFIRMATION);
			} catch (error) {
				throw new Error(`${CHANGED_CONFIRMATION} (${(error as Error).message})`);
			}
		};
		checkGit();
		const paseo = await cleanupPaseo(current.resource, current.records, deps, {
			preview: confirmed.paseo,
			beforeArchive: checkGit,
		});
		if (paseo.outcome) return paseo.outcome;
		const outcome = cleanGit(current.resource, liveCheck, deps, confirmed.git);
		if (paseo.archived) {
			outcome.reason = outcome.reason.replace(CHANGED_CONFIRMATION, "changed after archive; Git cleanup skipped");
			if (outcome.outcome === "kept") outcome.outcome = "partial";
			if (outcome.outcome === "already-clean") outcome.outcome = "removed";
			outcome.reason += "; Paseo workspace archived";
		}
		return outcome;
	});
	if (result.outcome === "kept" && !result.reason.includes(CHANGED_CONFIRMATION))
		result.reason = `${CHANGED_CONFIRMATION} (${result.reason})`;
	return result;
}

const DIALOG = { timeout: 60_000 };
const SCHEDULE_WARNING =
	"Paseo schedules are not checked; a schedule aimed at an archived workspace fails on its next run.";
function details(item: CleanupPreview): string {
	const git = item.git;
	const workspace = item.paseo.workspace;
	return [
		`${item.ids.join(", ")}: ${git.worktree}`,
		`branch: refs/heads/${item.resource.branch}; tip: ${git.tip ?? "(absent)"}; ignored entries deleted: ${git.ignored.total}`,
		...(git.merge !== "merged"
			? [
					`upstream: ${git.upstream || "(none)"} ${git.upstreamTrack}; unique commits: ${git.uniqueCommits} vs ${git.target}`,
				]
			: []),
		...(workspace
			? [
					`Paseo workspace: ${workspace.id}; title: ${workspace.title ?? workspace.name ?? "(untitled)"}; created: ${workspace.createdAt ?? "(unknown)"}`,
				]
			: []),
		...(item.paseo.foreignId ? ["Squire did not create this workspace."] : []),
	].join("\n");
}
function report(ctx: ExtensionContext, ids: string[], outcome: CleanupPreviewItem["outcome"]): void {
	ctx.ui.notify(
		`${ids.join(", ")}: ${outcome.outcome} — ${outcome.reason}${
			outcome.ignoredRemoved ? `; ${outcome.ignoredRemoved.total} ignored entries removed` : ""
		}${outcome.remains.length ? `; remains: ${outcome.remains.join(", ")}` : ""}`,
		outcome.outcome === "partial" ? "warning" : "info",
	);
}
async function applySelection(
	selected: CleanupPreview[],
	title: string,
	deps: CleanupDeps,
	ctx: ExtensionContext,
): Promise<void> {
	if (!selected.length) return;
	const yes = await ctx.ui.confirm(
		title,
		`${selected.map(details).join("\n\n")}\n\nIgnored files in these worktrees are deleted too. ${SCHEDULE_WARNING}`,
		DIALOG,
	);
	for (const item of selected) await applyAnswer(item, yes, deps, ctx);
}
async function applyAnswer(
	item: CleanupPreview,
	yes: boolean,
	deps: CleanupDeps,
	ctx: ExtensionContext,
): Promise<void> {
	if (yes) report(ctx, item.ids, await removeConfirmedCleanup(item, deps, ctx));
	else ctx.ui.notify(`${item.ids.join(", ")}: kept — declined, canceled or timed out`, "info");
}
async function chooseOverrides(overrides: CleanupPreview[], deps: CleanupDeps, ctx: ExtensionContext): Promise<void> {
	while (overrides.length) {
		const labels = overrides.map(
			(item) =>
				`${item.ids.join(", ")} — ${item.resource.branch}${item.paseo.foreignId ? "; foreign Paseo workspace" : "; unmerged"}`,
		);
		const picked = await ctx.ui.select("Kept items: choose one override, or Done", [...labels, "Done"], DIALOG);
		const index = picked === undefined ? -1 : labels.indexOf(picked);
		if (index < 0) break;
		const item = overrides.splice(index, 1)[0];
		if (!item) break;
		const yes = await ctx.ui.confirm(
			"Discard this worktree and local branch?",
			`${details(item)}\n\n${item.git.merge !== "merged" ? "Merge is not proved. Unique commits on this local branch may be lost. " : ""}Ignored files are deleted too. Remote branches are never touched. ${SCHEDULE_WARNING}`,
			DIALOG,
		);
		await applyAnswer(item, yes, deps, ctx);
	}
	for (const item of overrides) ctx.ui.notify(`${item.ids.join(", ")}: kept — not confirmed`, "info");
}
/** No model message/turn: every result, including a canceled confirmation, stays in the UI. */
export async function cleanupCommand(deps: CleanupDeps, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("delegate-cleanup needs an interactive session", "warning");
		return;
	}
	try {
		const items = await previewCleanup(deps, ctx).catch((error: unknown) => {
			throw new Error(`preview failed; nothing removed: ${(error as Error).message}`);
		});
		if (!items.length) {
			ctx.ui.notify("No Squire-created worktrees selected.", "info");
			return;
		}
		const available: CleanupPreview[] = [];
		for (const item of items) {
			if (item.preview && item.outcome.outcome !== "already-clean") available.push(item.preview);
			else report(ctx, item.ids, item.outcome);
		}
		const safe = available.filter((item) => item.git.merge === "merged" && !item.paseo.foreignId);
		const gone = available.filter((item) => item.git.merge === "gone" && !item.paseo.foreignId);
		await applySelection(safe, `Remove ${safe.length} proven-safe items?`, deps, ctx);
		await applySelection(
			gone,
			`Remove ${gone.length} items whose upstream branch was deleted? Merge is not proved.`,
			deps,
			ctx,
		);
		await chooseOverrides(
			available.filter((item) => item.git.merge === "unmerged" || item.paseo.foreignId),
			deps,
			ctx,
		);
	} catch (error) {
		ctx.ui.notify(`delegate-cleanup: ${(error as Error).message}`, "error");
	}
}
