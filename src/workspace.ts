// Where a delegate runs and whether it trusts that project. A launch either
// inherits the parent's cwd or selects an existing directory; this module
// resolves that directory, observes its Git checkout read-only, and decides
// the explicit Pi trust flag in the parent, asking the user only when no
// saved or current decision applies and the target has protected resources.
// Where a delegate runs and whether it trusts that project. A launch either
// inherits the parent's cwd, selects an existing directory or, for a managed
// worktree, runs in a new checkout (`worktree.ts`); this module resolves an
// existing directory, observes its Git checkout read-only, and decides the
// explicit Pi trust flag in the parent, asking the user only when no saved or
// current decision applies and the target has protected resources.
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
	type ExtensionContext,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { askGit, type GitLaunch, inspectGit, PathSummarySchema } from "./git.ts";
import type { ManagedWorkspace } from "./worktree.ts";

export {
	askGit,
	type GitAnswer,
	type GitIdentity,
	type GitLaunch,
	type GitPosition,
	onePath,
	type PathSummary,
} from "./git.ts";
export { type ManagedWorkspace, prepareWorktree, type WorktreeOptions, type WorktreePlan } from "./worktree.ts";

import type { WorktreePlan } from "./worktree.ts";

export type DirectoryWorkspace = {
	mode: "inherited" | "existing";
	cwd: string;
	git: GitLaunch;
};
export type Workspace = DirectoryWorkspace | ManagedWorkspace;
/** `GitPosition` as a schema. */
export const PositionSchema = Type.Union([
	Type.Object({ branch: Type.String(), detached: Type.Literal(false) }),
	Type.Object({ branch: Type.Null(), detached: Type.Literal(true) }),
]);

/** `GitIdentity` as a schema. */
export const IdentitySchema = Type.Object({
	mainRoot: Type.String(),
	commonDir: Type.String(),
	checkoutRoot: Type.String(),
});

const CheckoutSchema = Type.Object({
	kind: Type.Literal("git"),
	identity: IdentitySchema,
	position: PositionSchema,
	head: Type.Union([Type.String(), Type.Null()]),
	baseline: Type.Union([Type.String(), Type.Null()], {
		description: "The commit checked out at launch; null when the checkout had no commit yet.",
	}),
});

const CWD_DESCRIPTION = "The directory the delegate's window opened in.";

/** `Workspace` as a schema, for the tools' structured outputs. */
export const WorkspaceSchema = Type.Union([
	Type.Object({
		mode: Type.Union([Type.Literal("inherited"), Type.Literal("existing")]),
		cwd: Type.String({ description: CWD_DESCRIPTION }),
		git: Type.Union(
			[
				CheckoutSchema,
				Type.Object({ kind: Type.Literal("non-git") }),
				Type.Object({ kind: Type.Literal("unknown"), reason: Type.String() }),
			],
			{ description: "The checkout at launch: git, non-git, or unknown when Git could not be asked." },
		),
	}),
	Type.Object({
		mode: Type.Literal("managed"),
		cwd: Type.String({ description: CWD_DESCRIPTION }),
		git: CheckoutSchema,
		sourceCwd: Type.String({ description: "The checkout the worktree was created from." }),
		source: IdentitySchema,
		createdBranch: Type.String({ description: "The branch created for the worktree, as originally named." }),
		requestedBase: Type.String(),
		baseCommit: Type.String({ description: "The commit the branch was created at." }),
		sourceDirty: PathSummarySchema,
	}),
]);

/** `WorktreePlan` as a schema: what an attempt intended. */
export const WorktreePlanSchema = Type.Object({
	sourceCwd: Type.String(),
	source: IdentitySchema,
	destination: Type.String(),
	branch: Type.String(),
	requestedBase: Type.String(),
	baseCommit: Type.String(),
	sourceDirty: PathSummarySchema,
	trusted: Type.Boolean(),
});

/** Optional inputs some models fill with these instead of leaving them out. */
const OMITTED = new Set(["", "null", "none", "false", "undefined"]);

