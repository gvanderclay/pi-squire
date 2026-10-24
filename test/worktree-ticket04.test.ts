import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { agentFile, cleanup, resetRoot, root, session, writeAgent } from "./harness.ts";

// biome-ignore lint/suspicious/noExplicitAny: fixture assertions narrow runtime record fields.
type Data = Record<string, any>;

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

test("worktree conflicts and checkout-history branch shorthand fail before mail", async () => {
	resetRoot();
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
	const base = mkdtempSync(join(root, "boundary-"));
	const source = join(base, "repo");
	mkdirSync(source);
	git(source, "init", "-q", "-b", "main");
	writeFileSync(join(source, "tracked.txt"), "committed\\n");
	git(source, "add", ".");
	git(source, "commit", "-q", "-m", "base");
	const s = session({ cwd: source });
	await s.start();
	await assert.rejects(
		s.toolCall("delegate", { agent: "scout", task: "inspect", cwd: source, worktree: "new/topic" }),
		/cwd.*worktree|worktree.*cwd/i,
	);
	await assert.rejects(
		s.toolCall("delegate", { agent: "scout", task: "inspect", worktree: "@{-1}" }),
		/valid new local branch/i,
	);
	assert.deepEqual(s.sendCalls, []);
	assert.deepEqual(s.tmux.opened, []);
	const placeholder = await s.toolCall("delegate", { agent: "scout", task: "inspect", cwd: source, worktree: "null" });
	assert.equal((placeholder.structuredContent as Data).workspace.mode, "existing");
});

test("managed worktree starts at source HEAD, omits dirt and records created facts", async () => {
	resetRoot();
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
	const base = mkdtempSync(join(root, "managed-"));
	const source = join(base, "repo");
	mkdirSync(source);
	git(source, "init", "-q", "-b", "main");
	writeFileSync(join(source, "tracked.txt"), "committed\n");
	git(source, "add", ".");
	git(source, "commit", "-q", "-m", "base");
	const head = git(source, "rev-parse", "HEAD");
	writeFileSync(join(source, "dirty.txt"), "not copied\n");
	const indexPath = join(source, ".git", "index");
	const index = readFileSync(indexPath);
	const s = session({ cwd: source });
	await s.start();
	let sawPlannedBeforeMutation = false;
	const append = s.pi.appendEntry.bind(s.pi);
	// Observe the real journal seam: planned must be durable before the path or ref appears.
	s.pi.appendEntry = ((customType: string, data: unknown) => {
		if (
			customType === "delegate" &&
			typeof data === "object" &&
			data !== null &&
			"kind" in data &&
			data.kind === "workspace-attempt" &&
			"attempt" in data &&
			typeof data.attempt === "object" &&
			data.attempt !== null &&
			"phase" in data.attempt &&
			data.attempt.phase === "planned"
		) {
			assert.equal(existsSync(join(base, "repo-worktrees", "feature-topic")), false);
			assert.equal(
				spawnSync("git", ["show-ref", "--verify", "--quiet", "refs/heads/feature/topic"], { cwd: source }).status,
				1,
			);
			assert.equal("requestId" in data, false);
			assert.equal("windowId" in data, false);
			sawPlannedBeforeMutation = true;
		}
		return append(customType, data as never);
	}) as typeof s.pi.appendEntry;
	const result = await s.toolCall("delegate", { agent: "scout", task: "inspect", worktree: "feature/topic" });
	assert.equal(sawPlannedBeforeMutation, true);
	s.pi.appendEntry = append;
	const destination = join(base, "repo-worktrees", "feature-topic");
	assert.equal(s.tmux.opened[0].cwd, realpathSync(destination));
	assert.equal(git(destination, "rev-parse", "HEAD"), head);
	assert.equal(git(destination, "symbolic-ref", "--short", "HEAD"), "feature/topic");
	assert.equal(existsSync(join(destination, "dirty.txt")), false);
	assert.deepEqual(readFileSync(indexPath), index);
	const record = s.entries.find((entry) => entry.data.windowId)?.data as Data | undefined;
	assert.ok(record);
	assert.equal(record.workspace.mode, "managed");
	assert.equal(record.workspace.createdBranch, "feature/topic");
	assert.equal(record.workspace.baseCommit, head);
	assert.ok(record.workspace.sourceDirty.total >= 1);
	assert.match(result.content[0].text, /not copied/i);
	const promptPath = s.tmux.opened[0].argv[s.tmux.opened[0].argv.indexOf("--append-system-prompt") + 1];
	assert.match(readFileSync(promptPath, "utf8"), new RegExp(head));
	assert.equal((result.structuredContent as Data).workspace.cwd, realpathSync(destination));
	await s.command("delegate", "scout --worktree command/topic inspect command entry");
	assert.equal(s.tmux.opened.length, 2, s.errors.join("\\n"));
	assert.equal(s.tmux.opened[1].cwd, realpathSync(join(base, "repo-worktrees", "command-topic")));
	cleanup();
});

