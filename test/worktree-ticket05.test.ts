import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { after, test } from "node:test";
import { agentDir, agentFile, cleanup, resetRoot, root, session, writeAgent } from "./harness.ts";

// biome-ignore lint/suspicious/noExplicitAny: harness records are runtime schemas checked by the harness.
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

function makeRepo(path: string): string {
	mkdirSync(path, { recursive: true });
	git(path, "init", "-q", "-b", "main");
	writeFileSync(join(path, "tracked.txt"), "base\n");
	git(path, "add", ".");
	git(path, "commit", "-q", "-m", "base");
	return path;
}

const settingsPath = () => join(agentDir, "squire", "settings.json");
const setSettings = (settings: unknown) => {
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(settingsPath(), JSON.stringify(settings));
};
const setRawSettings = (text: string) => {
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(settingsPath(), text);
};

async function started(cwd: string) {
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
	const s = session({ cwd });
	await s.start();
	return s;
}

const call = (s: ReturnType<typeof session>, worktree: string) =>
	s.toolCall("delegate", { agent: "scout", task: `inspect ${worktree}`, worktree });

function startRecords(s: ReturnType<typeof session>): Data[] {
	return s.entries.filter((entry) => typeof entry.data.windowId === "string").map((entry) => entry.data as Data);
}

const windowCwds = (s: ReturnType<typeof session>): string[] => s.tmux.opened.map((window) => window.cwd);

test("placement settings are call-time main-repository overrides", async () => {
	resetRoot();
	const base = mkdtempSync(join(root, "placement-"));
	const main = makeRepo(join(base, "main project"));
	const linked = join(base, "linked source");
	git(main, "worktree", "add", "-q", "-b", "linked/source", linked);
	const originalBase = git(main, "rev-parse", "HEAD");
	const settingDir = join(agentDir, "squire");
	mkdirSync(settingDir, { recursive: true });
	// A relative symlink key must canonicalize to the main root, not match the linked source name.
	const relativeKey = join(settingDir, "main-root-alias");
	symlinkSync(main, relativeKey);
	setSettings({
		worktreeRoot: "global/{repo}/{branch}",
		worktreeRootByRepo: { "./main-root-alias": "overrides/{repo}/{branch}" },
	});
	const s = await started(linked);

	const first = await call(s, "feature/topic");
	const overridePath = join(settingDir, "overrides", basename(main), "feature-topic");
	assert.equal(s.tmux.opened[0].cwd, realpathSync(overridePath));
	assert.equal(git(overridePath, "symbolic-ref", "--short", "HEAD"), "feature/topic");
	assert.equal(git(overridePath, "rev-parse", "HEAD"), originalBase);
	const firstWorkspace = (first.structuredContent as Data).workspace;
	assert.equal(firstWorkspace.source.mainRoot, realpathSync(main));
	assert.equal(firstWorkspace.sourceCwd, linked);
	assert.equal(firstWorkspace.baseCommit, originalBase);

	// A settings rewrite is observed on the next call without re-registering the extension.
	setSettings({ worktreeRoot: "relative-global/{repo}/{branch}" });
	const second = await call(s, "second/topic");
	const globalPath = join(settingDir, "relative-global", basename(main), "second-topic");
	assert.equal(s.tmux.opened[1].cwd, realpathSync(globalPath));
	assert.equal((second.structuredContent as Data).workspace.source.mainRoot, realpathSync(main));
	assert.equal((second.structuredContent as Data).workspace.baseCommit, originalBase);

	// Tilde expands for override keys and templates; templates remain relative to settingsDir.
	const tildeDirectory = `.pi-squire-placement-${process.pid}-${randomUUID()}`;
	const tildeRoot = join(homedir(), tildeDirectory);
	try {
		mkdirSync(tildeRoot);
		symlinkSync(main, join(tildeRoot, "main-alias"));
		setSettings({
			worktreeRoot: "ignored-global/{branch}",
			worktreeRootByRepo: { [`~/${tildeDirectory}/main-alias`]: "tilde-key-overrides/{branch}" },
		});
		const third = await call(s, "tilde-key/topic");
		const keyedPath = join(settingDir, "tilde-key-overrides", "tilde-key-topic");
		assert.equal(s.tmux.opened[2].cwd, realpathSync(keyedPath));
		assert.equal((third.structuredContent as Data).workspace.baseCommit, originalBase);

		setSettings({ worktreeRoot: `~/${tildeDirectory}/{repo}/{branch}` });
		const fourth = await call(s, "home/topic");
		const homePath = join(tildeRoot, basename(main), "home-topic");
		assert.equal(s.tmux.opened[3].cwd, realpathSync(homePath));
		assert.equal(git(homePath, "symbolic-ref", "--short", "HEAD"), "home/topic");
		assert.equal((fourth.structuredContent as Data).workspace.baseCommit, originalBase);
	} finally {
		rmSync(tildeRoot, { recursive: true, force: true });
	}
	assert.equal(git(main, "symbolic-ref", "--short", "HEAD"), "main");
	assert.equal(git(linked, "symbolic-ref", "--short", "HEAD"), "linked/source");
});

