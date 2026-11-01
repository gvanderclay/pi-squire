// Standalone project placement: real Git identities and independent roots
// sharing one fake tmux server, without changing task or result ownership.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { devNull } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

import { companionCandidate } from "../src/tmux.ts";
import { placementProject } from "../src/window-placement.ts";
import { agentFile, cleanup, resetRoot, root, session, sessionDir, writeAgent } from "./harness.ts";

process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = devNull;
beforeEach(() => {
	resetRoot();
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
});
after(cleanup);

const directory = (name: string): string => {
	const path = join(mkdtempSync(join(root, "case-")), name);
	mkdirSync(path, { recursive: true });
	return realpathSync(path);
};
const git = (cwd: string, ...args: string[]): string =>
	execFileSync("git", args, {
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@example.invalid",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@example.invalid",
		},
		stdio: ["ignore", "pipe", "pipe"],
	}).toString();
const repo = (name: string): string => {
	const path = directory(name);
	git(path, "init", "-q", "-b", "main");
	git(path, "commit", "--allow-empty", "-qm", "initial");
	return path;
};
type Session = ReturnType<typeof session>;
type Started = { id: string; windowId: string; windowSession: string; notices: string[] };
const launch = async (s: Session, extra: Record<string, unknown> = {}): Promise<Started> =>
	(await s.toolCall("delegate", { agent: "scout", task: "inspect", ...extra })).structuredContent as Started;
async function start(cwd: string): Promise<Session> {
	const s = session({ cwd });
	await s.start();
	return s;
}
/** Share the server seam, while keeping each root's event bus and records independent. */
function shareServer(owner: Session, other: Session): void {
	other.tmux.openWindow = owner.tmux.openWindow.bind(owner.tmux);
	other.tmux.listWindows = owner.tmux.listWindows.bind(owner.tmux);
	other.tmux.kill = owner.tmux.kill.bind(owner.tmux);
}

test("non-Git project names normalize exactly, without error notices", () => {
	for (const [name, expected] of [
		["my.project", "my-project"],
		["Client API", "Client-API"],
		["--A_b-9--", "A_b-9"],
		["é... !", "project"],
		["a... b", "a-b"],
		["___", "___"],
	]) {
		assert.deepEqual(placementProject(directory(name)), { companion: `${expected}-delegate-session`, notices: [] });
	}
	const drafts = join(directory("reports"), "drafts");
	mkdirSync(drafts);
	assert.equal(placementProject(drafts).companion, "drafts-delegate-session");
});

test("Git main checkout, repository subdirectories and linked worktrees use the main basename", () => {
	const main = repo("Main.Project");
	const sub = join(main, "src");
	mkdirSync(sub);
	const linked = join(directory("linked-parent"), "different-leaf");
	git(main, "worktree", "add", "-qb", "feature", linked);
	for (const cwd of [main, sub, linked]) {
		assert.deepEqual(placementProject(cwd), { companion: "Main-Project-delegate-session", notices: [] });
	}
});

test("failed Git inspection and unavailable main-checkout identity fall back with a notice", () => {
	const bad = directory("broken-git");
	writeFileSync(join(bad, ".git"), "gitdir: /missing/pi-squire-test-repository\n");
	assert.equal(placementProject(bad).companion, "broken-git-delegate-session");
	assert.match(placementProject(bad).notices[0], /Could not inspect.*root working-directory basename/);
	// The existing Git identity code deliberately cannot name the main checkout
	// of a linked worktree with a separate common Git directory.
	const main = directory("separate");
	const gitDir = directory("git-data");
	git(main, "init", "-q", "--separate-git-dir", gitDir);
	git(main, "commit", "--allow-empty", "-qm", "initial");
	const linked = join(directory("parent"), "unlocated-main");
	git(main, "worktree", "add", "-qb", "feature", linked);
	assert.equal(placementProject(linked).companion, "unlocated-main-delegate-session");
	assert.match(placementProject(linked).notices[0], /main checkout.*cannot be located/);
});

test("Git unavailable still launches into the root basename and reports the fallback", async () => {
	const cwd = directory("fallback-root");
	const target = directory("target");
	const s = await start(cwd);
	const bin = directory("bin");
	writeFileSync(join(bin, "git"), "#!/bin/sh\necho 'Git unavailable' >&2\nexit 127\n");
	chmodSync(join(bin, "git"), 0o755);
	const saved = process.env.PATH;
	process.env.PATH = `${bin}:${saved}`;
	try {
		const result = await launch(s, { cwd: target });
		assert.equal(result.windowSession, "fallback-root-delegate-session");
		assert.match(result.notices.join("\n"), /Git unavailable.*root working-directory basename/);
	} finally {
		process.env.PATH = saved;
	}
});

test("different root projects in one parent session separate; same basename and normalization collisions share", async () => {
	const a = await start(directory("api.one"));
	const b = await start(directory("other"));
	const c = await start(directory("api-one"));
	const d = await start(directory("api.one"));
	for (const other of [b, c, d]) shareServer(a, other);
	const windows = await Promise.all([launch(a), launch(b), launch(c), launch(d)]);
	assert.deepEqual(
		windows.map((value) => value.windowSession),
		["api-one-delegate-session", "other-delegate-session", "api-one-delegate-session", "api-one-delegate-session"],
	);
	assert.equal(a.tmux.sessions.get("api-one-delegate-session")?.length, 3);
});

