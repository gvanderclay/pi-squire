import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readIdentity } from "../src/identity.ts";
import type { Delegation } from "../src/results.ts";
import { readTree, reconcileTree, treeCounts, treeTransaction } from "../src/tree-registry.ts";
import { FakeTmux } from "./fake-tmux.ts";
import { agentDir, agentFile, cleanup, keyScript, resetRoot, root, sessionDir, writeAgent } from "./harness.ts";
import { envelopes, mailSession, nextTurn, scan } from "./mail-harness.ts";

type Session = ReturnType<typeof mailSession>;
const active: Session[] = [];
const instance = (options: Parameters<typeof mailSession>[0] = {}): Session => {
	const value = mailSession(options);
	active.push(value);
	return value;
};
beforeEach(() => {
	resetRoot();
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(join(agentDir, "squire", "settings.json"), JSON.stringify({ maxDepth: 3, maxConcurrentDelegates: 8 }));
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
async function tree(): Promise<{
	owner: Session;
	coordinator: Session;
	worker: Session;
	c: Delegation;
	w: Delegation;
	tmux: FakeTmux;
}> {
	const tmux = new FakeTmux();
	const owner = instance({ tmux, mode: "tui" });
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
const status = async (value: Session): Promise<Record<string, unknown>[]> =>
	((await value.toolCall("delegation_status", {})).structuredContent as { delegations: Record<string, unknown>[] })
		.delegations;
test("registry views are subtree scoped and never inject grandchildren's raw reports", async () => {
	const { owner, coordinator, worker, w, c, tmux } = await tree();
	const sibling = await launch(owner, "coordinator");
	const second = instance({ parent: sibling.id, tmux });
	await second.start();
	const other = await launch(second, "worker");
	assert.deepEqual(
		(await status(coordinator)).map((row) => row.id),
		[w.id],
	);
	assert.equal((await status(owner)).length, 4);
	const grandchild = (await status(owner)).find((row) => row.id === w.id)!;
	assert.equal(grandchild.parent, c.id);
	assert.equal(grandchild.root, owner.parent);
	assert.equal(grandchild.depth, 2);
	assert.equal(grandchild.canResume, false);
	await worker.run();
	scan(coordinator);
	await nextTurn();
	assert.equal(owner.sent.length, 0, "worker report belongs only to coordinator");
	assert.equal((await status(owner)).find((row) => row.id === w.id)!.status, "done");
	tmux.attachClient("client", 1);
	await owner.command("delegate-open", `${w.id} --switch`);
	assert.equal(tmux.switches.at(-1)?.windowId, w.windowId);
	await coordinator.command("delegate-open", `${other.id} --peek`);
	assert.equal(tmux.captures.length, 0);
	const script = keyScript(["escape"], 250);
	owner.queueCustom(script);
	await owner.command("delegates");
	assert.match(script.frames[0], /depth: 1/);
	assert.ok(script.frames[0].includes("coordinator") && script.frames[0].includes("worker"));
	assert.ok(
		script.frames[0].indexOf(w.windowName) < script.frames[0].indexOf(sibling.windowName),
		"worker belongs below its own parent, not after a sibling branch",
	);
	const before = tmux.killed.length;
	await assert.rejects(owner.toolCall("delegation_resume", { id: w.id, task: "again" }), /only direct parent/);
	assert.equal(tmux.killed.length, before);
});
test("offline worker and coordinator replies restore same-id barriers and only direct reports upstream", async () => {
	const { owner, coordinator, worker, c, tmux } = await tree();
	await coordinator.shutdown();
	const opened = tmux.opened.length;
	await worker.run();
	assert.equal(envelopes(c.id, "new").filter((value) => value.in_reply_to.length).length, 1);
	assert.equal(treeCounts(readTree(owner.parent)).concurrent, 1, "waiting coordinator remains charged");
	const restored = instance({ parent: c.id, tmux });
	await restored.start();
	scan(restored);
	await nextTurn();
	assert.equal(restored.sent.length, 1);
	assert.equal(tmux.opened.length, opened);
	assert.equal(envelopes(owner.parent, "new").filter((value) => value.in_reply_to.length).length, 0);
	await owner.shutdown();
	await restored.run();
	const reopened = instance({ parent: owner.parent, tmux });
	await reopened.start();
	scan(reopened);
	assert.equal(reopened.sent.length, 1);
	assert.match(String(reopened.sent[0].message.content), /answer/);
	assert.equal(treeCounts(readTree(owner.parent)).concurrent, 0);
});
test("manual same-id coordinator reopen revives concurrency, not lifetime or parentage", async () => {
	const { owner, coordinator, worker, c, tmux } = await tree();
	await coordinator.shutdown();
	tmux.windows.delete(c.windowId);
	await reconcileTree(owner.parent, tmux);
	assert.deepEqual(treeCounts(readTree(owner.parent)), { concurrent: 1, lifetime: 2 });
	treeTransaction(owner.parent, (state) => {
		state.entries.push({
			...state.entries.find((entry) => entry.id === c.id)!,
			id: "confirmed-failed-resume",
			requestId: undefined,
			launch: undefined,
			resumedFrom: c.id,
			phase: "not-started",
		});
	});
	const current = "@manual";
	tmux.addWindow(current, "manually-reopened");
	const manualTmux = Object.assign(new FakeTmux(), {
		currentWindow: async () => ({ id: current, name: "manually-reopened" }),
	});
	manualTmux.listWindows = () => tmux.listWindows();
	const reopened = instance({ parent: c.id, tmux: manualTmux });
	await reopened.start();
	assert.deepEqual(treeCounts(readTree(owner.parent)), { concurrent: 2, lifetime: 2 });
	await reconcileTree(owner.parent, tmux);
	assert.equal(readTree(owner.parent).entries.find((entry) => entry.id === c.id)!.windowId, current);
	assert.equal((await status(owner)).find((row) => row.id === c.id)!.accounting, "reattached");
	await worker.run();
	scan(reopened);
	await reopened.run();
	scan(owner);
	assert.equal((await status(owner)).find((row) => row.id === c.id)!.status, "done");
	assert.equal(readIdentity(c.id)!.parent, owner.parent);
	assert.deepEqual(treeCounts(readTree(owner.parent)), { concurrent: 0, lifetime: 2 });
});
test("actual Pi fork/clone history is not authority; inherited environment cannot assign identity", async () => {
	const { owner, coordinator, c, w, tmux } = await tree();
	const manager = SessionManager.create(root, sessionDir, { id: owner.parent });
	manager.appendMessage({ role: "user", content: "root history", timestamp: Date.now() });
	manager.appendCustomEntry("delegate", c);
	const path = manager.createBranchedSession(manager.getLeafId()!);
	assert.notEqual(manager.getSessionId(), owner.parent);
	const copy = instance({
		parent: manager.getSessionId(),
		tmux,
		entries: owner.entries,
		sessionHeader: { parentSession: manager.getHeader()?.parentSession ?? path },
	});
	process.env.PI_DELEGATE_PARENT = owner.parent;
	process.env.PI_DELEGATE_ROOT = owner.parent;
	process.env.PI_DELEGATE_AGENT = "coordinator";
	await copy.start();
	assert.equal(readIdentity(copy.parent), undefined);
	assert.equal((await status(copy)).length, 0);
	await assert.rejects(copy.toolCall("delegation_resume", { id: c.id, task: "steal" }), /only direct parent/);
	await copy.command("delegate-resume", `${c.id} steal`);
	assert.match(copy.errors.join("\n"), /only direct parent/);
	assert.equal((await copy.completionsFor("delegate-resume", ""))?.some((row) => row.value === c.id) ?? false, false);
	const nestedCopy = instance({
		parent: `${manager.getSessionId()}-nested`,
		entries: coordinator.entries,
		tmux,
		sessionHeader: { parentSession: manager.getHeader()?.parentSession ?? path },
	});
	await nestedCopy.start();
	await assert.rejects(nestedCopy.toolCall("delegation_resume", { id: w.id, task: "steal" }), /only direct parent/);
});
test("fresh sessions notice recorded owners within the current session directory, without adoption", async () => {
	const { owner, coordinator, c, tmux } = await tree();
	await owner.shutdown();
	await coordinator.shutdown();
	const fresh = instance({ tmux });
	await fresh.start();
	assert.ok(fresh.notes.some((note) => note.includes(owner.parent) && note.includes("Reopen")));
	assert.ok(fresh.notes.some((note) => note.includes(c.id) && note.includes("does not adopt")));
	assert.equal((await status(fresh)).length, 0);
	const elsewhere = instance({ tmux, sessionDir: join(root, "elsewhere") });
	await elsewhere.start();
	assert.equal(
		elsewhere.notes.some((note) => note.includes("earlier session")),
		false,
	);
	assert.equal(tmux.killed.length, 0, "ordinary exits never close children");
});
test("root pending outcomes survive queued-display loss without presenting its final result twice", async () => {
	const tmux = new FakeTmux();
	const owner = instance({ tmux });
	await owner.start();
	const record = await launch(owner, "worker");
	const child = instance({ parent: record.id, tmux });
	await child.start();
	scan(child);
	await child.run();
	scan(owner);
	assert.equal(owner.sent.length, 1);
	await owner.shutdown();
	const reopened = instance({ parent: owner.parent, tmux });
	await reopened.start();
	await nextTurn();
	assert.equal(reopened.sent.filter((item) => item.message.customType === "delegate").length, 0);
	assert.equal(reopened.sent.filter((item) => item.message.customType === "delegate-recovery").length, 1);
	const context = await reopened.fire("context", { messages: [] });
	assert.match(JSON.stringify(context), /answer/);
	await reopened.fire("agent_settled");
	const again = await reopened.fire("context", { messages: [] });
	assert.doesNotMatch(JSON.stringify(again), /answer/);
});
test("direct-parent resume restores coordinator children and offline replies before the new follow-up can settle", async () => {
	const { owner, coordinator, worker, c, tmux } = await tree();
	await coordinator.shutdown();
	tmux.exit(c.windowId);
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(
		join(sessionDir, `saved_${c.id}.jsonl`),
		`${JSON.stringify({ type: "session", id: c.id, version: 3, cwd: root })}\n`,
	);
	await worker.run();
	const resumed = await owner.toolCall("delegation_resume", { id: c.id, task: "summarize both tasks" });
	const latest = (resumed.structuredContent as { id: string }).id;
	assert.notEqual(latest, c.id);
	const reopened = instance({ parent: c.id, tmux });
	await reopened.start();
	scan(reopened);
	await nextTurn();
	assert.equal(reopened.sent.length, 1, "offline child report is restored only to coordinator");
	assert.ok(reopened.userMessages.some((message) => message.text.includes("summarize both tasks")));
	assert.equal(owner.sent.length, 0);
	assert.deepEqual(treeCounts(readTree(owner.parent)), { concurrent: 1, lifetime: 3 });
	await reopened.run();
	scan(owner);
	assert.equal(owner.sent.length, 1, "one correlated report covers both root requests");
	assert.deepEqual(treeCounts(readTree(owner.parent)), { concurrent: 0, lifetime: 3 });
	assert.equal(readIdentity(c.id)!.depth, 1);
});
test("notice budgets are explicit and do not adopt or scan unrelated session directories", async () => {
	const tmux = new FakeTmux();
	for (let i = 0; i < 70; i++) {
		const id = `notice-child-${i}`,
			owner = `notice-owner-${i}`,
			tree = `notice-root-${i}`;
		tmux.addWindow(`@notice-${i}`, id);
		treeTransaction(tree, (state) =>
			state.entries.push({
				id,
				sessionId: id,
				ownerPid: process.pid,
				phase: "started",
				requestId: `task-${i}`,
				identity: { root: tree, parent: owner, depth: 1, chain: ["worker"], agent: "worker", autoExit: false },
				windowId: `@notice-${i}`,
				windowName: id,
				sessionDir,
			}),
		);
	}
	const fresh = instance({ tmux });
	await fresh.start();
	assert.equal(fresh.notes.filter((message) => message.includes("earlier session")).length, 10);
	assert.match(fresh.warnings.join("\n"), /newest 64 trees and 10 owners/);
	assert.equal((await status(fresh)).length, 0);
	assert.equal(tmux.killed.length, 0);
});
test("lowered depth and a live manually-opened child refuse resume before reservation or window kill", async () => {
	const { owner, coordinator, worker, w, tmux } = await tree();
	tmux.exit(w.windowId);
	await assert.rejects(coordinator.toolCall("delegation_resume", { id: w.id, task: "again" }), /already open/);
	assert.deepEqual(treeCounts(readTree(owner.parent)), { concurrent: 2, lifetime: 2 });
	assert.equal(tmux.killed.length, 0);
	await worker.shutdown();
	writeFileSync(join(agentDir, "squire", "settings.json"), JSON.stringify({ maxDepth: 1 }));
	await assert.rejects(coordinator.toolCall("delegation_resume", { id: w.id, task: "again" }), /maxDepth/);
	assert.equal(tmux.killed.length, 0);
	assert.equal(treeCounts(readTree(owner.parent)).lifetime, 2);
});
test("registry-only positive launch restores local correlation, while accounting-only entries stay unknown", async () => {
	const { owner, c, tmux } = await tree();
	await owner.shutdown();
	rmSync(join(agentDir, "squire", "child-tasks", `${owner.parent}.json`));
	const reopened = instance({ parent: owner.parent, tmux });
	await reopened.start();
	assert.equal((await status(reopened)).find((row) => row.id === c.id)!.sessionId, c.id);
	treeTransaction(owner.parent, (state) => {
		state.entries.find((entry) => entry.id === c.id)!.finished = true;
	});
	const row = (await status(reopened)).find((value) => value.id === c.id)!;
	assert.equal(row.accounting, "finished");
	assert.equal(row.status, undefined);
});