test("invalid creation settings refuse before mail but do not affect inherited or cwd launches", async () => {
	resetRoot();
	const base = mkdtempSync(join(root, "bad-placement-"));
	const source = makeRepo(join(base, "repo"));
	const plain = join(base, "plain directory");
	mkdirSync(plain);
	const aliasDir = join(agentDir, "squire");
	mkdirSync(aliasDir, { recursive: true });
	const alias = join(aliasDir, "repo-alias");
	symlinkSync(source, alias);
	const s = await started(source);
	const indexBefore = readFileSync(join(source, ".git", "index"));

	const invalid = [
		"{",
		JSON.stringify({ worktreeRoot: 3 }),
		JSON.stringify({ worktreeRootByRepo: null }),
		JSON.stringify({ worktreeRootByRepo: { [source]: 3 } }),
		JSON.stringify({ worktreeRoot: "{repo}/{branch}/{unknown}" }),
		JSON.stringify({ worktreeRoot: "missing-branch" }),
		JSON.stringify({ worktreeRoot: "" }),
		JSON.stringify({ worktreeRootByRepo: { [source]: "a/{branch}", "./repo-alias": "b/{branch}" } }),
	];
	for (const text of invalid) {
		setRawSettings(text);
		await assert.rejects(call(s, `bad/${s.sendCalls.length}`), /settings\.json/i);
		assert.deepEqual(s.sendCalls, []);
		assert.deepEqual(s.tmux.opened, []);
		assert.deepEqual(readFileSync(join(source, ".git", "index")), indexBefore);
		assert.equal(spawnSync("git", ["show-ref", "--verify", "--quiet", "refs/heads/bad/0"], { cwd: source }).status, 1);
	}

	// A directory at the settings filename gives a deterministic read failure, even under root.
	rmSync(settingsPath(), { force: true });
	mkdirSync(settingsPath());
	await assert.rejects(call(s, "bad/unreadable"), /settings\.json/i);
	assert.deepEqual(s.sendCalls, []);
	assert.deepEqual(s.tmux.opened, []);
	assert.deepEqual(readFileSync(join(source, ".git", "index")), indexBefore);

	const inherited = await s.toolCall("delegate", { agent: "scout", task: "ordinary inherited launch" });
	const existing = await s.toolCall("delegate", { agent: "scout", task: "ordinary cwd launch", cwd: plain });
	assert.equal((inherited.structuredContent as Data).cwd, source);
	assert.equal((existing.structuredContent as Data).cwd, realpathSync(plain));
	assert.deepEqual(windowCwds(s), [source, realpathSync(plain)]);
	assert.equal(s.sendCalls.length, 2);
});

test("configured nested placement leaves ignore rules alone and rejects slash-flattened collisions", async () => {
	resetRoot();
	const base = mkdtempSync(join(root, "nested-placement-"));
	const source = makeRepo(join(base, "repo"));
	writeFileSync(join(source, ".gitignore"), "*.cache\n");
	const ignoreBefore = readFileSync(join(source, ".gitignore"));
	const baseCommit = git(source, "rev-parse", "HEAD");
	setSettings({ worktreeRoot: "{repoParent}/{repo}/checkouts/{branch}" });
	const s = await started(source);
	const result = await call(s, "nested/topic");
	const destination = join(source, "checkouts", "nested-topic");
	assert.equal(s.tmux.opened[0].cwd, realpathSync(destination));
	assert.equal(git(destination, "symbolic-ref", "--short", "HEAD"), "nested/topic");
	assert.equal(git(destination, "rev-parse", "HEAD"), baseCommit);
	assert.deepEqual(readFileSync(join(source, ".gitignore")), ignoreBefore);
	assert.equal((result.structuredContent as Data).workspace.createdBranch, "nested/topic");
	assert.equal((result.structuredContent as Data).workspace.baseCommit, baseCommit);

	await assert.rejects(call(s, "nested-topic"), /already exists|collision/i);
	assert.equal(s.tmux.opened.length, 1);
	assert.equal(s.sendCalls.length, 1);
	assert.equal(
		spawnSync("git", ["show-ref", "--verify", "--quiet", "refs/heads/nested-topic"], { cwd: source }).status,
		1,
	);
});

