// Managed worktrees: the nonmutating plan for a new branch's checkout, its
// creation, and the conservative rollback of a launch that failed before its
// window opened. Ownership is proved from Git and the disk for every
// removal; anything uncertain is retained and described, never forced.
import { lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	askGit,
	fields,
	type GitAnswer,
	type GitIdentity,
	type GitLaunch,
	inspectGit,
	onePath,
	type PathSummary,
	pendingPaths,
	summarize,
} from "./git.ts";
import type { ResourceFacts } from "./results.ts";

export type WorktreeOptions = { worktree: string };
/** What a managed launch intends, frozen before anything is created. */
export type WorktreePlan = {
	sourceCwd: string;
	source: GitIdentity;
	destination: string;
	branch: string;
	requestedBase: string;
	baseCommit: string;
	sourceDirty: PathSummary;
	trusted: boolean;
};
/** A created worktree, as the delegate's workspace. */
export type ManagedWorkspace = {
	mode: "managed";
	cwd: string;
	git: Extract<GitLaunch, { kind: "git" }>;
	sourceCwd: string;
	source: GitIdentity;
	createdBranch: string;
	requestedBase: string;
	baseCommit: string;
	sourceDirty: PathSummary;
};

/** Long enough for a large checkout, still bounded; a killed call's leftovers are observed, not assumed. */
const MUTATE = { timeout: 120_000, maxBuffer: 1024 * 1024 };
const OBSERVE = { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 };
/** The most files rollback will compare with the index before it gives up and retains. */
const WALK_LIMIT = 200_000;

/** The stdout of a Git call that must succeed. */
function must(cwd: string, args: string[], limits = OBSERVE): string {
	const answer: GitAnswer = askGit(cwd, args, limits);
	if (!answer.ok) throw new Error(`git ${args[0]} failed: ${answer.message}`);
	return answer.out;
}

/** One registered checkout, as `git worktree list --porcelain -z` reports it. */
type Registered = { path: string; head?: string; branch?: string; locked: boolean; prunable: boolean };

function applyRegistration(
	line: string,
	current: Registered | undefined,
	entries: Registered[],
): Registered | undefined {
	if (line === "") return undefined;
	if (line.startsWith("worktree ")) {
		const next = { path: line.slice("worktree ".length), locked: false, prunable: false };
		entries.push(next);
		return next;
	}
	if (current === undefined) return current;
	if (line.startsWith("HEAD ")) current.head = line.slice(5);
	else if (line.startsWith("branch ")) current.branch = line.slice(7);
	else if (line === "locked" || line.startsWith("locked ")) current.locked = true;
	else if (line === "prunable" || line.startsWith("prunable ")) current.prunable = true;
	return current;
}

function registered(cwd: string): Registered[] {
	const entries: Registered[] = [];
	let current: Registered | undefined;
	for (const line of must(cwd, ["worktree", "list", "--porcelain", "-z"]).split("\0"))
		current = applyRegistration(line, current, entries);
	return entries;
}

const exists = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false }) !== undefined;

/** `path` with its deepest existing ancestor resolved through symlinks; the rest stays as written. */
function canonical(path: string): string {
	const rest: string[] = [];
	let current = resolve(path);
	while (!exists(current) && dirname(current) !== current) {
		rest.unshift(basename(current));
		current = dirname(current);
	}
	return join(realpathSync(current), ...rest);
}

const inside = (path: string, root: string): boolean => path === root || path.startsWith(`${root}${sep}`);

/** Refuse a destination that exists, is registered with Git, or lies in Git's own administrative data. */
function checkDestination(destination: string, identity: GitIdentity): void {
	if (exists(destination)) throw new Error(`the worktree destination ${destination} already exists`);
	if (canonical(destination) !== destination) {
		throw new Error(`the worktree destination ${destination} is not its canonical path`);
	}
	if (inside(destination, identity.commonDir) || destination.split(sep).includes(".git")) {
		throw new Error(`the worktree destination ${destination} is inside Git's administrative data`);
	}
	for (const entry of registered(identity.checkoutRoot)) {
		if (canonical(entry.path) === destination) {
			throw new Error(`the worktree destination ${destination} is already registered with Git as a worktree`);
		}
	}
}

const branchRef = (branch: string): string => `refs/heads/${branch}`;

/** The commit a local ref names, or null when it does not exist. */
function refTarget(cwd: string, ref: string): string | null {
	const answer = askGit(cwd, ["rev-parse", "--verify", "--quiet", ref]);
	if (answer.ok) return onePath(answer.out);
	if (answer.status === 1) return null;
	throw new Error(`git rev-parse failed: ${answer.message}`);
}

