import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { readChildRecords } from "../src/child-tasks.ts";
import { readIdentity } from "../src/identity.ts";
import type { Delegation, StartedRecorded } from "../src/results.ts";
import type { CloseDetails } from "../src/tree-close.ts";
import { readTree, reconcileTree, treeCounts, treePath } from "../src/tree-registry.ts";
import { FakeTmux } from "./fake-tmux.ts";
import { agentDir, agentFile, cleanup, keyScript, resetRoot, root, sessionDir, writeAgent } from "./harness.ts";
import { envelopes, mailSession, nextTurn, scan } from "./mail-harness.ts";

type Session = ReturnType<typeof mailSession>;
const active: Session[] = [];
function instance(options: Parameters<typeof mailSession>[0] = {}): Session {
	const value = mailSession(options);
	active.push(value);
	return value;
}
beforeEach(() => {
	resetRoot();
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(join(agentDir, "squire", "settings.json"), JSON.stringify({ maxDepth: 3 }));
	writeAgent(
		"coordinator",
		agentFile({ model: "alpha/fast-model", allow_nested_delegation: "[worker]", auto_exit: "false" }),
	);
	writeAgent("worker", agentFile({ model: "alpha/fast-model", auto_exit: "false" }));
});
afterEach(async () => {
	for (const value of active.splice(0)) await value.shutdown();
});
after(cleanup);
async function launch(parent: Session, agent: string): Promise<Delegation> {
	const result = await parent.toolCall("delegate", { agent, task: "do work" });
	return parent.entries.find((entry) => entry.data.id === (result.structuredContent as { id: string }).id)!
		.data as Delegation;
}
async function tree(options: Parameters<typeof mailSession>[0] = {}) {
	const tmux = new FakeTmux();
	const owner = instance({ tmux, mode: "tui", ...options });
	await owner.start();
	const c = await launch(owner, "coordinator");
	const coordinator = instance({ parent: c.id, tmux });
	await coordinator.start();
	scan(coordinator);
	const w = await launch(coordinator, "worker");
	const worker = instance({ parent: w.id, tmux });
	await worker.start();
	scan(worker);
	return { owner, coordinator, worker, c, w, tmux };
}
const record = (parent: Session, id: string): StartedRecorded =>
	readChildRecords(parent.parent).find((r) => r.id === id) as StartedRecorded;
const close = async (parent: Session, id: string): Promise<CloseDetails> =>
	(await parent.toolCall("delegation_close", { id })).structuredContent as CloseDetails;
const finals = (parent: Session) =>
	[...envelopes(parent.parent, "new"), ...envelopes(parent.parent, "cur")].filter((e) => e.in_reply_to.length);

test("ancestor close captures subtree only, never siblings, user windows or shared-companion other roots", async () => {
	const { owner, coordinator, c, w, tmux } = await tree();
	const sibling = await launch(owner, "coordinator");
	const foreign = instance({ tmux });
	await foreign.start();
	const other = await launch(foreign, "coordinator");
	tmux.moveWindow(c.windowId, "shared-companion");
	tmux.moveWindow(w.windowId, "shared-companion");
	tmux.moveWindow(other.windowId, "shared-companion");
	tmux.addWindow("@user", "vim", "shared-companion");
	await assert.rejects(coordinator.toolCall("delegation_close", { id: sibling.id }), /descendant tree/);
	await assert.rejects(foreign.toolCall("delegation_close", { id: w.id }), /descendant tree/);
	const result = await close(owner, c.id);
	assert.equal(result.complete, true);
	assert.deepEqual(tmux.killed, [w.windowId, c.windowId], "deepest first");
	assert.equal(tmux.windows.has(sibling.windowId), true);
	assert.equal(tmux.windows.has(other.windowId), true);
	assert.equal(tmux.windows.has("@user"), true);
	assert.equal(record(owner, c.id).closed, true);
	assert.equal(record(coordinator, w.id).closed, undefined, "ancestor does not write foreign semantic records");
	await coordinator.fire("context", { messages: [] });
	assert.equal(record(coordinator, w.id).closed, true);
	assert.equal(record(coordinator, w.id).result, undefined);
	assert.equal(readTree(owner.parent).closes?.length, 0);
});