/** A workspace input as a string, or undefined when omitted; any other type is refused, never coerced. */
export function normalizeWorkspaceValue(value: unknown, name: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") {
		throw new Error(`${name} must be a string, got ${Array.isArray(value) ? "an array" : typeof value}`);
	}
	return OMITTED.has(value) ? undefined : value;
}

/** The real path of an existing, accessible directory named by `value`, relative to `base`. */
export function resolveDirectory(value: string, base: string): string {
	// Only a leading `~` or `~/`: no variables, globs or `~user`.
	let expanded = value;
	if (value === "~") expanded = homedir();
	else if (value.startsWith("~/")) expanded = join(homedir(), value.slice(2));
	const absolute = resolve(base, expanded);
	const named = `cwd ${JSON.stringify(value)}${absolute === value ? "" : ` (${absolute})`}`;
	let real: string;
	try {
		real = realpathSync(absolute);
	} catch (err) {
		throw new Error(`${named} is not an accessible directory: ${(err as Error).message}`);
	}
	if (!statSync(real).isDirectory()) throw new Error(`${named} is not a directory`);
	try {
		accessSync(real, constants.R_OK | constants.X_OK);
	} catch (err) {
		throw new Error(`${named} cannot be accessed: ${(err as Error).message}`);
	}
	return real;
}

/** The trust dialog's choices, as Pi's own selector offers them. */
type Choice = { label: string; trusted: boolean; updates: { path: string; decision: boolean | null }[] };

function choices(key: string): Choice[] {
	const parent = dirname(key);
	return [
		{ label: "Trust", trusted: true, updates: [{ path: key, decision: true }] },
		// The parent folder's approval clears the nearer key, which would otherwise outrank it.
		...(parent === key
			? []
			: [
					{
						label: `Trust parent folder (${parent})`,
						trusted: true,
						updates: [
							{ path: parent, decision: true },
							{ path: key, decision: null },
						],
					},
				]),
		{ label: "Trust (this session only)", trusted: true, updates: [] },
		{ label: "Do not trust", trusted: false, updates: [{ path: key, decision: false }] },
		{ label: "Do not trust (this session only)", trusted: false, updates: [] },
	];
}

/** The saved decision for `key` or its closest ancestor; a broken store refuses the launch. */
function savedDecision(store: ProjectTrustStore, key: string): boolean | null {
	try {
		return store.get(key);
	} catch (err) {
		throw new Error(
			`could not read the project trust store: ${(err as Error).message}; fix or remove it, then delegate again`,
		);
	}
}

/** The end of the trust dialog queue: one question at a time in this parent, so an answer cannot reach another target. */
let dialogs: Promise<unknown> = Promise.resolve();

/** Why an aborted launch stopped. */
const ABORTED = "the launch was aborted; nothing was launched";

/** Run `ask` once every earlier question is settled; an abort while waiting rejects at once and skips `ask`. */
function oneAtATime<T>(ask: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	const run = (): Promise<T> => {
		if (signal?.aborted === true) return Promise.reject(new Error(ABORTED));
		return ask();
	};
	const turn = dialogs.then(run, run);
	dialogs = turn.catch(() => undefined);
	if (signal === undefined) return turn;
	const aborted = new Promise<never>((_, reject) => {
		signal.addEventListener("abort", () => reject(new Error(ABORTED)), { once: true });
	});
	return Promise.race([turn, aborted]);
}

/** Refuse to go on once the launch's operation is aborted. */
function stopIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted === true) throw new Error(ABORTED);
}

/** Ask the user whether the delegate trusts `cwd`'s project resources, saving only what they chose. */
async function askTrust(
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	store: ProjectTrustStore,
	cwd: string,
	key: string,
): Promise<boolean> {
	// An answer given while this question waited may already settle it.
	const saved = savedDecision(store, key);
	if (saved !== null) return saved;
	const options = choices(key);
	const title = [
		"A delegate is about to start in a directory with project resources Pi loads only when trusted.",
		`Directory: ${cwd}`,
		...(key === cwd ? [] : [`Main repository: ${key}`]),
		`"Trust" and "Do not trust" save the decision for ${key}; "Trust parent folder" saves it for the folder named; "this session only" applies to this launch alone.`,
	].join("\n");
	const answer = await ctx.ui.select(
		title,
		options.map((option) => option.label),
		{ signal },
	);
	stopIfAborted(signal);
	const choice = options.find((option) => option.label === answer);
	if (choice === undefined) throw new Error(`the trust question for ${cwd} was cancelled; nothing was launched`);
	if (choice.updates.length > 0) {
		try {
			store.setMany(choice.updates);
		} catch (err) {
			throw new Error(`could not save the trust decision for ${key}: ${(err as Error).message}; nothing was launched`);
		}
	}
	return choice.trusted;
}