test("known pre-window failure rolls back a pristine managed worktree", async () => {
	resetRoot();
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
	const base = mkdtempSync(join(root, "rollback-"));
	const source = join(base, "repo");
	mkdirSync(source);
	git(source, "init", "-q", "-b", "main");
	writeFileSync(join(source, "tracked.txt"), "committed\n");
	git(source, "add", ".");
	git(source, "commit", "-q", "-m", "base");
	const s = session({ cwd: source });
	await s.start();
	s.tmux.failOpen = "known failure";
	await assert.rejects(
		s.toolCall("delegate", { agent: "scout", task: "inspect", worktree: "retry/topic" }),
		/known failure/,
	);
	const destination = join(base, "repo-worktrees", "retry-topic");
	assert.equal(existsSync(destination), false);
	assert.equal(
		spawnSync("git", ["show-ref", "--verify", "--quiet", "refs/heads/retry/topic"], { cwd: source }).status,
		1,
	);
	const attempt = s.entries.filter((entry) => entry.data.kind === "workspace-attempt").at(-1)?.data as Data | undefined;
	assert.ok(attempt);
	assert.equal(attempt.attempt.phase, "rolled-back");
	assert.equal(attempt.requestId, s.sendCalls[0].envelope?.id);
	assert.equal("windowId" in attempt, false);
});

test("ignored files created during launch prevent rollback", async () => {
	resetRoot();
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
	const base = mkdtempSync(join(root, "ignored-retain-"));
	const source = join(base, "repo");
	mkdirSync(source);
	git(source, "init", "-q", "-b", "main");
	writeFileSync(join(source, ".gitignore"), "ignored-secret.txt\n");
	git(source, "check-ignore", "--quiet", "ignored-secret.txt");
	writeFileSync(join(source, "tracked.txt"), "committed\\n");
	git(source, "add", ".");
	git(source, "commit", "-q", "-m", "base");
	const s = session({ cwd: source });
	await s.start();
	const destination = join(base, "repo-worktrees", "ignored-topic");
	const open = s.tmux.openWindow.bind(s.tmux);
	s.tmux.openWindow = async (spec) => {
		writeFileSync(join(destination, "ignored-secret.txt"), "keep this\\n");
		s.tmux.failOpen = "known pre-window failure";
		return open(spec);
	};
	const failure = await s.toolCall("delegate", { agent: "scout", task: "inspect", worktree: "ignored/topic" }).then(
		() => assert.fail("launch should retain ignored data"),
		(error: Error) => error,
	);
	assert.match(failure.message, /known pre-window failure.*inspect and preserve its contents before any cleanup/);
	assert.doesNotMatch(failure.message, /worktree remove|git branch -d/);
	assert.equal(readFileSync(join(destination, "ignored-secret.txt"), "utf8"), "keep this\\n");
	const retained = s.entries.filter((entry) => entry.data.kind === "workspace-attempt").at(-1)?.data as
		| Data
		| undefined;
	assert.ok(retained);
	assert.equal(retained.attempt.phase, "retained");
	assert.equal(retained.attempt.resources.kind, "worktree");
	cleanup();
});

test("ambiguous open retains attempt and close has no window side effects", async () => {
	resetRoot();
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
	const base = mkdtempSync(join(root, "ambiguous-"));
	const source = join(base, "repo");
	mkdirSync(source);
	git(source, "init", "-q", "-b", "main");
	writeFileSync(join(source, "tracked.txt"), "committed\\n");
	git(source, "add", ".");
	git(source, "commit", "-q", "-m", "base");
	const s = session({ cwd: source });
	await s.start();
	s.tmux.failOpen = "timeout after dispatch";
	s.tmux.failOpenCertainty = "unknown";
	await assert.rejects(
		s.toolCall("delegate", { agent: "scout", task: "inspect", worktree: "keep/topic" }),
		/timeout after dispatch/,
	);
	const attempt = s.entries.filter((entry) => entry.data.kind === "workspace-attempt").at(-1)?.data as Data | undefined;
	assert.ok(attempt);
	assert.equal(attempt.attempt.phase, "retained");
	assert.equal(attempt.attempt.resources.kind, "worktree");
	const before = s.tmux.listCalls;
	await assert.rejects(s.toolCall("delegation_close", { id: attempt.id }), /unstarted|attempt/i);
	assert.equal(s.tmux.listCalls, before);
	assert.deepEqual(s.tmux.killed, []);
	const planned = s.entries.find((entry) => entry.data.kind === "workspace-attempt")?.data;
	assert.ok(planned);
	const resumed = session({ cwd: source, entries: [{ customType: "delegate", data: planned }] });
	await resumed.start();
	const status = await resumed.toolCall("delegation_status", { id: attempt.id });
	const item = (status.structuredContent as Data).delegations[0];
	assert.equal(item.state, "interrupted");
	assert.equal(item.kind, "workspace-attempt");
	assert.equal("windowId" in item, false);
	cleanup();
});