test("configured placement collisions refuse without changing existing destinations", async () => {
	resetRoot();
	const base = mkdtempSync(join(root, "placement-collisions-"));
	const source = makeRepo(join(base, "repo"));
	const layout = join(base, "layout");
	const folder = join(layout, "folder-topic");
	const symlinkTarget = join(base, "symlink-target");
	mkdirSync(folder, { recursive: true });
	mkdirSync(symlinkTarget);
	writeFileSync(join(folder, "sentinel"), "keep folder\n");
	writeFileSync(join(symlinkTarget, "sentinel"), "keep target\n");
	symlinkSync(symlinkTarget, join(layout, "link-topic"));
	mkdirSync(layout, { recursive: true });
	setSettings({ worktreeRoot: `${layout}/{branch}` });
	const s = await started(source);

	await assert.rejects(call(s, "folder/topic"), /already exists/i);
	await assert.rejects(call(s, "link/topic"), /already exists/i);
	setSettings({ worktreeRoot: "{repoParent}/{repo}/.git/managed/{branch}" });
	await assert.rejects(call(s, "admin/topic"), /administrative data/i);

	const registeredDestination = join(layout, "registered-topic");
	git(source, "worktree", "add", "-q", "--detach", registeredDestination);
	rmSync(registeredDestination, { recursive: true, force: true });
	setSettings({ worktreeRoot: `${layout}/{branch}` });
	await assert.rejects(call(s, "registered/topic"), /registered/i);

	assert.equal(readFileSync(join(folder, "sentinel"), "utf8"), "keep folder\n");
	assert.equal(readFileSync(join(symlinkTarget, "sentinel"), "utf8"), "keep target\n");
	assert.deepEqual(s.sendCalls, []);
	assert.deepEqual(s.tmux.opened, []);
});

test("equal repository basenames collide at a custom central root instead of falling back", async () => {
	resetRoot();
	const base = mkdtempSync(join(root, "same-basename-"));
	const firstRepo = makeRepo(join(base, "first", "project"));
	const secondRepo = makeRepo(join(base, "second", "project"));
	const central = join(base, "central");
	setSettings({ worktreeRoot: `${central}/{repo}/{branch}` });
	const first = await started(firstRepo);
	await call(first, "feature/topic");
	const destination = join(central, "project", "feature-topic");
	const sentinel = join(destination, "tracked.txt");
	const sentinelBefore = readFileSync(sentinel);

	const second = await started(secondRepo);
	await assert.rejects(call(second, "feature/topic"), /already exists|collision/i);
	assert.deepEqual(readFileSync(sentinel), sentinelBefore);
	assert.equal(git(destination, "symbolic-ref", "--short", "HEAD"), "feature/topic");
	assert.deepEqual(second.sendCalls, []);
	assert.deepEqual(second.tmux.opened, []);
});

test("placement ancestors are revalidated if a symlink changes while queued", async () => {
	resetRoot();
	const base = mkdtempSync(join(root, "placement-symlink-race-"));
	const source = makeRepo(join(base, "repo"));
	const ancestor = join(base, "placement-root");
	const movedAncestor = join(base, "moved-placement-root");
	const redirect = join(base, "redirect");
	mkdirSync(ancestor);
	mkdirSync(redirect);
	setSettings({ worktreeRoot: `${ancestor}/{branch}` });
	const s = await started(source);
	let signalReached: () => void = () => {};
	let releaseOpen: () => void = () => {};
	const reachedOpen = new Promise<void>((resolve) => {
		signalReached = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		releaseOpen = resolve;
	});
	const open = s.tmux.openWindow.bind(s.tmux);
	s.tmux.openWindow = async (spec, placement, companion) => {
		const id = await open(spec, placement, companion);
		signalReached();
		await gate;
		return id;
	};

	const first = call(s, "hold/topic");
	await reachedOpen;
	const second = call(s, "race/topic");
	// The first call holds the repository queue after the second has time to freeze its destination.
	await new Promise((resolve) => setTimeout(resolve, 100));
	renameSync(ancestor, movedAncestor);
	symlinkSync(redirect, ancestor);
	releaseOpen();
	await first;
	await assert.rejects(second, /canonical path/i);
	assert.equal(s.tmux.opened.length, 1);
	assert.equal(s.sendCalls.length, 1);
	assert.equal(existsSync(join(redirect, "race-topic")), false);
});