/**
 * Whether a delegate in the selected directory `cwd` is trusted. The parent's
 * current trust holds only inside its own repository; elsewhere the saved
 * decision for a linked worktree's main repository or for the directory
 * itself, then no trust when nothing is protected, then the user's answer.
 */
async function targetTrust(
	cwd: string,
	git: GitLaunch,
	ctx: ExtensionContext,
	agentDir: string,
	signal: AbortSignal | undefined,
): Promise<boolean> {
	if (git.kind === "git") {
		const parent = inspectGit(ctx.cwd);
		if (parent.kind === "git" && parent.identity.commonDir === git.identity.commonDir) return ctx.isProjectTrusted();
	}
	// Linked status comes from Git, not a path prefix: a subdirectory of a main checkout keeps its own key.
	const linked = git.kind === "git" && git.identity.checkoutRoot !== git.identity.mainRoot;
	const key = linked ? git.identity.mainRoot : cwd;
	const store = new ProjectTrustStore(agentDir);
	const saved = savedDecision(store, key);
	if (saved !== null) return saved;
	if (!hasTrustRequiringProjectResources(cwd)) return false;
	if (!ctx.hasUI) {
		throw new Error(
			`cwd ${cwd} has project resources that need trust and no trust decision is saved for ${key}; open Pi in ${key}, answer its trust question, then delegate again`,
		);
	}
	return oneAtATime(() => askTrust(ctx, signal, store, cwd, key), signal);
}

const PROTECTED = [
	".pi/settings.json",
	".pi/mcp.json",
	".pi/extensions",
	".pi/skills",
	".pi/prompts",
	".pi/themes",
	".pi/SYSTEM.md",
	".pi/APPEND_SYSTEM.md",
	".agents/skills",
];

function plannedTreeHasResources(cwd: string, base: string): string | undefined {
	const tree = askGit(cwd, ["ls-tree", "-r", "-z", "--full-tree", base]);
	if (!tree.ok) throw new Error(`could not inspect planned worktree resources at ${base}: ${tree.message}`);
	for (const entry of tree.out.split("\0")) {
		if (!entry) continue;
		const tab = entry.indexOf("\t");
		if (tab < 0) throw new Error(`could not parse planned worktree tree at ${base}`);
		const metadata = entry.slice(0, tab);
		const path = entry.slice(tab + 1);
		const protectedPath = PROTECTED.some((item) => path === item || path.startsWith(`${item}/`));
		const possibleIndirection =
			path === ".pi" || path.startsWith(".pi/") || path === ".agents" || path.startsWith(".agents/");
		if (metadata.startsWith("120000 ") && possibleIndirection)
			throw new Error(
				`planned project resource path ${path} is a symlink; establish trust explicitly before delegating`,
			);
		if (protectedPath) return tree.out;
	}
	return undefined;
}

function destinationHasAncestorSkills(destination: string): boolean {
	try {
		return hasTrustRequiringProjectResources(destination);
	} catch {
		throw new Error(
			`could not inspect destination ancestor skills at ${join(dirname(destination), ".agents", "skills")}; establish trust explicitly before delegating`,
		);
	}
}

/** Trust plus the scoped facts that must remain true until the queued launch mutates anything. */
export type PlannedTrust = { trusted: boolean; revalidate(): void };

