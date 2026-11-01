// Read-only observations of a delegation's checkout: on receipt of its result
// and afresh on each status call. A snapshot compares the checkout now with
// the launch commit recorded in its workspace, inspects only that recorded
// directory, stays within time and output limits, and reports unknown with a
// reason whenever something cannot be established. Nothing acts on it.
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { Type } from "typebox";

import {
	askGit,
	fields,
	type GitAnswer,
	type GitLaunch,
	type GitPosition,
	onePath,
	type PathSummary,
	pendingPaths,
	summarize,
} from "./git.ts";

/**
 * A checkout as observed at one moment: its position and head against the
 * launch baseline, committed changes since the baseline and pending work.
 * An observation, not proof of who made the changes.
 */
export type WorkspaceSnapshot =
	| { kind: "non-git" }
	| { kind: "unknown"; reason: string }
	| {
			kind: "git";
			position: GitPosition;
			head: string;
			baseline: string;
			ahead: number;
			workingState: "clean" | "dirty";
			committed: PathSummary;
			pending: { staged: PathSummary; unstaged: PathSummary; untracked: PathSummary; conflicted: PathSummary };
	  };

/** `WorkspaceSnapshot` as a schema for `delegation_status`: the discriminant, the rest open. */
export const WorkspaceSnapshotSchema = Type.Object(
	{ kind: Type.Union([Type.Literal("git"), Type.Literal("non-git"), Type.Literal("unknown")]) },
	{ additionalProperties: true },
);

/** Reporting limits for one snapshot; never evidence for deleting anything. */
const SNAPSHOT_COMMAND_MS = 2000;
const SNAPSHOT_TOTAL_MS = 5000;
const SNAPSHOT_CAPTURE_BYTES = 4 * 1024 * 1024;
/** Why a snapshot is unknown; thrown during an inspection and caught by `inspectWorkspace`. */
class Unknown extends Error {}

/** A Git runner bounded for one inspection: the per-command and total time limits and one capture budget. */
function budgetedGit(cwd: string): { run(args: string[]): GitAnswer; ask(args: string[]): string } {
	const start = Date.now();
	let captured = 0;
	const run = (args: string[]): GitAnswer => {
		const left = SNAPSHOT_TOTAL_MS - (Date.now() - start);
		if (left <= 0) throw new Unknown(`inspection passed its ${SNAPSHOT_TOTAL_MS / 1000} s total time limit`);
		const answer = askGit(cwd, args, {
			timeout: Math.min(SNAPSHOT_COMMAND_MS, left),
			maxBuffer: SNAPSHOT_CAPTURE_BYTES - captured,
		});
		// Both streams, failed commands included, share one budget.
		captured += answer.bytes;
		if (captured > SNAPSHOT_CAPTURE_BYTES) {
			throw new Unknown(`Git printed more than the ${SNAPSHOT_CAPTURE_BYTES} byte capture limit for one inspection`);
		}
		return answer;
	};
	const ask = (args: string[]): string => {
		const answer = run(args);
		if (!answer.ok) throw new Unknown(`git ${args[args[0] === "-c" ? 2 : 0]} failed: ${answer.message}`);
		return answer.out;
	};
	return { run, ask };
}

/**
 * Refuse a directory that is gone or whose checkout root or common directory
 * is not at its recorded location. A repository replaced at the same
 * locations is observed like any other: this checks location, not continuity.
 */