test("offline coordinator imports cancellation and must process it before completing its upstream task", async () => {
	const { owner, coordinator, worker, w, c, tmux } = await tree();
	await coordinator.shutdown();
	await owner.shutdown(); // another same-id root runtime does the explicit operation
	const rootAgain = instance({ parent: owner.parent, tmux });
	await rootAgain.start();
	await close(rootAgain, w.id);
	assert.equal(record(coordinator, w.id).closed, undefined);
	const reopened = instance({ parent: c.id, tmux });
	await reopened.start();
	await nextTurn();
	assert.equal(record(reopened, w.id).closed, true);
	assert.equal(record(reopened, w.id).result, undefined);
	assert.ok(reopened.sent.some(({ message }) => String(message.content).includes("canceled by explicit close")));
	await reopened.fire("agent_start");
	await reopened.fire("agent_end", {
		messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "unprocessed" }] }],
	});
	const gate = await reopened.fire("agent_before_settle", { entries: [], continue: false });
	assert.ok(gate.some((g) => (g as { continue?: boolean })?.continue));
	await reopened.fire("agent_settled");
	assert.equal(finals(rootAgain).length, 0);
	await reopened.run();
	assert.equal(finals(rootAgain).length, 1);
	assert.equal(finals(rootAgain)[0].from, c.id);
	assert.equal(worker.shutdowns(), 0, "fake kill is not a shutdown-hook cascade");
});

test("real worker reply mid-close wins semantic state; a genuine late reply still arrives after cancellation", async () => {
	const { owner, coordinator, worker, w, tmux } = await tree();
	const kill = tmux.kill.bind(tmux);
	tmux.kill = async (id) => {
		await worker.run();
		scan(coordinator);
		await kill(id);
	};
	await close(owner, w.id);
	await coordinator.fire("context", { messages: [] });
	assert.equal(record(coordinator, w.id).result?.status, "done");
	assert.equal(
		coordinator.sent.filter(({ message }) => String(message.content).includes("canceled by explicit close")).length,
		0,
	);
	assert.equal(
		coordinator.sent.filter(({ message }) => (message as { details?: { kind?: string } }).details?.kind === "result")
			.length,
		1,
	);
	// A different request with a result arriving after the canceled outcome was queued.
	tmux.kill = kill;
	const later = await launch(coordinator, "worker");
	const lateWorker = instance({ parent: later.id, tmux });
	await lateWorker.start();
	scan(lateWorker);
	await close(coordinator, later.id);
	assert.equal(record(coordinator, later.id).closed, true);
	await lateWorker.run();
	scan(coordinator);
	assert.equal(record(coordinator, later.id).result?.status, "done");
	const saved = JSON.parse(readFileSync(join(agentDir, "squire", "child-tasks", `${coordinator.parent}.json`), "utf8"));
	assert.ok(!saved.outcomes.some((outcome: { key: string }) => outcome.key === `closed:${later.id}`));
});

test("cancellation arriving after the last request forces another coordinator processing run", async () => {
	const { owner, coordinator, w } = await tree();
	await coordinator.fire("agent_start");
	await coordinator.fire("context", { messages: [] });
	await coordinator.fire("agent_end", {
		messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "too early" }] }],
	});
	await close(owner, w.id);
	const gate = await coordinator.fire("agent_before_settle", { entries: [], continue: false });
	assert.ok(gate.some((g) => (g as { continue?: boolean })?.continue));
	await coordinator.fire("agent_settled");
	assert.equal(finals(owner).length, 0);
	assert.equal(record(coordinator, w.id).closed, true);
	await coordinator.run();
	assert.equal(finals(owner).length, 1);
});