async function askPlannedResourceTrust(
	plan: WorktreePlan,
	ctx: ExtensionContext,
	store: ProjectTrustStore,
	signal?: AbortSignal,
): Promise<{ trusted: boolean; exposure?: { tree: string | undefined; ancestors: boolean } }> {
	const tree = plannedTreeHasResources(plan.source.checkoutRoot, plan.baseCommit);
	const ancestors = destinationHasAncestorSkills(plan.destination);
	const exposure = { tree, ancestors };
	if (tree === undefined && !ancestors) return { trusted: false, exposure };
	if (!ctx.hasUI)
		throw new Error(
			`the planned worktree in ${plan.destination} exposes project resources and has no saved trust decision for ${plan.source.mainRoot}; open Pi and establish trust, then delegate again`,
		);
	const trusted = await oneAtATime(async () => {
		const savedAtTurn = savedDecision(store, plan.source.mainRoot);
		if (savedAtTurn !== null) return savedAtTurn;
		const answer = await askTrust(ctx, signal, store, plan.destination, plan.source.mainRoot);
		if (
			(tree !== undefined && plannedTreeHasResources(plan.source.checkoutRoot, plan.baseCommit) !== tree) ||
			destinationHasAncestorSkills(plan.destination) !== ancestors
		)
			throw new Error("the planned resources changed while trust was being decided; delegate again");
		return answer;
	}, signal);
	return { trusted, exposure };
}

/** Decide trust for a not-yet-created checkout and retain a small synchronous queue-time check. */
export async function trustPlannedWorktree(
	plan: WorktreePlan,
	ctx: ExtensionContext,
	agentDir: string,
	signal?: AbortSignal,
): Promise<PlannedTrust> {
	const parent = inspectGit(ctx.cwd);
	const sameRepository = parent.kind === "git" && parent.identity.commonDir === plan.source.commonDir;
	const store = new ProjectTrustStore(agentDir);
	let trusted: boolean;
	let exposure: { tree: string | undefined; ancestors: boolean } | undefined;
	if (sameRepository) {
		trusted = ctx.isProjectTrusted();
	} else {
		const saved = savedDecision(store, plan.source.mainRoot);
		if (saved !== null) trusted = saved;
		else {
			const answer = await askPlannedResourceTrust(plan, ctx, store, signal);
			trusted = answer.trusted;
			exposure = answer.exposure;
		}
	}
	const savedEntry = sameRepository ? undefined : store.getEntry(plan.source.mainRoot);
	return {
		trusted,
		revalidate: () => {
			const currentParent = inspectGit(ctx.cwd);
			const stillSame = currentParent.kind === "git" && currentParent.identity.commonDir === plan.source.commonDir;
			if (sameRepository) {
				if (!stillSame || ctx.isProjectTrusted() !== trusted)
					throw new Error("the parent trust or repository changed while waiting; delegate again");
				return;
			}
			if (stillSame || JSON.stringify(store.getEntry(plan.source.mainRoot)) !== JSON.stringify(savedEntry))
				throw new Error("the scoped project trust changed while waiting; delegate again");
			if (
				exposure !== undefined &&
				(plannedTreeHasResources(plan.source.checkoutRoot, plan.baseCommit) !== exposure.tree ||
					destinationHasAncestorSkills(plan.destination) !== exposure.ancestors)
			)
				throw new Error("the planned resources changed while waiting; delegate again");
		},
	};
}

/**
 * The delegate's workspace and trust. With no `cwd`, the parent's directory
 * and current trust; with one, its real path and a trust decision for it.
 * `signal` is the launch's operation (a tool call's own signal); the turn's
 * `ctx.signal` aborts it too.
 */
export async function prepareDirectory(
	request: { cwd?: string; signal?: AbortSignal },
	ctx: ExtensionContext,
	agentDir: string,
): Promise<{ workspace: DirectoryWorkspace; trusted: boolean }> {
	if (request.cwd === undefined) {
		return {
			workspace: { mode: "inherited", cwd: ctx.cwd, git: inspectGit(ctx.cwd) },
			trusted: ctx.isProjectTrusted(),
		};
	}
	const signals = [request.signal, ctx.signal].filter((item): item is AbortSignal => item !== undefined);
	const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;
	stopIfAborted(signal);
	const cwd = resolveDirectory(request.cwd, ctx.cwd);
	const git = inspectGit(cwd);
	const trusted = await targetTrust(cwd, git, ctx, agentDir, signal);
	stopIfAborted(signal);
	return { workspace: { mode: "existing", cwd, git }, trusted };
}