/** Refuse a branch name Git would expand or reject, or that already exists locally. */
function checkBranch(identity: GitIdentity, branch: string): void {
	const answer = askGit(identity.checkoutRoot, ["check-ref-format", "--branch", branch]);
	// `--branch` expands checkout-history shorthand such as `@{-1}`; only a literal name is accepted.
	if (!answer.ok || onePath(answer.out) !== branch || branch === "HEAD") {
		throw new Error(`worktree ${JSON.stringify(branch)} is not a valid new local branch name`);
	}
	if (refTarget(identity.checkoutRoot, branchRef(branch)) !== null) {
		throw new Error(`the local branch ${branch} already exists; worktree creates a new branch and never reuses one`);
	}
}

/** The source's staged, unstaged and untracked paths, read without writing its index. */
function dirtyPaths(identity: GitIdentity): PathSummary {
	const out = must(identity.checkoutRoot, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
	const pending = pendingPaths(out);
	return summarize([...new Set([...pending.staged, ...pending.unstaged, ...pending.untracked, ...pending.conflicted])]);
}

/** `{repoParent}/{repo}-worktrees/{branch}`, the branch's slashes mapped to `-` in the folder only. */
function placement(identity: GitIdentity, branch: string): string {
	const folder = `${basename(identity.mainRoot)}-worktrees`;
	return canonical(join(dirname(identity.mainRoot), folder, branch.replaceAll("/", "-")));
}

/**
 * Plan a new branch's checkout from the parent's checkout: validate the
 * branch, source, destination and base, and freeze the source's committed
 * `HEAD`. Changes nothing. A same-repository creation uses the parent's
 * current project trust.
 */
export async function prepareWorktree(
	options: WorktreeOptions,
	ctx: ExtensionContext,
	_agentDir: string,
): Promise<WorktreePlan> {
	const found = inspectGit(ctx.cwd);
	if (found.kind === "non-git") throw new Error(`worktree needs a Git checkout, and ${ctx.cwd} is not one`);
	if (found.kind === "unknown") throw new Error(`worktree needs a usable Git checkout: ${found.reason}`);
	if (found.head === null) {
		throw new Error(
			`the checkout ${found.identity.checkoutRoot} has no commit yet, so there is no HEAD to branch from`,
		);
	}
	const { identity } = found;
	checkBranch(identity, options.worktree);
	const destination = placement(identity, options.worktree);
	checkDestination(destination, identity);
	return {
		sourceCwd: ctx.cwd,
		source: identity,
		destination,
		branch: options.worktree,
		requestedBase: "HEAD",
		baseCommit: found.head,
		sourceDirty: dirtyPaths(identity),
		trusted: ctx.isProjectTrusted(),
	};
}

/** Recheck, inside the queue, the facts the plan depends on; a changed one invalidates the plan. */
export function revalidate(plan: WorktreePlan): void {
	const now = inspectGit(plan.sourceCwd);
	const same =
		now.kind === "git" &&
		now.identity.checkoutRoot === plan.source.checkoutRoot &&
		now.identity.commonDir === plan.source.commonDir &&
		now.identity.mainRoot === plan.source.mainRoot;
	if (!same)
		throw new Error(`the source checkout ${plan.sourceCwd} is no longer the one that was planned; delegate again`);
	checkBranch(plan.source, plan.branch);
	checkDestination(plan.destination, plan.source);
	const commit = askGit(plan.source.checkoutRoot, ["cat-file", "-e", `${plan.baseCommit}^{commit}`]);
	if (!commit.ok) throw new Error(`the frozen base commit ${plan.baseCommit} is no longer usable: ${commit.message}`);
}

/** Prove the created checkout is what the plan describes; throws the first mismatch. */
function verify(plan: WorktreePlan): ManagedWorkspace {
	const cwd = realpathSync(plan.destination);
	const top = realpathSync(onePath(must(cwd, ["rev-parse", "--show-toplevel"])));
	const common = realpathSync(resolve(cwd, onePath(must(cwd, ["rev-parse", "--git-common-dir"]))));
	if (top !== cwd || common !== plan.source.commonDir) {
		throw new Error(`${cwd} is checkout ${top} of ${common}, not the planned worktree of ${plan.source.commonDir}`);
	}
	const ref = branchRef(plan.branch);
	if (onePath(must(cwd, ["symbolic-ref", "HEAD"])) !== ref) throw new Error(`${cwd} is not on ${plan.branch}`);
	if (onePath(must(cwd, ["rev-parse", "--verify", "HEAD^{commit}"])) !== plan.baseCommit) {
		throw new Error(`${cwd} is not at the frozen base ${plan.baseCommit}`);
	}
	if (refTarget(cwd, ref) !== plan.baseCommit)
		throw new Error(`${plan.branch} is not at the frozen base ${plan.baseCommit}`);
	const users = registered(cwd).filter((entry) => entry.branch === ref);
	if (users.length !== 1 || canonical(users[0].path) !== cwd) {
		throw new Error(`${plan.branch} is checked out in ${users.length} registered worktrees, not only ${cwd}`);
	}
	return {
		mode: "managed",
		cwd,
		git: {
			kind: "git",
			identity: { mainRoot: plan.source.mainRoot, commonDir: plan.source.commonDir, checkoutRoot: cwd },
			position: { branch: plan.branch, detached: false },
			head: plan.baseCommit,
			baseline: plan.baseCommit,
		},
		sourceCwd: plan.sourceCwd,
		source: plan.source,
		createdBranch: plan.branch,
		requestedBase: plan.requestedBase,
		baseCommit: plan.baseCommit,
		sourceDirty: plan.sourceDirty,
	};
}

/** Whether anything of the plan exists now: a checkout at or registered for the destination, and the branch's commit. */
function observe(plan: WorktreePlan): { registered: boolean; pathExists: boolean; target: string | null } {
	const target = refTarget(plan.source.checkoutRoot, branchRef(plan.branch));
	const listed = registered(plan.source.checkoutRoot).some((entry) => canonical(entry.path) === plan.destination);
	return { registered: listed, pathExists: exists(plan.destination), target };
}

/** What of the plan exists now, as facts: the checkout and branch, the branch alone, or nothing. */
function remnants(plan: WorktreePlan): ResourceFacts {
	try {
		const { registered: checkoutRegistered, pathExists, target } = observe(plan);
		if (checkoutRegistered && target !== null)
			return { kind: "worktree", cwd: plan.destination, branch: plan.branch, head: target };
		if (pathExists)
			return unknown(
				plan,
				"a destination exists but is not verified as this worktree",
				[plan.destination],
				target === null ? [] : [branchRef(plan.branch)],
			);
		return target === null ? { kind: "none" } : { kind: "branch", branch: plan.branch, head: target };
	} catch (err) {
		return unknown(
			plan,
			`could not observe what exists: ${(err as Error).message}`,
			[plan.destination],
			[branchRef(plan.branch)],
		);
	}
}

const unknown = (
	plan: WorktreePlan,
	reason: string,
	observedPaths: string[],
	observedRefs: string[],
): ResourceFacts => ({
	kind: "unknown",
	reason: `${reason} (planned ${plan.destination} and ${branchRef(plan.branch)})`,
	observedPaths,
	observedRefs,
});

export type Creation = { workspace: ManagedWorkspace } | { cause: string; resources: ResourceFacts };

/**
 * Create the branch and checkout at the frozen commit. Ownership is proved
 * only by a successful `worktree add` whose result matches the plan; after a
 * failure, anything found at the planned names cannot be shown to be this
 * call's, because another process may have created it.
 */
export function createWorktree(plan: WorktreePlan): Creation {
	let failure: string | undefined;
	try {
		mkdirSync(dirname(plan.destination), { recursive: true });
		const added = askGit(
			plan.source.checkoutRoot,
			["worktree", "add", "-b", plan.branch, plan.destination, plan.baseCommit],
			MUTATE,
		);
		if (!added.ok) failure = `git worktree add failed: ${added.message}`;
	} catch (err) {
		failure = (err as Error).message;
	}
	if (failure === undefined) {
		try {
			return { workspace: verify(plan) };
		} catch (err) {
			failure = `the created worktree could not be verified: ${(err as Error).message}`;
		}
	}
	try {
		const { registered: checkoutRegistered, pathExists, target } = observe(plan);
		if (!checkoutRegistered && !pathExists && target === null) return { cause: failure, resources: { kind: "none" } };
		const reason = "something exists at the planned names, and this call cannot prove it created it";
		return {
			cause: failure,
			resources: unknown(
				plan,
				reason,
				pathExists || checkoutRegistered ? [plan.destination] : [],
				target === null ? [] : [branchRef(plan.branch)],
			),
		};
	} catch (err) {
		const reason = `could not observe what exists: ${(err as Error).message}`;
		return { cause: failure, resources: unknown(plan, reason, [plan.destination], [branchRef(plan.branch)]) };
	}
}

/** Every file under `root` (outside its `.git`) must be tracked; an empty or unknown entry is unaccounted data. */
function requireOnlyTracked(root: string): void {
	const tracked = new Set(fields(must(root, ["ls-files", "-z", "--full-name"])));
	let seen = 0;
	const inspectEntry = (
		entry: import("node:fs").Dirent,
		dir: string,
		prefix: string,
		walk: (dir: string, prefix: string) => void,
	): void => {
		const rel = `${prefix}${entry.name}`;
		if (prefix === "" && entry.name === ".git") return;
		if (++seen > WALK_LIMIT) throw new Error(`more than ${WALK_LIMIT} files to compare with the index`);
		if (entry.isDirectory() && !tracked.has(rel)) {
			if (readdirSync(join(dir, entry.name)).length === 0)
				throw new Error(`the untracked empty directory ${rel} exists`);
			walk(join(dir, entry.name), `${rel}/`);
		} else if (!tracked.has(rel)) throw new Error(`the untracked or ignored file ${rel} exists`);
	};
	const walk = (dir: string, prefix: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) inspectEntry(entry, dir, prefix, walk);
	};
	walk(root, "");
}

