import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspectGit } from "../src/git.ts";
import { createWorktree, type ManagedWorkspace, type WorktreePlan } from "../src/worktree.ts";
import { root } from "./harness.ts";

export function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Cleanup fixture",
			GIT_AUTHOR_EMAIL: "fixture@example.invalid",
			GIT_COMMITTER_NAME: "Cleanup fixture",
			GIT_COMMITTER_EMAIL: "fixture@example.invalid",
		},
	}).trim();
}
export function fixture(): { plan: WorktreePlan; workspace: ManagedWorkspace; source: string; cwd: string } {
	const base: string = realpathSync(mkdtempSync(join(root, "cleanup-")));
	const source: string = join(base, "repo");
	mkdirSync(source);
	git(source, "init", "-q", "-b", "main");
	writeFileSync(join(source, "tracked"), "base\n");
	writeFileSync(join(source, ".gitignore"), "node_modules/\n.scratch/\nscratch/\n");
	git(source, "add", ".");
	git(source, "commit", "-qm", "base");
	const found = inspectGit(source);
	if (found.kind !== "git" || found.head === null) throw new Error("fixture repository not identified");
	const plan: WorktreePlan = {
		sourceCwd: source,
		source: found.identity,
		destination: join(base, "topic"),
		branch: "topic",
		requestedBase: "HEAD",
		baseCommit: found.head,
		sourceDirty: { total: 0, paths: [], truncated: false },
		trusted: true,
	};
	const created = createWorktree(plan);
	if (!("workspace" in created)) throw new Error(created.cause);
	return { plan, workspace: created.workspace, source, cwd: created.workspace.cwd };
}
export function commit(cwd: string, value = "topic"): string {
	writeFileSync(join(cwd, "tracked"), value);
	git(cwd, "add", "tracked");
	git(cwd, "commit", "-qm", value);
	return git(cwd, "rev-parse", "HEAD");
}
