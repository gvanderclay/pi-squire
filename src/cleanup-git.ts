// Cleanup re-derives ownership and merge evidence from Git; never force a refusal.
import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, type Stats } from "node:fs";
import { join, resolve } from "node:path";
import { askGit, fields, type GitAnswer, inspectGit, onePath, type PathSummary, summarize } from "./git.ts";
import { canonical, registered, type WorktreePlan } from "./worktree.ts";

export type CleanupResource = Pick<WorktreePlan, "source" | "destination" | "branch" | "baseCommit">;
export type CleanupOutcome = {
	outcome: "removed" | "kept" | "partial" | "already-clean";
	reason: string;
	remains: string[];
	ignoredRemoved?: Pick<PathSummary, "total" | "paths">;
};
export type GhRunner = (cwd: string, args: string[]) => { ok: true; out: string } | { ok: false; message: string };
export type CleanupGitDeps = {
	gh?: GhRunner;
	git?: typeof askGit;
	walk?: WalkOptions;
	/** Tests interpose competing Git operations without ever addressing the real repository. */
	beforeRemove?: () => void;
	afterRemove?: () => void;
};
type Identity = { exists: boolean; tip: string | null };
type WalkStat = Pick<Stats, "dev" | "isDirectory">;
export type WalkOptions = { maxDirectories?: number; maxMs?: number; lstat?: (path: string) => WalkStat };
const MUTATE = { timeout: 120_000, maxBuffer: 1024 * 1024 };
const OBSERVE = { timeout: 5000, maxBuffer: 16 * 1024 * 1024 };
const exists = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false }) !== undefined;
const ref = (resource: CleanupResource): string => `refs/heads/${resource.branch}`;
function git(cwd: string, args: string[]): string {
	const answer: GitAnswer = askGit(cwd, args, OBSERVE);
	if (!answer.ok) throw new Error(`git ${args[0]} failed: ${answer.message}`);
	return answer.out;
}
function tipAt(resource: CleanupResource): string | null {
	const cwd: string = resource.source.mainRoot;
	if (askGit(cwd, ["symbolic-ref", "-q", ref(resource)]).ok)
		throw new Error("branch ref is symbolic; kept without following it");
	const answer: GitAnswer = askGit(cwd, ["show-ref", "--verify", "--hash", ref(resource)]);
	if (answer.ok) return onePath(answer.out);
	if (answer.status === 1) return null;
	// show-ref --verify returns 128 for a missing ref in some Git versions.
	const missing: GitAnswer = askGit(cwd, ["rev-parse", "--verify", "--quiet", ref(resource)]);
	if (!missing.ok && missing.status === 1) return null;
	throw new Error(`could not read branch: ${answer.message}`);
}

/** Directory, branch and registration must still name the recorded creation. */
export function cleanupIdentity(resource: CleanupResource): Identity {
	const { source, destination, branch } = resource;
	const main = inspectGit(source.mainRoot);
	if (main.kind !== "git" || main.identity.commonDir !== source.commonDir)
		throw new Error("replaced source checkout; repository identity not proved");
	const entries = registered(source.mainRoot);
	const users = entries.filter((entry) => entry.branch === ref(resource));
	const own = entries.filter((entry) => canonical(entry.path) === destination);
	const present: boolean = exists(destination);
	const tip: string | null = tipAt(resource);
	if (!present && own.length === 0) {
		if (users.length) throw new Error("branch checked out elsewhere");
		return { exists: false, tip };
	}
	if (own.length !== 1 || own[0].locked || own[0].prunable)
		throw new Error("worktree unregistered, locked or prunable");
	if (users.length !== 1 || canonical(users[0].path) !== destination) throw new Error("branch checked out elsewhere");
	const now = inspectGit(destination);
	if (
		now.kind !== "git" ||
		now.identity.checkoutRoot !== destination ||
		now.identity.commonDir !== source.commonDir ||
		now.position.branch !== branch ||
		onePath(git(destination, ["symbolic-ref", "HEAD"])) !== ref(resource) ||
		now.head !== tip
	)
		throw new Error("replaced checkout; path, repository or branch differs");
	return { exists: true, tip };
}

