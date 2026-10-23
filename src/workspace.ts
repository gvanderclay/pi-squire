// Where a delegate runs and whether it trusts that project. A launch either
// inherits the parent's cwd or selects an existing directory; this module
// resolves that directory, observes its Git checkout read-only, and decides
// the explicit Pi trust flag in the parent, asking the user only when no
// saved or current decision applies and the target has protected resources.
import { spawnSync } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
	type ExtensionContext,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** A bounded list of file names, as data; never shell text. */
export type PathSummary = { paths: string[]; total: number; truncated: boolean };
/** A checkout's repository, as canonical absolute paths. */
export type GitIdentity = { mainRoot: string; commonDir: string; checkoutRoot: string };
export type GitPosition = { branch: string; detached: false } | { branch: null; detached: true };
/** A launch's Git facts: a checkout, proved not a checkout, or not known. */
export type GitLaunch =
	| { kind: "git"; identity: GitIdentity; position: GitPosition; head: string | null; baseline: string | null }
	| { kind: "non-git" }
	| { kind: "unknown"; reason: string };
export type DirectoryWorkspace = {
	mode: "inherited" | "existing";
	cwd: string;
	git: GitLaunch;
};
export type Workspace = DirectoryWorkspace;
/** `GitPosition` as a schema. */
export const PositionSchema = Type.Union([
	Type.Object({ branch: Type.String(), detached: Type.Literal(false) }),
	Type.Object({ branch: Type.Null(), detached: Type.Literal(true) }),
]);