test("fresh live cancellation wakes a stopped root, but stopped prior outcomes stay held on reopen", async () => {
	const { owner, c, tmux } = await tree();
	await owner.run("aborted");
	await close(owner, c.id);
	const notice = owner.sent.find(({ message }) => String(message.content).includes("canceled by explicit close"));
	assert.equal((notice?.options as { triggerTurn?: boolean } | undefined)?.triggerTurn, true);
	await owner.run("aborted");
	await owner.shutdown();
	const again = instance({ parent: owner.parent, tmux });
	await again.start();
	await nextTurn();
	assert.equal(again.sent.length, 0, "explicit stop holds prior replay on reopen");
	const path = join(agentDir, "squire", "child-tasks", `${owner.parent}.json`);
	assert.equal(JSON.parse(readFileSync(path, "utf8")).outcomes.length, 1);
	await again.run();
	assert.equal(JSON.parse(readFileSync(path, "utf8")).outcomes.length, 0);
});

test("same-id reattached coordinator closes CURRENT verified locator, not historical parent window", async () => {
	const { owner, coordinator, c, w, tmux } = await tree();
	await coordinator.shutdown();
	tmux.windows.delete(c.windowId);
	await reconcileTree(owner.parent, tmux);
	tmux.addWindow(c.windowId, "unrelated-recycled");
	tmux.addWindow("@new", "manual");
	const current = Object.assign(new FakeTmux(), { currentWindow: async () => ({ id: "@new", name: "manual" }) });
	current.listWindows = () => tmux.listWindows();
	const reopened = instance({ parent: c.id, tmux: current });
	await reopened.start();
	assert.equal(readTree(owner.parent).entries.find((entry) => entry.id === c.id)?.windowId, "@new");
	const result = await close(owner, c.id);
	assert.equal(result.complete, true);
	assert.deepEqual(tmux.killed, [w.windowId, "@new"]);
	assert.equal(tmux.windows.has(c.windowId), true);
});

test("partial kill errors persist successes, fence descendants, and explicit retry converges", async () => {
	const { owner, coordinator, c, w, tmux } = await tree();
	const kill = tmux.kill.bind(tmux);
	tmux.kill = async (id) => {
		if (id === w.windowId) throw new Error("injected worker failure");
		await kill(id);
	};
	const result = await owner.toolCall("delegation_close", { id: c.id });
	assert.equal((result as { isError?: boolean }).isError, true);
	const details = result.structuredContent as CloseDetails;
	assert.equal(details.closed, false);
	assert.equal(details.members.find((m) => m.id === c.id)?.closed, true);
	assert.equal(details.members.find((m) => m.id === w.id)?.outcome, "error");
	assert.ok(tmux.windows.has(w.windowId));
	await assert.rejects(coordinator.toolCall("delegate", { agent: "worker", task: "escape" }), /closing/);
	tmux.kill = kill;
	const retry = await close(owner, c.id);
	assert.equal(retry.complete, true);
	assert.equal(readTree(owner.parent).closes?.length, 0);
});

test("root panel close-all confirmation is root-only and preserves shared companion windows", async () => {
	const { owner, coordinator, c, w, tmux } = await tree({ ui: { confirm: [false, true] } });
	const other = instance({ tmux });
	await other.start();
	const foreign = await launch(other, "coordinator");
	owner.queueCustom(keyScript(["a"]));
	owner.queueCustom(keyScript(["escape"]));
	await owner.command("delegates");
	assert.equal(tmux.killed.length, 0);
	owner.queueCustom(keyScript(["a"]));
	owner.queueCustom(keyScript(["escape"]));
	await owner.command("delegates");
	assert.deepEqual(new Set(tmux.killed), new Set([c.windowId, w.windowId]));
	assert.ok(tmux.windows.has(foreign.windowId));
	coordinator.context.mode = "tui";
	const script = keyScript(["a", "escape"]);
	coordinator.queueCustom(script);
	await coordinator.command("delegates");
	assert.ok(!script.frames[0].includes("a close all"));
});