test("a known launch failure rolls back and releases the queue at configured placement", async () => {
	resetRoot();
	const base = mkdtempSync(join(root, "configured-rollback-"));
	const source = makeRepo(join(base, "repo"));
	setSettings({ worktreeRoot: "configured/{branch}" });
	const s = await started(source);
	const destination = join(agentDir, "squire", "configured", "retry-topic");
	s.tmux.failOpen = "known configured placement failure";
	await assert.rejects(call(s, "retry/topic"), /known configured placement failure/);
	assert.equal(existsSync(destination), false);
	assert.equal(
		spawnSync("git", ["show-ref", "--verify", "--quiet", "refs/heads/retry/topic"], { cwd: source }).status,
		1,
	);

	s.tmux.failOpen = undefined;
	const result = await call(s, "retry/topic");
	assert.equal(s.tmux.opened[0].cwd, realpathSync(destination));
	assert.equal((result.structuredContent as Data).workspace.cwd, realpathSync(destination));
});

test("managed snapshots retain baseline, current branch facts and original created branch", async () => {
	resetRoot();
	const base = mkdtempSync(join(root, "managed-snapshot-"));
	const source = makeRepo(join(base, "repo"));
	const baseline = git(source, "rev-parse", "HEAD");
	const s = await started(source);
	await call(s, "feature/original");
	const record = startRecords(s)[0];
	const destination = record.workspace.cwd as string;
	git(destination, "switch", "-q", "-c", "later/branch");
	writeFileSync(join(destination, "committed.txt"), "committed after launch\n");
	git(destination, "add", "committed.txt");
	git(destination, "commit", "-q", "-m", "after launch");
	const head = git(destination, "rev-parse", "HEAD");
	writeFileSync(join(destination, "pending.txt"), "not committed\n");

	const status = await s.toolCall("delegation_status", { id: record.id });
	const item = (status.structuredContent as Data).delegations[0];
	assert.equal(item.workspace.createdBranch, "feature/original");
	assert.equal(item.workspaceSnapshot.baseline, baseline);
	assert.equal(item.workspaceSnapshot.head, head);
	assert.deepEqual(item.workspaceSnapshot.position, { branch: "later/branch", detached: false });
	assert.deepEqual(item.workspaceSnapshot.committed.paths, ["committed.txt"]);
	assert.deepEqual(item.workspaceSnapshot.pending.untracked.paths, ["pending.txt"]);

	const payload = {
		envelope: {
			id: "managed-result",
			from: record.id,
			to: s.parent,
			in_reply_to: [record.requestId],
			status: "done",
			ts: "2026-10-23T00:00:00.000Z",
			body: "completed",
		},
		path: join(agentDir, "mailbox", s.parent, "cur", "managed-result.json"),
		requests: [
			{
				envelope: {
					id: record.requestId,
					from: s.parent,
					to: record.id,
					in_reply_to: [],
					status: "",
					ts: "2026-10-23T00:00:00.000Z",
					body: "inspect managed worktree",
				},
				path: join(agentDir, "mailbox", s.parent, "sent", `${record.requestId}.json`),
			},
		],
		handled: false,
	};
	s.events.emit("message:inbound", payload);
	assert.equal(payload.handled, true);
	const resultMessage = s.sent.find((message) => message.message.customType === "delegate")?.message as unknown as {
		content: string;
		details: Data;
	};
	assert.equal(resultMessage.details.workspace.createdBranch, "feature/original");
	assert.equal(resultMessage.details.workspaceSnapshot.baseline, baseline);
	assert.equal(resultMessage.details.workspaceSnapshot.head, head);
	assert.deepEqual(resultMessage.details.workspaceSnapshot.position, { branch: "later/branch", detached: false });
	assert.deepEqual(resultMessage.details.workspaceSnapshot.committed.paths, ["committed.txt"]);
	assert.deepEqual(resultMessage.details.workspaceSnapshot.pending.untracked.paths, ["pending.txt"]);
	const settled = s.entries.find((entry) => entry.data.result !== undefined)?.data as Data;
	assert.equal(record.workspace.createdBranch, "feature/original");
	assert.equal(settled.result.workspaceSnapshot.baseline, baseline);
	assert.equal(settled.result.workspaceSnapshot.head, head);
	assert.deepEqual(settled.result.workspaceSnapshot.position, { branch: "later/branch", detached: false });
	assert.deepEqual(settled.result.workspaceSnapshot.committed.paths, ["committed.txt"]);
	assert.deepEqual(settled.result.workspaceSnapshot.pending.untracked.paths, ["pending.txt"]);
});

after(cleanup);
