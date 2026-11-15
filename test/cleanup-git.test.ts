import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import {
	type CleanupGitDeps,
	type CleanupOutcome,
	checkIgnored,
	cleanGit,
	cleanupRemains,
	type GhRunner,
	previewCleanupGit,
} from "../src/cleanup-git.ts";
import { askGit } from "../src/git.ts";
import { commit, fixture, git } from "./cleanup-fixture.ts";
import { cleanup } from "./harness.ts";

after(cleanup);
const noGh: GhRunner = () => ({ ok: false, message: "gh absent" });
function run(f: ReturnType<typeof fixture>, deps: CleanupGitDeps = {}): CleanupOutcome {
	return cleanGit(f.plan, () => {}, { gh: noGh, ...deps });
}
function unchanged(f: ReturnType<typeof fixture>, deps: CleanupGitDeps = {}): CleanupOutcome {
	const branches: string = git(f.source, "show-ref", "--heads");
	const trees: string = git(f.source, "worktree", "list", "--porcelain");
	const files: Buffer = readFileSync(join(f.cwd, "tracked"));
	const result: CleanupOutcome = run(f, deps);
	assert.equal(result.outcome, "kept", result.reason);
	assert.equal(git(f.source, "show-ref", "--heads"), branches);
	assert.equal(git(f.source, "worktree", "list", "--porcelain"), trees);
	assert.deepEqual(readFileSync(join(f.cwd, "tracked")), files);
	return result;
}

test("Git preview proves safety without invoking either mutation or the removal hooks", () => {
	const f = fixture();
	const trees = git(f.source, "worktree", "list", "--porcelain");
	const branches = git(f.source, "show-ref", "--heads");
	const fail = (): never => {
		throw new Error("preview mutated");
	};
	assert.equal(
		previewCleanupGit(f.plan, () => {}, { git: fail, beforeRemove: fail, afterRemove: fail, gh: noGh }),
		undefined,
	);
	assert.equal(git(f.source, "worktree", "list", "--porcelain"), trees);
	assert.equal(git(f.source, "show-ref", "--heads"), branches);
	writeFileSync(join(f.cwd, "dirty"), "untracked");
	assert.match(previewCleanupGit(f.plan, () => {}, { gh: noGh })?.reason ?? "", /uncommitted or untracked/);
});

test("remains conservatively includes the branch when Git cannot observe the source", () => {
	const f = fixture();
	assert.deepEqual(cleanupRemains({ ...f.plan, source: { ...f.plan.source, mainRoot: join(f.source, "missing") } }), [
		`worktree: ${f.cwd}`,
		"branch: refs/heads/topic",
	]);
	assert.equal(git(f.source, "rev-parse", "refs/heads/topic"), f.plan.baseCommit);
});