function requireLaunchCheckout(
	cwd: string,
	launch: Extract<GitLaunch, { kind: "git" }>,
	ask: (args: string[]) => string,
): void {
	if (statSync(cwd, { throwIfNoEntry: false })?.isDirectory() !== true) {
		throw new Unknown(`the checkout ${cwd} is gone or no longer a directory`);
	}
	let checkoutRoot: string;
	let commonDir: string;
	try {
		checkoutRoot = realpathSync(onePath(ask(["rev-parse", "--show-toplevel"])));
		commonDir = realpathSync(resolve(cwd, onePath(ask(["rev-parse", "--git-common-dir"]))));
	} catch (err) {
		if (err instanceof Unknown) throw err;
		throw new Unknown(`could not resolve the repository paths: ${(err as Error).message}`);
	}
	if (checkoutRoot !== launch.identity.checkoutRoot || commonDir !== launch.identity.commonDir) {
		throw new Unknown(
			`${cwd} is now checkout ${checkoutRoot} of ${commonDir}, not the launch checkout ${launch.identity.checkoutRoot} of ${launch.identity.commonDir}`,
		);
	}
}

/** The checkout recorded at launch, observed now against its launch commit. */
function inspectCheckout(cwd: string, launch: Extract<GitLaunch, { kind: "git" }>): WorkspaceSnapshot {
	const baseline = launch.baseline;
	if (baseline === null) throw new Unknown("the checkout had no commit at launch, so there is no baseline to compare");
	if (!/^[0-9a-f]{40,64}$/.test(baseline))
		throw new Unknown(`the recorded launch commit ${baseline} is not a commit id`);
	const { run, ask } = budgetedGit(cwd);
	requireLaunchCheckout(cwd, launch, ask);
	const ref = run(["symbolic-ref", "-q", "HEAD"]);
	if (!ref.ok && ref.status !== 1) throw new Unknown(`git symbolic-ref failed: ${ref.message}`);
	const name = ref.ok ? onePath(ref.out) : "";
	const position: GitPosition = ref.ok
		? { branch: name.startsWith("refs/heads/") ? name.slice("refs/heads/".length) : name, detached: false }
		: { branch: null, detached: true };
	const head = onePath(ask(["rev-parse", "--verify", "HEAD^{commit}"]));
	onePath(ask(["rev-parse", "--verify", `${baseline}^{commit}`]));
	const ahead = Number.parseInt(ask(["rev-list", "--count", head, "--not", baseline]), 10);
	if (!Number.isSafeInteger(ahead)) throw new Unknown("git rev-list printed no commit count");
	// A configured diff.relative would drop paths outside a subdirectory cwd and reroot the rest; `-c` rather
	// than `--no-relative`, which needs Git 2.28, while older Git ignores the unknown key.
	const committed = fields(
		ask([
			"-c",
			"diff.relative=false",
			"diff",
			"--name-only",
			"-z",
			"--no-renames",
			"--no-ext-diff",
			baseline,
			head,
			"--",
		]),
	);
	const pending = pendingPaths(ask(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]));
	const dirty = Object.values(pending).some((paths) => paths.length > 0);
	return {
		kind: "git",
		position,
		head,
		baseline,
		ahead,
		workingState: dirty ? "dirty" : "clean",
		committed: summarize(committed),
		pending: {
			staged: summarize(pending.staged),
			unstaged: summarize(pending.unstaged),
			untracked: summarize(pending.untracked),
			conflicted: summarize(pending.conflicted),
		},
	};
}

/**
 * The recorded checkout as it stands now, read-only and bounded. Only `cwd`
 * and its launch facts are inspected, never the parent's directory; anything
 * that cannot be established is unknown with a reason. Never throws.
 */
export function inspectWorkspace(cwd: string | undefined, git: GitLaunch | undefined): WorkspaceSnapshot {
	try {
		if (git === undefined || cwd === undefined) {
			return { kind: "unknown", reason: "this delegation was recorded before its launch checkout was kept" };
		}
		if (git.kind === "unknown")
			return { kind: "unknown", reason: `its Git state at launch was unknown (${git.reason})` };
		if (git.kind === "non-git") {
			return statSync(cwd, { throwIfNoEntry: false })?.isDirectory() === true
				? { kind: "non-git" }
				: { kind: "unknown", reason: `the directory ${cwd} is gone` };
		}
		return inspectCheckout(cwd, git);
	} catch (err) {
		return { kind: "unknown", reason: (err as Error).message };
	}
}
