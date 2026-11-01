import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import type { Delegation } from "../src/results.ts";
import { DELEGATE_WIDGET_KEY, WIDGET_REFRESH_MS } from "../src/widget.ts";
import { titleMirrorPath } from "../src/widget-title.ts";
import { agentDir, agentFile, cleanup, resetRoot, writeAgent } from "./harness.ts";
import { envelopes, mailSession, nextTurn, scan } from "./mail-harness.ts";

type Session = ReturnType<typeof mailSession>;
const active: Session[] = [];

function instance(options: Parameters<typeof mailSession>[0] = {}): Session {
	const value = mailSession({ mode: "tui", ...options });
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
	for (const value of active.splice(0).reverse()) await value.shutdown();
});
after(cleanup);

async function frameMatches(value: Session, pattern: RegExp): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!pattern.test(frame(value)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.match(frame(value), pattern);
}
async function settle(): Promise<void> {
	for (let n = 0; n < 4; n++) await nextTurn();
}
async function launch(parent: Session, agent: string, label: string): Promise<Delegation> {
	const result = await parent.toolCall("delegate", { agent, label, task: "do work" });
	return parent.entries.find((entry) => entry.data.id === (result.structuredContent as { id: string }).id)!
		.data as Delegation;
}
function frame(value: Session): string {
	return value.widgets.get(DELEGATE_WIDGET_KEY)?.render(140).join("\n") ?? "";
}

test("nested status views never broaden direct widget rows, completion barrier or root poll authority", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const owner = instance();
	const c = await launch(owner, "coordinator", "direct");
	const coordinator = instance({ parent: c.id, tmux: owner.tmux });
	await coordinator.start();
	scan(coordinator);
	const w = await launch(coordinator, "worker", "grandchild");
	const worker = instance({ parent: w.id, tmux: owner.tmux, mode: "json" });
	await worker.start();
	scan(worker);
	await settle();
	assert.match(frame(owner), /coordinator-direct/);
	assert.doesNotMatch(frame(owner), /worker-grandchild/);
	assert.match(frame(coordinator), /worker-grandchild/);
	const status = (await owner.toolCall("delegation_status", {})).structuredContent as {
		delegations: { id: string; parent: string; canResume: boolean }[];
	};
	assert.deepEqual(
		status.delegations.map((row) => row.id),
		[c.id, w.id],
	);
	assert.equal(status.delegations[1].parent, c.id);
	assert.equal(status.delegations[1].canResume, false);
	await coordinator.run();
	assert.equal(envelopes(owner.parent, "new").filter((mail) => mail.in_reply_to.length).length, 0);
	await worker.run();
	scan(coordinator);
	await frameMatches(coordinator, /worker-grandchild.*done/);
	assert.doesNotMatch(frame(owner), /worker-grandchild/);
	assert.equal(owner.sent.length, 0, "raw descendant reports remain at their direct parent");
	await coordinator.run();
	scan(owner);
	await frameMatches(owner, /coordinator-direct.*done/);
	assert.equal(owner.sent.length, 1);
	// Keep a new descendant running after the root's only direct task is done.
	const later = await launch(coordinator, "worker", "later-descendant");
	await coordinator.shutdown();
	owner.tmux.exit(later.windowId);
	const scans = owner.scan.calls;
	t.mock.timers.tick(5000);
	await settle();
	assert.equal(owner.scan.calls, scans, "read-only status descendants cannot restart the root task poll");
	assert.equal(
		owner.entries.some((entry) => entry.data.id === later.id),
		false,
	);
	assert.equal(owner.sent.length, 1);
});

test("losing same-id runtimes cannot create widgets, overwrite native title mirrors or tear down the owner", async () => {
	const owner = instance();
	owner.pi.setSessionName("Owner native name");
	await launch(owner, "worker", "owned");
	await settle();
	const mirror = titleMirrorPath(owner.parent);
	assert.equal(existsSync(mirror), true);
	const saved = readFileSync(mirror, "utf8");
	const duplicate = instance({ parent: owner.parent, tmux: owner.tmux, entries: owner.entries });
	duplicate.pi.setSessionName("Losing native name");
	await duplicate.start();
	await settle();
	assert.equal(duplicate.shutdowns(), 1);
	assert.equal(duplicate.widgetCalls.length, 0);
	await duplicate.fire("session_info_changed", { name: "Still losing" });
	await duplicate.shutdown();
	assert.equal(readFileSync(mirror, "utf8"), saved);
	assert.match(frame(owner), /worker-owned/);
	await owner.fire("session_info_changed", { name: "Owner renamed" });
	assert.equal(JSON.parse(readFileSync(mirror, "utf8")).name, "Owner renamed");
	await assert.rejects(duplicate.toolCall("delegate", { agent: "worker", task: "no" }), /inactive/);
});

test("failed staged input still tears down widget observers and title publisher before ownership release", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const owner = instance();
	const direct = await launch(owner, "worker", "failed-drain");
	const child = instance({ parent: direct.id, tmux: owner.tmux, mode: "json" });
	await child.start();
	scan(child);
	await settle();
	assert.match(frame(owner), /worker-failed-drain/);
	assert.equal(existsSync(titleMirrorPath(owner.parent)), true);
	owner.pi.sendMessage = () => {
		throw new Error("injected display failure");
	};
	await child.run();
	scan(owner);
	assert.ok(owner.errors.some((message) => message.includes("input retained")));
	await assert.rejects(owner.toolCall("delegation_status", {}), /input processing failed/);
	await owner.shutdown();
	assert.equal(frame(owner), "");
	assert.equal(existsSync(titleMirrorPath(owner.parent)), false);
	const calls = owner.widgetCalls.length;
	t.mock.timers.tick(WIDGET_REFRESH_MS * 2);
	await settle();
	assert.equal(owner.widgetCalls.length, calls, "a failed owner's observation timer is cleaned up too");
	const replacement = instance({ parent: owner.parent, tmux: owner.tmux, entries: owner.entries });
	await replacement.start();
	await settle();
	assert.match(frame(replacement), /worker-failed-drain.*done/);
	const mirror = readFileSync(titleMirrorPath(owner.parent), "utf8");
	await owner.shutdown();
	assert.equal(readFileSync(titleMirrorPath(owner.parent), "utf8"), mirror);
	assert.match(frame(replacement), /worker-failed-drain.*done/);
});