const STATE_FILES: readonly string[] = [
	"MERGE_HEAD",
	"CHERRY_PICK_HEAD",
	"REVERT_HEAD",
	"BISECT_LOG",
	"rebase-merge",
	"rebase-apply",
];
/** Fast cleanliness check repeated in the synchronous mutation boundary. */
export function cleanupClean(cwd: string): void {
	if (git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"]) !== "")
		throw new Error("uncommitted or untracked changes");
	for (const name of STATE_FILES) {
		if (exists(resolve(cwd, onePath(git(cwd, ["rev-parse", "--git-path", name])))))
			throw new Error(`Git operation in progress: ${name}`);
	}
}

function ignoredChildren(path: string, device: number, stat: (path: string) => WalkStat): string[] {
	if (stat(path).dev !== device) throw new Error("ignored directory is on a different filesystem");
	const entries: string[] = readdirSync(path);
	if (entries.includes(".git")) throw new Error("nested repository in ignored content");
	return entries.map((entry) => join(path, entry));
}
/** Walk directories only, never symlinks; ignored files are intentionally removed with the checkout. */
export function checkIgnored(cwd: string, paths: string[], options: WalkOptions = {}): void {
	const stat: (path: string) => WalkStat = options.lstat ?? lstatSync;
	const device = stat(cwd).dev;
	const pending: string[] = paths.map((path) => join(cwd, path.replace(/\/$/, "")));
	const seen: Set<string> = new Set();
	const start: number = Date.now();
	const maxMs: number = options.maxMs ?? 10_000;
	const maxDirectories: number = options.maxDirectories ?? 200_000;
	while (pending.length) {
		if (Date.now() - start > maxMs) throw new Error("ignored content too large to check");
		const path = pending.pop();
		if (path === undefined) break;
		if (seen.has(path)) continue;
		if (!stat(path).isDirectory()) continue;
		seen.add(path);
		if (seen.size > maxDirectories) throw new Error("ignored content too large to check");
		pending.push(...ignoredChildren(path, device, stat));
	}
}
function ignored(resource: CleanupResource, options?: WalkOptions): PathSummary {
	const cwd: string = resource.destination;
	if (fields(git(cwd, ["ls-files", "--stage", "-z"])).some((entry) => entry.startsWith("160000 ")))
		throw new Error("gitlink in index");
	const paths: string[] = fields(
		git(cwd, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]),
	);
	checkIgnored(cwd, paths, options);
	return summarize(paths);
}