/** Prove the checkout still is this call's pristine creation; throws what is not. */
function proveRemovable(plan: WorktreePlan, workspace: ManagedWorkspace): void {
	if (verify(plan).cwd !== workspace.cwd) throw new Error("the checkout is not the one created");
	const self = registered(workspace.cwd).find((entry) => canonical(entry.path) === workspace.cwd);
	if (self === undefined || self.locked || self.prunable)
		throw new Error("the checkout is locked, prunable or unregistered");
	const status = must(workspace.cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"]);
	if (status !== "") throw new Error("it has staged, unstaged, conflicted, untracked or ignored changes");
	requireOnlyTracked(workspace.cwd);
}

export type Rollback = { kind: "rolled-back" } | { kind: "retained"; resources: ResourceFacts; reason: string };

/**
 * Remove a created worktree and its branch when this call's pristine
 * creation is proved, with no force. Anything unproved, or left behind by a
 * partial removal, is retained and reported exactly.
 */
export function rollbackWorktree(plan: WorktreePlan, workspace: ManagedWorkspace): Rollback {
	const retain = (reason: string): Rollback => ({ kind: "retained", resources: remnants(plan), reason });
	try {
		proveRemovable(plan, workspace);
	} catch (err) {
		return retain(`ownership or state is not proved: ${(err as Error).message}`);
	}
	const removed = askGit(plan.source.checkoutRoot, ["worktree", "remove", workspace.cwd], MUTATE);
	if (!removed.ok) return retain(`git worktree remove refused: ${removed.message}`);
	if (remnants(plan).kind === "worktree") return retain("the worktree is still present after removal");
	try {
		const ref = branchRef(plan.branch);
		if (registered(plan.source.checkoutRoot).some((entry) => entry.branch === ref)) {
			return retain(`${plan.branch} is checked out in another worktree`);
		}
		const deleted = askGit(plan.source.checkoutRoot, ["update-ref", "-d", ref, plan.baseCommit]);
		if (!deleted.ok) return retain(`the branch could not be deleted: ${deleted.message}`);
	} catch (err) {
		return retain(`the branch could not be checked: ${(err as Error).message}`);
	}
	const left = remnants(plan);
	return left.kind === "none"
		? { kind: "rolled-back" }
		: { kind: "retained", resources: left, reason: "the branch is still present" };
}

/** `text` as one shell word. */
const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

/** Non-forced commands that remove exactly the resources known to remain; none when ownership is unknown. */
export function recoveryCommands(plan: WorktreePlan, resources: ResourceFacts): string[] {
	const source = `git -C ${quote(plan.source.checkoutRoot)}`;
	if (resources.kind === "worktree") {
		return [`${source} worktree remove ${quote(resources.cwd)}`, `${source} branch -d ${quote(resources.branch)}`];
	}
	return resources.kind === "branch" ? [`${source} branch -d ${quote(resources.branch)}`] : [];
}

/** Where a waiting launch stops when its operation is aborted before it may create anything. */
const ABORTED_WAITING = "the launch was aborted; nothing was created";
const tails = new Map<string, Promise<void>>();

/**
 * Run `work` after every earlier call for the same repository has settled,
 * and release the next whatever `work` does. An abort while waiting skips
 * `work`; once it runs it is never abandoned.
 */
export function inQueue<T>(commonDir: string, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
	let started = false;
	const run = async (): Promise<T> => {
		if (signal?.aborted === true) throw new Error(ABORTED_WAITING);
		started = true;
		return work();
	};
	const before = tails.get(commonDir) ?? Promise.resolve();
	const turn = before.then(run);
	const tail = turn.then(
		() => undefined,
		() => undefined,
	);
	tails.set(commonDir, tail);
	void tail.then(() => {
		if (tails.get(commonDir) === tail) tails.delete(commonDir);
	});
	if (signal === undefined) return turn;
	return Promise.race([
		turn,
		new Promise<never>((_, reject) => {
			signal.addEventListener(
				"abort",
				() => {
					if (!started) reject(new Error(ABORTED_WAITING));
				},
				{ once: true },
			);
		}),
	]);
}