test("cross-project cwd and worktree_source never choose placement; roots in other tmux parents reuse", async () => {
	const main = repo("owning-project");
	const target = repo("task-project");
	const a = await start(main);
	const b = await start(main);
	shareServer(a, b);
	const first = await launch(a, { cwd: target });
	a.tmux.parentSession = "another-parent";
	const second = await launch(b, { worktree: "task/topic", worktree_source: target });
	assert.equal(first.windowSession, "owning-project-delegate-session");
	assert.equal(second.windowSession, first.windowSession);
	assert.equal(a.tmux.opened[0].cwd, target);
	assert.notEqual(a.tmux.opened[1].cwd, main);
});

test("unmarked base and numbered names stay untouched; a managed alternative wins over a newly freed base", async () => {
	const s = await start(directory("collision"));
	const base = "collision-delegate-session";
	s.tmux.addWindow("@100", "user-base", base);
	s.tmux.addWindow("@101", "user-numbered", `${base}-2`);
	const first = await launch(s);
	assert.equal(first.windowSession, `${base}-3`);
	assert.equal(s.tmux.detachOnDestroy.has(base), false);
	assert.equal(s.tmux.detachOnDestroy.has(`${base}-2`), false);
	s.tmux.windows.delete("@100");
	const next = await launch(s);
	assert.equal(next.windowSession, first.windowSession);
	assert.equal(s.tmux.windows.get("@101")?.name, "user-numbered");
});

test("new placement leaves a legacy companion and its existing windows untouched", async () => {
	const s = await start(directory("new-project"));
	s.tmux.addWindow("@100", "legacy-delegate", "work-squire");
	s.tmux.companions.add("work-squire");
	const result = await launch(s);
	assert.equal(result.windowSession, "new-project-delegate-session");
	assert.equal(s.tmux.windows.get("@100")?.session, "work-squire");
	assert.equal(s.tmux.detachOnDestroy.has("work-squire"), false);
});

test("an unmarked creation race is rechecked and never adopted", async () => {
	const s = await start(directory("race"));
	s.tmux.raceNewSession = true;
	s.tmux.raceWinnerManaged = false;
	const result = await launch(s);
	assert.equal(result.windowSession, "race-delegate-session-2");
	assert.equal(s.tmux.opened.length, 1);
	assert.equal(s.tmux.detachOnDestroy.has("race-delegate-session"), false);
	assert.equal(s.tmux.companions.has("race-delegate-session"), false);
});

test("duplicate managed candidates select numeric order deterministically without repair", () => {
	const base = "project-delegate-session";
	const candidates = new Map([
		[`${base}-10`, true],
		[`${base}-3`, true],
		[`${base}-2`, false],
		[`${base}-old`, true],
	]);
	assert.equal(companionCandidate(base, candidates), `${base}-3`);
	candidates.set(base, true);
	assert.equal(companionCandidate(base, candidates), base);
});

test("sharing a companion leaves status, result routes and close-all scoped to each root", async () => {
	const a = await start(directory("shared"));
	const b = await start(directory("shared"));
	shareServer(a, b);
	const first = await launch(a);
	const second = await launch(b);
	assert.equal(first.windowSession, second.windowSession);
	assert.deepEqual(
		a.sendCalls.map((value) => value.to),
		[first.id],
	);
	assert.deepEqual(
		b.sendCalls.map((value) => value.to),
		[second.id],
	);
	const status = (await a.toolCall("delegation_status", {})).content[0].text;
	assert.ok(status.includes(first.id));
	assert.equal(status.includes(second.id), false);
	await a.toolCall("delegation_close", {});
	assert.deepEqual(a.tmux.killed, [first.windowId]);
	assert.equal(a.tmux.windows.has(second.windowId), true);
	assert.match((await b.toolCall("delegation_status", { id: second.id })).content[0].text, /state: running/);
});

test("ordinary root restart and resume retain root placement, not the delegate cwd or invoking parent", async () => {
	const cwd = directory("resume-owner");
	const target = directory("resume-target");
	const original = await start(cwd);
	const first = await launch(original, { cwd: target });
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(
		join(sessionDir, `20261026T000000_${first.id}.jsonl`),
		JSON.stringify({ type: "session", version: 3, id: first.id, timestamp: "2026-10-26T00:00:00.000Z", cwd: target }) +
			"\n",
	);
	original.tmux.exit(first.windowId);
	await original.shutdown();
	const restarted = session({ parent: original.parent, cwd, entries: original.entries });
	shareServer(original, restarted);
	original.tmux.parentSession = "unrelated-invoking-session";
	await restarted.start();
	const resumed = (await restarted.toolCall("delegation_resume", { id: first.id, task: "more" }))
		.structuredContent as Started;
	assert.equal(resumed.windowSession, "resume-owner-delegate-session");
	assert.equal(original.tmux.opened.at(-1)?.cwd, target);
});