test("merged clean worktree and tip branch removed; retry already-clean", () => {
	const f = fixture();
	assert.equal(run(f).outcome, "removed");
	assert.equal(existsSync(f.cwd), false);
	assert.equal(askGit(f.source, ["show-ref", "--verify", "refs/heads/topic"]).ok, false);
	assert.equal(run(f).outcome, "already-clean");
});
test("no-commit, fast-forward and merge-commit proofs remove", async (t) => {
	for (const kind of ["no-commit", "fast-forward", "merge-commit"])
		await t.test(kind, () => {
			const f = fixture();
			if (kind !== "no-commit") {
				commit(f.cwd);
				git(f.source, "merge", kind === "merge-commit" ? "--no-ff" : "--ff-only", "topic", "-m", "merge");
			}
			assert.equal(run(f).outcome, "removed");
		});
});
test("gh squash proof requires exact tip, same repo and matching local base ancestor", async (t) => {
	for (const kind of [
		"exact",
		"wrong tip",
		"cross repo",
		"base mismatch",
		"nonlocal commit",
		"revision instead of oid",
		"option instead of oid",
		"short oid",
		"nonlocal sha256 oid",
		"20 results",
		"absent",
		"timeout",
		"invalid",
	]) {
		await t.test(kind, () => {
			const f = fixture();
			const tip: string = commit(f.cwd);
			git(f.source, "merge", "--squash", "topic");
			git(f.source, "commit", "-qm", "squash");
			const pr = {
				headRefOid: tip,
				baseRefName: "main",
				mergeCommit: { oid: git(f.source, "rev-parse", "HEAD") },
				isCrossRepository: false,
			};
			if (kind === "wrong tip") pr.headRefOid = f.plan.baseCommit;
			if (kind === "cross repo") pr.isCrossRepository = true;
			if (kind === "base mismatch") pr.baseRefName = "wrong";
			if (kind === "nonlocal commit") pr.mergeCommit.oid = "a".repeat(40);
			if (kind === "revision instead of oid") pr.mergeCommit.oid = "HEAD";
			if (kind === "option instead of oid") pr.mergeCommit.oid = "--all";
			if (kind === "short oid") pr.mergeCommit.oid = pr.mergeCommit.oid.slice(0, 12);
			if (kind === "nonlocal sha256 oid") pr.mergeCommit.oid = "a".repeat(64);
			const gh: GhRunner = (cwd: string, args: string[]) => {
				assert.equal(cwd, f.source);
				assert.deepEqual(args, [
					"pr",
					"list",
					"--state",
					"merged",
					"--head",
					"topic",
					"--limit",
					"20",
					"--json",
					"headRefOid,baseRefName,mergeCommit,isCrossRepository,url",
				]);
				if (kind === "absent" || kind === "timeout") return { ok: false, message: kind };
				return {
					ok: true,
					out: kind === "invalid" ? "not JSON" : JSON.stringify(kind === "20 results" ? Array(20).fill(pr) : [pr]),
				};
			};
			if (kind === "exact") assert.equal(run(f, { gh }).outcome, "removed");
			else assert.match(unchanged(f, { gh }).reason, /merge not proved/);
		});
	}
});
test("ignored node_modules and .scratch are removed, counted and never followed through symlinks", () => {
	const f = fixture();
	for (const name of ["node_modules", ".scratch"]) {
		mkdirSync(join(f.cwd, name));
		writeFileSync(join(f.cwd, name, "data"), "ignored");
	}
	symlinkSync(f.source, join(f.cwd, ".scratch", "symlink"));
	const result: CleanupOutcome = run(f);
	assert.equal(result.outcome, "removed");
	assert.deepEqual(result.ignoredRemoved, { total: 2, paths: [".scratch/", "node_modules/"] });
	assert.equal(existsSync(join(f.source, "tracked")), true);
});
type Blocker = (f: ReturnType<typeof fixture>) => void;
const blockers: Record<string, Blocker> = {
	"untracked file": (f) => writeFileSync(join(f.cwd, "new"), "keep"),
	staged: (f) => {
		writeFileSync(join(f.cwd, "tracked"), "staged");
		git(f.cwd, "add", ".");
	},
	unstaged: (f) => writeFileSync(join(f.cwd, "tracked"), "unstaged"),
	conflict: (f) => {
		const blob: string = git(f.cwd, "rev-parse", "HEAD:tracked");
		execFileSync("git", ["update-index", "--index-info"], {
			cwd: f.cwd,
			input: `0 ${"0".repeat(40)}\ttracked\n100644 ${blob} 1\ttracked\n100644 ${blob} 2\ttracked\n100644 ${blob} 3\ttracked\n`,
		});
	},
	"rebase in progress": (f) => mkdirSync(join(f.source, ".git", "worktrees", "topic", "rebase-merge")),
	gitlink: (f) => {
		git(f.cwd, "update-index", "--add", "--cacheinfo", `160000,${f.plan.baseCommit},sub`);
		git(f.cwd, "commit", "-qm", "gitlink");
		git(f.source, "merge", "--ff-only", "topic");
		mkdirSync(join(f.cwd, "sub"));
		assert.equal(git(f.cwd, "status", "--porcelain=v1", "--ignore-submodules=none"), "");
	},
	"wrong branch": (f) => {
		git(f.cwd, "checkout", "-qb", "other");
	},
	detached: (f) => {
		git(f.cwd, "checkout", "--detach", "-q");
	},
	locked: (f) => {
		git(f.source, "worktree", "lock", f.cwd);
	},
	"unmerged tip": (f) => {
		commit(f.cwd);
	},
	"nested ignored repository": (f) => {
		mkdirSync(join(f.cwd, "scratch", "myrepo", ".git"), { recursive: true });
	},
	"gone upstream": (f) => {
		commit(f.cwd);
		git(f.source, "merge", "--squash", "topic");
		git(f.source, "commit", "-qm", "squashed topic");
		assert.equal(git(f.cwd, "diff", "main"), "");
		git(f.source, "remote", "add", "origin", "https://example.invalid/repo");
		git(f.source, "update-ref", "refs/remotes/origin/topic", "HEAD");
		git(f.cwd, "branch", "--set-upstream-to=origin/topic");
		git(f.source, "update-ref", "-d", "refs/remotes/origin/topic");
	},
};
const blockerReasons: Record<string, RegExp> = {
	"untracked file": /^uncommitted or untracked changes$/,
	staged: /^uncommitted or untracked changes$/,
	unstaged: /^uncommitted or untracked changes$/,
	conflict: /^uncommitted or untracked changes$/,
	"rebase in progress": /^Git operation in progress: rebase-merge$/,
	gitlink: /^gitlink in index$/,
	"wrong branch": /^branch checked out elsewhere$/,
	detached: /^branch checked out elsewhere$/,
	locked: /^worktree unregistered, locked or prunable$/,
	"unmerged tip": /^merge not proved \(gh absent\); fetch and retry$/,
	"nested ignored repository": /^nested repository in ignored content$/,
	"gone upstream": /^upstream branch deleted but merge not proved; fetch and retry$/,
};
test("unsafe worktrees retain files, branch and registration unchanged", async (t) => {
	for (const [name, setup] of Object.entries(blockers))
		await t.test(name, () => {
			const f = fixture();
			setup(f);
			assert.match(unchanged(f).reason, blockerReasons[name]);
		});
});
test("ignored directory walk cap, deadline and device mismatch retain", () => {
	const f = fixture();
	mkdirSync(join(f.cwd, ".scratch", "deep"), { recursive: true });
	assert.match(unchanged(f, { walk: { maxDirectories: 1 } }).reason, /too large/);
	assert.match(unchanged(f, { walk: { maxMs: -1 } }).reason, /too large/);
	assert.throws(
		() =>
			checkIgnored(f.cwd, [".scratch/"], {
				lstat: (path: string) => {
					const stat = lstatSync(path);
					return { dev: path === f.cwd ? stat.dev : stat.dev + 1, isDirectory: () => stat.isDirectory() };
				},
			}),
		/different filesystem/,
	);
});
test("prunable registration, branch elsewhere and replacement repository keep", async (t) => {
	await t.test("prunable", () => {
		const f = fixture();
		rmSync(f.cwd, { recursive: true });
		const trees: string = git(f.source, "worktree", "list", "--porcelain");
		assert.equal(run(f).outcome, "kept");
		assert.equal(git(f.source, "worktree", "list", "--porcelain"), trees);
	});
	await t.test("branch elsewhere", () => {
		const f = fixture();
		git(f.cwd, "checkout", "--detach", "-q");
		git(f.source, "worktree", "add", join(f.source, "..", "elsewhere"), "topic");
		unchanged(f);
	});
	await t.test("different commonDir", () => {
		const f = fixture();
		rmSync(f.cwd, { recursive: true });
		mkdirSync(f.cwd);
		git(f.cwd, "init", "-q", "-b", "topic");
		writeFileSync(join(f.cwd, "tracked"), "replacement");
		git(f.cwd, "add", ".");
		git(f.cwd, "commit", "-qm", "replacement");
		unchanged(f);
	});
});
test("branch recreation after removal is partial and never deletes checked-out branch", () => {
	const f = fixture();
	const result: CleanupOutcome = run(f, {
		afterRemove: () => {
			git(f.source, "worktree", "add", f.cwd, "topic");
		},
	});
	assert.equal(result.outcome, "partial");
	assert.match(result.reason, /recreated/);
	assert.ok(result.remains.includes("branch: refs/heads/topic"));
	assert.equal(git(f.cwd, "rev-parse", "HEAD"), f.plan.baseCommit);
});
test("final synchronous clean check catches an untracked file before Git remove", () => {
	const f = fixture();
	let removed = false;
	const result: CleanupOutcome = run(f, {
		beforeRemove: () => writeFileSync(join(f.cwd, "late"), "keep"),
		git: (cwd, args, limits) => {
			if (args[0] === "worktree") removed = true;
			return askGit(cwd, args, limits);
		},
	});
	assert.equal(result.outcome, "kept");
	assert.equal(result.reason, "uncommitted or untracked changes");
	assert.equal(removed, false);
	assert.equal(existsSync(join(f.cwd, "late")), true);
	assert.equal(git(f.source, "rev-parse", "refs/heads/topic"), f.plan.baseCommit);
});
test("failed Git removal with a surviving directory is partial, not a promise that nothing was deleted", async (t) => {
	for (const kind of ["partial ignored deletion", "timeout", "permission error"]) {
		await t.test(kind, () => {
			const f = fixture();
			mkdirSync(join(f.cwd, ".scratch"));
			writeFileSync(join(f.cwd, ".scratch", "data"), "ignored");
			const result: CleanupOutcome = run(f, {
				git: (cwd, args, limits) => {
					if (args[0] !== "worktree") return askGit(cwd, args, limits);
					if (kind === "partial ignored deletion") rmSync(join(f.cwd, ".scratch", "data"));
					return { ok: false, status: kind === "timeout" ? null : 1, bytes: 0, message: kind };
				},
			});
			assert.equal(result.outcome, "partial");
			assert.match(result.reason, /removal may be incomplete/);
			assert.deepEqual(result.remains, [`worktree: ${f.cwd}`, "branch: refs/heads/topic"]);
			assert.equal(result.ignoredRemoved, undefined);
			assert.equal(existsSync(join(f.cwd, ".scratch", "data")), kind !== "partial ignored deletion");
			assert.equal(git(f.source, "rev-parse", "refs/heads/topic"), f.plan.baseCommit);
		});
	}
});
test("untracked file appears at Git remove: refusal with nothing removed is kept", () => {
	const f = fixture();
	const result: CleanupOutcome = run(f, {
		git: (cwd, args, limits) => {
			if (args[0] === "worktree") writeFileSync(join(f.cwd, "late"), "keep");
			return askGit(cwd, args, limits);
		},
	});
	assert.equal(result.outcome, "kept");
	assert.match(result.reason, /remove refused/);
	assert.equal(existsSync(join(f.cwd, "late")), true);
});
test("modified tracked file appears at Git remove: Git's clean refusal is kept", () => {
	const f = fixture();
	const result: CleanupOutcome = run(f, {
		git: (cwd, args, limits) => {
			if (args[0] === "worktree") writeFileSync(join(f.cwd, "tracked"), "late tracked change");
			return askGit(cwd, args, limits);
		},
	});
	assert.equal(result.outcome, "kept");
	assert.match(result.reason, /remove refused/);
	assert.equal(readFileSync(join(f.cwd, "tracked"), "utf8"), "late tracked change");
	assert.equal(git(f.source, "rev-parse", "refs/heads/topic"), f.plan.baseCommit);
});
test("CAS deletion fails after removal: partial; retry branch-only deletes proved tip", () => {
	const f = fixture();
	const result: CleanupOutcome = run(f, {
		git: (cwd, args, limits) =>
			args[0] === "update-ref"
				? { ok: false, status: 1, bytes: 0, message: "injected delete refusal" }
				: askGit(cwd, args, limits),
	});
	assert.equal(result.outcome, "partial");
	assert.deepEqual(result.remains, ["branch: refs/heads/topic"]);
	assert.equal(run(f).outcome, "removed");
});
test("a changed tip is never deleted and symbolic local refs are never followed", () => {
	const f = fixture();
	const result: CleanupOutcome = run(f, {
		afterRemove: () => {
			git(f.source, "update-ref", "refs/heads/topic", commit(f.source, "later"));
		},
	});
	assert.equal(result.outcome, "partial");
	const main: string = git(f.source, "rev-parse", "HEAD");
	git(f.source, "symbolic-ref", "refs/heads/topic", "refs/heads/main");
	assert.equal(run(f).outcome, "kept");
	assert.equal(git(f.source, "rev-parse", "refs/heads/main"), main);
	assert.equal(git(f.source, "symbolic-ref", "refs/heads/topic"), "refs/heads/main");
});
