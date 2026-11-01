// Read-only Git facts shared by the launch, the snapshot and the worktree
// lifecycle: the Git runner, the repository and checkout a directory belongs
// to, and the bounded path lists reports are made of. A leaf module: it
// imports nothing of this package.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

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

/** How many paths, and how many bytes of them, a summary lists. */
const LIST_PATHS = 100;
const LIST_BYTES = 16 * 1024;

/** The first paths that fit both caps, whole, with the count of all of them. */
export function summarize(paths: string[]): PathSummary {
	const shown: string[] = [];
	let bytes = 0;
	for (const path of paths) {
		const size = Buffer.byteLength(path, "utf8");
		if (shown.length === LIST_PATHS || bytes + size > LIST_BYTES) break;
		shown.push(path);
		bytes += size;
	}
	return { paths: shown, total: paths.length, truncated: shown.length < paths.length };
}

/** NUL-terminated fields, as `-z` prints them. */
export const fields = (out: string): string[] => out.split("\0").slice(0, -1);

/** Unmerged index states, as `git status` prints them. */
const UNMERGED = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

/** `git status --porcelain=v1 -z` split into pending categories. */
export function pendingPaths(out: string): Record<"staged" | "unstaged" | "untracked" | "conflicted", string[]> {
	const pending = {
		staged: [] as string[],
		unstaged: [] as string[],
		untracked: [] as string[],
		conflicted: [] as string[],
	};
	const entries = fields(out);
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		const xy = entry.slice(0, 2);
		const path = entry.slice(3);
		// A rename or copy is followed by its source path; `--no-renames` should prevent one, but never misread it as an entry.
		if (/[RC]/.test(xy)) i++;
		if (xy === "??") pending.untracked.push(path);
		else if (UNMERGED.has(xy)) pending.conflicted.push(path);
		else {
			if (xy[0] !== " ") pending.staged.push(path);
			if (xy[1] !== " ") pending.unstaged.push(path);
		}
	}
	return pending;
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
		if (
			top.status === 128 &&
			/not a git repository [(]or any (?:of the parent directories|parent up to mount point)/i.test(top.message)
		) {
			return { launch: { kind: "non-git" } };
		}
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
export function inspectGit(cwd: string): GitLaunch {
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