/** Bounded argv-only gh query. Failure is absence of proof, never permission to remove. */
export const runGh: GhRunner = (cwd: string, args: string[]) => {
	const result = spawnSync("gh", args, {
		cwd,
		timeout: 15_000,
		maxBuffer: 1024 * 1024,
		killSignal: "SIGKILL",
		encoding: "utf8",
	});
	if (result.error || result.status !== 0) return { ok: false, message: result.error?.message ?? result.stderr.trim() };
	return { ok: true, out: result.stdout };
};
type Target = { ref: string; name: string };
function targets(resource: CleanupResource): Target[] {
	const cwd: string = resource.source.mainRoot;
	const branch: GitAnswer = askGit(cwd, ["symbolic-ref", "-q", "HEAD"]);
	const refs: string[] = [];
	if (branch.ok && onePath(branch.out) !== ref(resource)) {
		refs.push(onePath(branch.out));
		const upstream: GitAnswer = askGit(cwd, ["rev-parse", "--symbolic-full-name", `${onePath(branch.out)}@{upstream}`]);
		if (upstream.ok) refs.push(onePath(upstream.out));
	}
	if (askGit(cwd, ["rev-parse", "--verify", "refs/remotes/origin/HEAD"]).ok) refs.push("refs/remotes/origin/HEAD");
	return refs.map((target) => {
		const resolved: GitAnswer = askGit(cwd, ["symbolic-ref", "-q", target]);
		const full: string = resolved.ok ? onePath(resolved.out) : target;
		return { ref: target, name: full.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\/[^/]+\//, "") };
	});
}
const ancestor = (cwd: string, tip: string, target: string): boolean =>
	askGit(cwd, ["merge-base", "--is-ancestor", tip, target]).ok;
type Pull = { headRefOid?: string; baseRefName?: string; mergeCommit?: { oid?: string }; isCrossRepository?: boolean };
function squash(resource: CleanupResource, tip: string, local: Target[], run: GhRunner): string | undefined {
	const answer = run(resource.source.mainRoot, [
		"pr",
		"list",
		"--state",
		"merged",
		"--head",
		resource.branch,
		"--limit",
		"20",
		"--json",
		"headRefOid,baseRefName,mergeCommit,isCrossRepository,url",
	]);
	if (!answer.ok) return answer.message || "gh unavailable";
	let pulls: Pull[];
	try {
		const value: unknown = JSON.parse(answer.out);
		if (!Array.isArray(value)) return "invalid gh response";
		pulls = value;
	} catch {
		return "invalid gh response";
	}
	if (pulls.length >= 20) return "gh result limit reached";
	const matches: boolean = pulls.some(
		(pr) =>
			pr &&
			pr.headRefOid === tip &&
			pr.isCrossRepository === false &&
			typeof pr.mergeCommit?.oid === "string" &&
			/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(pr.mergeCommit.oid) &&
			local.some(
				(target) =>
					target.name === pr.baseRefName && ancestor(resource.source.mainRoot, pr.mergeCommit?.oid ?? "", target.ref),
			),
	);
	return matches ? undefined : "no exact local squash evidence";
}
export function proveMerged(resource: CleanupResource, tip: string, run: GhRunner = runGh): void {
	if (tip === resource.baseCommit) return;
	const local: Target[] = targets(resource);
	if (local.some((target) => ancestor(resource.source.mainRoot, tip, target.ref))) return;
	const why: string | undefined = squash(resource, tip, local, run);
	if (why === undefined) return;
	const track: string = git(resource.source.mainRoot, [
		"for-each-ref",
		"--format=%(upstream:track)",
		ref(resource),
	]).trim();
	if (track === "[gone]") throw new Error("upstream branch deleted but merge not proved; fetch and retry");
	throw new Error(`merge not proved (${why}); fetch and retry`);
}
/** Omit a branch only when Git proves it absent; a failed observation is not absence. */
export function cleanupRemains(resource: CleanupResource): string[] {
	const left: string[] = [];
	let listed = false;
	try {
		listed = registered(resource.source.mainRoot).some((entry) => canonical(entry.path) === resource.destination);
	} catch {
		// The directory can still be observed independently of Git registration.
	}
	if (exists(resource.destination) || listed) left.push(`worktree: ${resource.destination}`);
	try {
		if (tipAt(resource) !== null) left.push(`branch: ${ref(resource)}`);
	} catch {
		left.push(`branch: ${ref(resource)}`);
	}
	return left;
}
function outcome(resource: CleanupResource, changed: boolean, reason: string, summary?: PathSummary): CleanupOutcome {
	const left: string[] = cleanupRemains(resource);
	return {
		outcome: changed ? "partial" : "kept",
		reason,
		remains: left,
		...(changed && summary ? { ignoredRemoved: { total: summary.total, paths: summary.paths } } : {}),
	};
}
function deleteBranch(resource: CleanupResource, tip: string, deps: CleanupGitDeps): void {
	if (registered(resource.source.mainRoot).some((entry) => entry.branch === ref(resource)))
		throw new Error("branch recreated in a worktree after removal; branch kept (cross-process launch race)");
	const answer: GitAnswer = (deps.git ?? askGit)(
		resource.source.mainRoot,
		["update-ref", "--no-deref", "-d", ref(resource), tip],
		MUTATE,
	);
	if (!answer.ok) throw new Error(`branch delete refused: ${answer.message}`);
}
function removalFailure(
	resource: CleanupResource,
	answer: Extract<GitAnswer, { ok: false }>,
	directoryGone: boolean,
	summary?: PathSummary,
): CleanupOutcome {
	const cleanRefusal: boolean =
		answer.status === 128 &&
		answer.message ===
			`fatal: '${resource.destination}' contains modified or untracked files, use --force to delete it`;
	// Only Git's clean refusal proves no deletion; timeouts/IO errors may leave a partial directory.
	return outcome(
		resource,
		directoryGone || !cleanRefusal,
		`git worktree remove ${cleanRefusal ? "refused" : "failed; removal may be incomplete"}: ${answer.message}`,
		directoryGone ? summary : undefined,
	);
}
/** Shared nonmutating proof; the final runner repeats it after asynchronous host operations. */
function proof(
	resource: CleanupResource,
	liveCheck: () => void,
	deps: CleanupGitDeps,
): {
	before: Identity;
	summary?: PathSummary;
} {
	const before: Identity = cleanupIdentity(resource);
	if (!before.exists && before.tip === null) return { before };
	liveCheck();
	let summary: PathSummary | undefined;
	if (before.exists) {
		cleanupClean(resource.destination);
		summary = ignored(resource, deps.walk);
	}
	if (before.tip === null) throw new Error("branch tip not proved");
	proveMerged(resource, before.tip, deps.gh);
	return { before, summary };
}
/** A kept/already-clean result, or undefined when Git permits cleanup. Never mutates. */
export function previewCleanupGit(
	resource: CleanupResource,
	liveCheck: () => void,
	deps: CleanupGitDeps = {},
): CleanupOutcome | undefined {
	try {
		const { before } = proof(resource, liveCheck, deps);
		if (!before.exists && before.tip === null)
			return { outcome: "already-clean", reason: "worktree and branch already absent", remains: [] };
		return undefined;
	} catch (error) {
		return outcome(resource, false, (error as Error).message);
	}
}
/** No awaits from final identity/live/clean proof through removal and compare-and-swap deletion. */
export function cleanGit(resource: CleanupResource, liveCheck: () => void, deps: CleanupGitDeps = {}): CleanupOutcome {
	let changed = false;
	let summary: PathSummary | undefined;
	try {
		const checked = proof(resource, liveCheck, deps);
		const before: Identity = checked.before;
		summary = checked.summary;
		if (!before.exists && before.tip === null)
			return { outcome: "already-clean", reason: "worktree and branch already absent", remains: [] };
		if (before.tip === null) throw new Error("branch tip not proved");
		deps.beforeRemove?.();
		const final: Identity = cleanupIdentity(resource);
		if (final.tip !== before.tip || final.exists !== before.exists)
			throw new Error("checkout changed since proof; nothing removed");
		liveCheck();
		if (final.exists) {
			cleanupClean(resource.destination);
			const answer: GitAnswer = (deps.git ?? askGit)(
				resource.source.mainRoot,
				["worktree", "remove", resource.destination],
				MUTATE,
			);
			changed = !exists(resource.destination);
			if (!answer.ok) return removalFailure(resource, answer, changed, summary);
			changed = true;
			deps.afterRemove?.();
		}
		deleteBranch(resource, before.tip, deps);
		changed = true;
		const left: string[] = cleanupRemains(resource);
		if (left.length) return outcome(resource, true, "resources remain after removal", summary);
		return {
			outcome: "removed",
			reason: "merged, unused and clean",
			remains: [],
			...(summary ? { ignoredRemoved: { total: summary.total, paths: summary.paths } } : {}),
		};
	} catch (error) {
		return outcome(resource, changed, String((error as Error).message), summary);
	}
}
