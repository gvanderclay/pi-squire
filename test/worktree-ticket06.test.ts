import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { agentFile, cleanup, resetRoot, root, session, writeAgent } from "./harness.ts";

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, {
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Fixture",
			GIT_AUTHOR_EMAIL: "fixture@example.invalid",
			GIT_COMMITTER_NAME: "Fixture",
			GIT_COMMITTER_EMAIL: "fixture@example.invalid",
		},
		stdio: ["ignore", "pipe", "pipe"],
	})
		.toString()
		.trim();

test("explicit local commit-ish is frozen and recorded; invalid and orphan bases refuse", async () => {
	resetRoot();
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
	const dir = mkdtempSync(join(root, "explicit-base-"));
	const source = join(dir, "repo");
	mkdirSync(source);
	git(source, "init", "-q", "-b", "main");
	writeFileSync(join(source, "base.txt"), "base\n");
	git(source, "add", ".");
	git(source, "commit", "-q", "-m", "base");
	const base = git(source, "rev-parse", "HEAD");
	writeFileSync(join(source, "next.txt"), "next\n");
	git(source, "add", ".");
	git(source, "commit", "-q", "-m", "next");
	git(source, "tag", "base-tag", base);
	const s = session({ cwd: source });
	await s.start();
	const result = await s.toolCall("delegate", {
		agent: "scout",
		task: "inspect",
		worktree: "from/tag",
		worktree_base: "base-tag",
	});
	const workspace = (result.structuredContent as { workspace: { requestedBase: string; baseCommit: string } })
		.workspace;
	assert.equal(workspace.requestedBase, "base-tag");
	assert.equal(workspace.baseCommit, base);
	assert.equal(git(s.tmux.opened[0].cwd, "rev-parse", "HEAD"), base);
	await assert.rejects(
		s.toolCall("delegate", { agent: "scout", task: "inspect", worktree: "bad/base", worktree_base: "missing-ref" }),
		/worktree_base/i,
	);
	await assert.rejects(
		s.toolCall("delegate", { agent: "scout", task: "inspect", worktree_base: "HEAD" }),
		/requires worktree/i,
	);
	await s.command("delegate", 'scout --worktree "command/base" --worktree-base "HEAD~1" inspect this task');
	assert.equal(git(s.tmux.opened[1].cwd, "rev-parse", "HEAD"), base);
	cleanup();
});