/** `Workspace` as a schema, for the tools' structured outputs. */
export const WorkspaceSchema = Type.Object({
	mode: Type.Union([Type.Literal("inherited"), Type.Literal("existing")]),
	cwd: Type.String({ description: "The directory the delegate's window opened in." }),
	git: Type.Union(
		[
			Type.Object({
				kind: Type.Literal("git"),
				identity: Type.Object({ mainRoot: Type.String(), commonDir: Type.String(), checkoutRoot: Type.String() }),
				position: PositionSchema,
				head: Type.Union([Type.String(), Type.Null()]),
				baseline: Type.Union([Type.String(), Type.Null()], {
					description: "The commit checked out at launch; null when the checkout had no commit yet.",
				}),
			}),
			Type.Object({ kind: Type.Literal("non-git") }),
			Type.Object({ kind: Type.Literal("unknown"), reason: Type.String() }),
		],
		{ description: "The checkout at launch: git, non-git, or unknown when Git could not be asked." },
	),
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
function resolveDirectory(value: string, base: string): string {
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

/** How long one Git question may take before the answer is unknown. */
const GIT_TIMEOUT_MS = 5000;

/** A Git answer, with `bytes` the stdout and stderr it captured, so a caller can budget them together. */
export type GitAnswer =
	| { ok: true; out: string; bytes: number }
	| { ok: false; status: number | null; message: string; bytes: number };

/**
 * Ask Git read-only in `cwd`; never throws. A call past `timeout` is killed
 * with SIGKILL, which it cannot ignore, and one printing more than
 * `maxBuffer` on either stream fails; each failure names its limit.
 */
export function askGit(
	cwd: string,
	args: string[],
	limits: { timeout: number; maxBuffer?: number } = { timeout: GIT_TIMEOUT_MS },
): GitAnswer {
	const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" };
	// The parent's own repository variables would answer for the wrong directory.
	for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[name];
	const run = spawnSync("git", args, {
		cwd,
		env,
		timeout: limits.timeout,
		killSignal: "SIGKILL",
		...(limits.maxBuffer === undefined ? {} : { maxBuffer: limits.maxBuffer }),
		stdio: ["ignore", "pipe", "pipe"],
	});
	const bytes = (run.stdout?.length ?? 0) + (run.stderr?.length ?? 0);
	const code = (run.error as { code?: string } | undefined)?.code;
	if (code === "ETIMEDOUT") {
		return { ok: false, status: null, message: `timed out after the ${limits.timeout / 1000} s time limit`, bytes };
	}
	if (code === "ENOBUFS") {
		return { ok: false, status: null, message: `printed more than the ${limits.maxBuffer} byte capture limit`, bytes };
	}
	if (run.error !== undefined) return { ok: false, status: null, message: run.error.message, bytes };
	if (run.status === 0) return { ok: true, out: run.stdout.toString("utf8"), bytes };
	const stderr = run.stderr.toString("utf8").trim();
	const how = run.status === null ? `was killed by ${run.signal}` : `exited with status ${run.status}`;
	return { ok: false, status: run.status, message: stderr === "" ? `git ${args[0]} ${how}` : stderr, bytes };
}

/** One path Git printed alone on its output: only the final newline is dropped, since a path may hold others. */
export const onePath = (out: string): string => (out.endsWith("\n") ? out.slice(0, -1) : out);

/** The repository and checkout `cwd` belongs to, or why not. */
function identify(cwd: string): { identity: GitIdentity } | { launch: GitLaunch } {
	// One question per path, so no output is split on a newline a path may contain.
	const top = askGit(cwd, ["rev-parse", "--show-toplevel"]);
	if (!top.ok) {
		if (top.status === 128 && /not a git repository/i.test(top.message)) return { launch: { kind: "non-git" } };
		return { launch: { kind: "unknown", reason: `git rev-parse failed: ${top.message}` } };
	}
	const common = askGit(cwd, ["rev-parse", "--git-common-dir"]);
	if (!common.ok) return { launch: { kind: "unknown", reason: `git rev-parse failed: ${common.message}` } };
	const own = askGit(cwd, ["rev-parse", "--git-dir"]);
	if (!own.ok) return { launch: { kind: "unknown", reason: `git rev-parse failed: ${own.message}` } };
	let checkoutRoot: string;
	let commonDir: string;
	let gitDir: string;
	try {
		checkoutRoot = realpathSync(onePath(top.out));
		commonDir = realpathSync(resolve(cwd, onePath(common.out)));
		gitDir = realpathSync(resolve(cwd, onePath(own.out)));
	} catch (err) {
		return { launch: { kind: "unknown", reason: `could not resolve the repository paths: ${(err as Error).message}` } };
	}
	// A main checkout's own Git directory is the common one, wherever it lives (`--separate-git-dir` included).
	if (gitDir === commonDir) return { identity: { mainRoot: checkoutRoot, commonDir, checkoutRoot } };
	// A linked worktree's main checkout is where Git keeps it: the folder holding a `.git` common directory.
	// A linked worktree of a bare repository, or of a main checkout with a separate Git directory, has
	// no main checkout Git can name for a trust key, so its identity stays unknown.
	if (basename(commonDir) !== ".git") {
		return {
			launch: {
				kind: "unknown",
				reason: `the main checkout of the linked worktree ${checkoutRoot} cannot be located: its repository's Git directory ${commonDir} is not a checkout's .git`,
			},
		};
	}
	return { identity: { mainRoot: dirname(commonDir), commonDir, checkoutRoot } };
}

/** The checkout at `cwd` as it stands: identity, branch or detached, and the commit checked out. */
function inspectGit(cwd: string): GitLaunch {
	const found = identify(cwd);
	if ("launch" in found) return found.launch;
	const ref = askGit(cwd, ["symbolic-ref", "-q", "HEAD"]);
	if (!ref.ok && ref.status !== 1) return { kind: "unknown", reason: `git symbolic-ref failed: ${ref.message}` };
	const name = ref.ok ? ref.out.trim() : "";
	const position: GitPosition = ref.ok
		? { branch: name.startsWith("refs/heads/") ? name.slice("refs/heads/".length) : name, detached: false }
		: { branch: null, detached: true };
	const head = askGit(cwd, ["rev-parse", "-q", "--verify", "HEAD^{commit}"]);
	// Exit 1 with nothing printed is an unborn branch: a valid checkout without a commit.
	if (!head.ok && head.status !== 1) return { kind: "unknown", reason: `git rev-parse HEAD failed: ${head.message}` };
	const commit = head.ok ? head.out.trim() : null;
	return { kind: "git", identity: found.identity, position, head: commit, baseline: commit };
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