test("closed coordinator can be resumed by direct parent, with a new lifetime charge and usable branch", async () => {
	const { owner, coordinator, worker, c, w, tmux } = await tree();
	await close(owner, c.id);
	await coordinator.shutdown();
	await worker.shutdown();
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(
		join(sessionDir, `coordinator_${c.id}.jsonl`),
		`${JSON.stringify({ type: "session", version: 3, id: c.id, timestamp: "", cwd: root })}\n`,
	);
	const before = treeCounts(readTree(owner.parent)).lifetime;
	const resumed = (await owner.toolCall("delegation_resume", { id: c.id, task: "new task" })).structuredContent as {
		id: string;
	};
	assert.equal(treeCounts(readTree(owner.parent)).lifetime, before + 1);
	const restored = instance({ parent: c.id, tmux });
	await restored.start();
	scan(restored);
	assert.equal(record(restored, w.id).closed, true);
	assert.equal(record(restored, w.id).result, undefined);
	const next = await launch(restored, "worker");
	assert.notEqual(next.id, w.id);
	assert.equal(readIdentity(next.id)?.parent, c.id);
	await assert.rejects(owner.toolCall("delegation_resume", { id: c.id, task: "stale" }), /already resumed/);
	await assert.rejects(owner.toolCall("delegation_close", { id: c.id }), /resumed/);
	assert.equal(readTree(owner.parent).entries.find((entry) => entry.id === resumed.id)?.closing, undefined);
});

test("a parent-authenticated start without shared history can still resume; unknown ids are not close-all", async () => {
	const tmux = new FakeTmux();
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(
		join(sessionDir, "legacy_legacy.jsonl"),
		`${JSON.stringify({ type: "session", version: 3, id: "legacy", timestamp: "", cwd: root })}\n`,
	);
	const owner = instance({
		tmux,
		entries: [
			{
				customType: "delegate",
				data: {
					id: "legacy",
					requestId: "old-task",
					agent: "worker",
					model: "alpha/fast-model",
					thinking: "medium",
					windowId: "@old",
					windowName: "old",
				},
			},
		],
	});
	await owner.start();
	const resumed = await owner.toolCall("delegation_resume", { id: "legacy", task: "continue" });
	assert.equal((resumed.structuredContent as { resumedFrom: string }).resumedFrom, "legacy");
	await assert.rejects(owner.toolCall("delegation_close", { id: "" }), /no delegation/);
	assert.equal(tmux.killed.length, 0);
});

test("close after kill publication error reports actual side effect, never false completion", async () => {
	const { owner, w, tmux } = await tree();
	const saved = readFileSync(treePath(owner.parent), "utf8");
	const kill = tmux.kill.bind(tmux);
	tmux.kill = async (id) => {
		await kill(id);
		writeFileSync(treePath(owner.parent), "null");
	};
	const result = await owner.toolCall("delegation_close", { id: w.id });
	const details = result.structuredContent as CloseDetails;
	assert.equal(details.complete, false);
	assert.equal(details.killed, true);
	assert.match(details.members[0].error!, /was killed.*publication failed/);
	writeFileSync(treePath(owner.parent), saved);
	assert.ok(!tmux.windows.has(w.windowId));
});

test("ordinary owner shutdown does not cascade; close retains actual managed worktree files and branch", async () => {
	const { owner, coordinator, c, tmux } = await tree();
	await owner.shutdown();
	await coordinator.shutdown();
	assert.equal(tmux.killed.length, 0);
	const reopened = instance({ parent: owner.parent, tmux });
	await reopened.start();
	const source = join(root, "close-repo");
	mkdirSync(source);
	const git = (...args: string[]) =>
		execFileSync("git", args, {
			cwd: source,
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "Fixture",
				GIT_AUTHOR_EMAIL: "fixture@example.invalid",
				GIT_COMMITTER_NAME: "Fixture",
				GIT_COMMITTER_EMAIL: "fixture@example.invalid",
			},
		})
			.toString()
			.trim();
	git("init", "-q", "-b", "main");
	writeFileSync(join(source, "tracked.txt"), "base");
	git("add", ".");
	git("commit", "-qm", "base");
	const worktree = await reopened.toolCall("delegate", {
		agent: "worker",
		task: "write",
		worktree: "close-retain",
		worktree_source: source,
	});
	const launchInfo = worktree.structuredContent as { id: string; cwd: string };
	const file = join(launchInfo.cwd, "retained.txt");
	writeFileSync(file, "important work");
	await close(reopened, c.id);
	await close(reopened, launchInfo.id);
	assert.equal(readFileSync(file, "utf8"), "important work");
	assert.ok(existsSync(join(launchInfo.cwd, ".git")));
	assert.ok(git("show-ref", "--verify", "refs/heads/close-retain"));
});
