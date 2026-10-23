// Where a delegate runs and whether it trusts that project. A launch either
// inherits the parent's cwd or selects an existing directory; this module
// resolves that directory, observes its Git checkout read-only, and decides
// the explicit Pi trust flag in the parent, asking the user only when no
// saved or current decision applies and the target has protected resources.
import { execFileSync } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

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

/** `Workspace` as a schema, for the tools' structured outputs. */
export const WorkspaceSchema = Type.Object({
	mode: Type.Union([Type.Literal("inherited"), Type.Literal("existing")]),
	cwd: Type.String({ description: "The directory the delegate's window opened in." }),
	git: Type.Union(
		[
			Type.Object({
				kind: Type.Literal("git"),
				identity: Type.Object({ mainRoot: Type.String(), commonDir: Type.String(), checkoutRoot: Type.String() }),
				position: Type.Union([
					Type.Object({ branch: Type.String(), detached: Type.Literal(false) }),
					Type.Object({ branch: Type.Null(), detached: Type.Literal(true) }),
				]),
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

type GitAnswer = { ok: true; out: string } | { ok: false; status: number | null; message: string };

/** Ask Git read-only in `cwd`; never throws. */
function askGit(cwd: string, args: string[]): GitAnswer {
	const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" };
	// The parent's own repository variables would answer for the wrong directory.
	for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[name];
	try {
		const out = execFileSync("git", args, {
			cwd,
			env,
			encoding: "utf8",
			timeout: GIT_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { ok: true, out };
	} catch (err) {
		const failure = err as { status?: number | null; stderr?: string; message: string };
		const stderr = typeof failure.stderr === "string" ? failure.stderr.trim() : "";
		return { ok: false, status: failure.status ?? null, message: stderr === "" ? failure.message : stderr };
	}
}

/** The repository and checkout `cwd` belongs to, or why not. */
function identify(cwd: string): { identity: GitIdentity } | { launch: GitLaunch } {
	const top = askGit(cwd, ["rev-parse", "--show-toplevel", "--git-common-dir"]);
	if (!top.ok) {
		if (top.status === 128 && /not a git repository/i.test(top.message)) return { launch: { kind: "non-git" } };
		return { launch: { kind: "unknown", reason: `git rev-parse failed: ${top.message}` } };
	}
	const [checkout, common] = top.out.replace(/\n$/, "").split("\n");
	// shortcut: the first porcelain line names the main worktree; a main root path with a newline in it is misread. Use `-z` once Git 2.36 is the floor.
	const list = askGit(cwd, ["worktree", "list", "--porcelain"]);
	const first = list.ok ? list.out.split("\n")[0] : "";
	if (!first.startsWith("worktree ")) {
		return { launch: { kind: "unknown", reason: `git worktree list failed: ${list.ok ? first : list.message}` } };
	}
	try {
		return {
			identity: {
				mainRoot: realpathSync(first.slice("worktree ".length)),
				commonDir: realpathSync(resolve(cwd, common)),
				checkoutRoot: realpathSync(checkout),
			},
		};
	} catch (err) {
		return { launch: { kind: "unknown", reason: `could not resolve the repository paths: ${(err as Error).message}` } };
	}
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

function oneAtATime<T>(ask: () => Promise<T>): Promise<T> {
	const turn = dialogs.then(ask, ask);
	dialogs = turn.catch(() => undefined);
	return turn;
}

/** Ask the user whether the delegate trusts `cwd`'s project resources, saving only what they chose. */
async function askTrust(ctx: ExtensionContext, store: ProjectTrustStore, cwd: string, key: string): Promise<boolean> {
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
		{ signal: ctx.signal },
	);
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
async function targetTrust(cwd: string, git: GitLaunch, ctx: ExtensionContext, agentDir: string): Promise<boolean> {
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
	return oneAtATime(() => askTrust(ctx, store, cwd, key));
}

/**
 * The delegate's workspace and trust. With no `cwd`, the parent's directory
 * and current trust; with one, its real path and a trust decision for it.
 */
export async function prepareDirectory(
	request: { cwd?: string },
	ctx: ExtensionContext,
	agentDir: string,
): Promise<{ workspace: DirectoryWorkspace; trusted: boolean }> {
	if (request.cwd === undefined) {
		return {
			workspace: { mode: "inherited", cwd: ctx.cwd, git: inspectGit(ctx.cwd) },
			trusted: ctx.isProjectTrusted(),
		};
	}
	const cwd = resolveDirectory(request.cwd, ctx.cwd);
	const git = inspectGit(cwd);
	const trusted = await targetTrust(cwd, git, ctx, agentDir);
	return { workspace: { mode: "existing", cwd, git }, trusted };
}
