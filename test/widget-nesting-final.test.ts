import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { readChildRecords } from "../src/child-tasks.ts";
import { readIdentity } from "../src/identity.ts";
import type { Delegation, StartedRecorded } from "../src/results.ts";
import { readTree } from "../src/tree-registry.ts";
import { DELEGATE_WIDGET_KEY } from "../src/widget.ts";
import { LIVE_LAUNCH_ENV, LiveActivityReader } from "../src/widget-live.ts";
import { placementProject } from "../src/window-placement.ts";
import { FakeTmux } from "./fake-tmux.ts";
import { agentDir, agentFile, cleanup, keyScript, resetRoot, root, sessionDir, writeAgent } from "./harness.ts";
import { mailSession, nextTurn, scan } from "./mail-harness.ts";

type Session = ReturnType<typeof mailSession>;
const active: Session[] = [];
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
	for (const s of active.splice(0).reverse()) await s.shutdown();
});
after(cleanup);

function instance(options: Parameters<typeof mailSession>[0] = {}, launchId?: string): Session {
	if (launchId) process.env[LIVE_LAUNCH_ENV] = JSON.stringify({ version: 1, sessionId: options.parent, launchId });
	else delete process.env[LIVE_LAUNCH_ENV];
	const s = mailSession({ mode: "tui", ...options });
	active.push(s);
	return s;
}
async function settle(): Promise<void> {
	for (let n = 0; n < 10; n++) await nextTurn();
}
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail("combined dashboard/nesting observation timed out");
}
function frame(s: Session): string {
	return s.widgets.get(DELEGATE_WIDGET_KEY)?.render(150).join("\n") ?? "";
}
function local(s: Session, id: string): StartedRecorded {
	return readChildRecords(s.parent).find((record) => record.id === id) as StartedRecorded;
}
async function launch(s: Session, agent: string, label: string, cwd?: string): Promise<Delegation> {
	const response = await s.toolCall("delegate", { agent, label, task: "work", ...(cwd ? { cwd } : {}) });
	return s.entries.find((entry) => entry.data.id === (response.structuredContent as { id: string }).id)!
		.data as Delegation;
}
function directory(name: string): string {
	const path = join(root, name);
	mkdirSync(path, { recursive: true });
	return path;
}
async function tree(options: Parameters<typeof mailSession>[0] = {}) {
	const tmux = options.tmux ?? new FakeTmux();
	const owner = instance({ tmux, ...options });
	const c = await launch(owner, "coordinator", "branch");
	const coordinator = instance({ parent: c.id, tmux }, c.id);
	await coordinator.start();
	scan(coordinator);
	const w = await launch(coordinator, "worker", "nested");
	return { owner, coordinator, c, w, tmux };
}
async function panel(s: Session, keys: string[]): Promise<ReturnType<typeof keyScript>> {
	const script = keyScript(keys, 180);
	s.queueCustom(script);
	s.queueCustom(keyScript(["escape"], 180));
	await s.command("delegates");
	return script;
}

test("widget details close the entire subtree and dashboard resume inherits original placement across root cwd changes", async () => {
	const a = directory("original-root");
	const b = directory("coordinator-cwd");
	const d = directory("reopened-root");
	const base = placementProject(a).companion;
	const tmux = new FakeTmux();
	tmux.addWindow("@user", "unrelated anchor", base); // Unmarked base must survive every operation.
	const owner = instance({ tmux, cwd: a, ui: { confirm: [true] } });
	const c = await launch(owner, "coordinator", "cross-project", b);
	const coordinator = instance({ parent: c.id, cwd: b, tmux }, c.id);
	await coordinator.start();
	scan(coordinator);
	const w = await launch(coordinator, "worker", "grandchild");
	assert.equal(c.identity?.rootPlacement, base);
	assert.equal(w.identity?.rootPlacement, base);
	assert.equal(tmux.opened[0].session, `${base}-2`);
	assert.equal(tmux.opened[1].session, `${base}-2`);
	await coordinator.fire("tool_execution_start", { toolCallId: "read", toolName: "read", args: {} });
	await until(async () => (await new LiveActivityReader().read(c.id, c.id))?.text === "reading…");
	await until(() => /reading…/.test(frame(owner)));
	assert.equal(owner.terminalKey("down"), true);
	const detail = keyScript(["x"], 180);
	owner.queueCustom(detail);
	owner.queueCustom(keyScript(["escape"], 180));
	assert.equal(owner.terminalKey("enter"), true);
	await until(() => tmux.killed.includes(c.windowId));
	await until(() => owner.confirms.length === 1 && !frame(owner).includes("coordinator-cross-project"));
	assert.match(detail.frames[0], /Delegate: coordinator-cross-project/);
	assert.deepEqual(tmux.killed, [w.windowId, c.windowId]);
	assert.match(owner.confirms[0].message, /entire recorded subtree/);
	assert.equal(local(owner, c.id).closed, true);
	assert.equal(local(coordinator, w.id).closed, undefined, "ancestor never writes foreign semantic records");
	await coordinator.fire("context", { messages: [] });
	assert.equal(local(coordinator, w.id).closed, true);
	assert.equal(local(coordinator, w.id).result, undefined);
	assert.doesNotMatch(frame(owner), /reading…/);
	assert.equal(tmux.windows.has("@user"), true);
	await coordinator.shutdown();
	await owner.shutdown();
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(
		join(sessionDir, `saved_${c.id}.jsonl`),
		`${JSON.stringify({ type: "session", version: 3, id: c.id, cwd: b })}\n`,
	);
	const reopened = instance({ parent: owner.parent, cwd: d, tmux, ui: { editor: ["new task"] } });
	await reopened.start();
	await panel(reopened, ["r"]);
	const resumed = reopened.entries.filter((entry) => entry.data.requestId).at(-1)!.data as Delegation;
	assert.equal(resumed.sessionId, c.id);
	assert.equal(resumed.identity?.rootPlacement, base);
	assert.equal(tmux.opened.at(-1)?.session, `${base}-2`);
	const restored = instance({ parent: c.id, cwd: b, tmux }, resumed.id);
	await restored.start();
	scan(restored);
	const next = await launch(restored, "worker", "after-resume");
	assert.equal(next.identity?.rootPlacement, base);
	assert.equal(tmux.opened.at(-1)?.session, `${base}-2`);
	assert.equal(readIdentity(c.id)?.rootPlacement, base);
	for (const entry of readTree(owner.parent).entries) {
		assert.equal(entry.identity.rootPlacement, base);
		assert.equal(entry.launch?.identity?.rootPlacement, base);
	}
	assert.equal(tmux.windows.has("@user"), true);
});

test("widget branch browsing excludes siblings, keeps title/ancestors, and grandchild resume remains direct-parent-only", async () => {
	const { owner, coordinator, c, w, tmux } = await tree();
	const sibling = await launch(owner, "worker", "sibling");
	// Native metadata is read from the session file; no new naming transport.
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(
		join(sessionDir, `saved_${c.id}.jsonl`),
		[
			JSON.stringify({ type: "session", id: c.id, cwd: coordinator.context.cwd }),
			JSON.stringify({ type: "session_info", name: "Renamed branch" }),
			"",
		].join("\n"),
	);
	await until(() => frame(owner).includes("Renamed branch"));
	assert.match(frame(coordinator), /root \(parent\)/);
	owner.terminalKey("down"); // Newer sibling first.
	owner.terminalKey("down");
	const branch = keyScript(["b", "down", "enter", "r"], 220);
	const back = keyScript(["escape"], 220);
	owner.queueCustom(branch);
	owner.queueCustom(back);
	owner.terminalKey("enter");
	await until(() => branch.frames.some((text) => text.includes("Delegate: worker-nested")));
	assert.match(branch.frames[0], /Delegate: coordinator-branch.*Renamed branch/);
	assert.match(branch.frames[1], /Delegate branch:/);
	assert.match(branch.frames[1], /worker-nested/);
	assert.doesNotMatch(branch.frames[1], /worker-sibling/);
	await until(() =>
		[...owner.warnings, ...owner.notes].some((text) => /cannot be resumed|no delegation can be resumed/.test(text)),
	);
	// The widget's dashboard must consume its own escape before the next panel queues scripts.
	await until(() => back.frames.length > 1);
	await owner.command("delegate-resume", `${w.id} retry`);
	assert.ok(owner.errors.some((text) => text.includes("only direct parent")));
	assert.equal(tmux.opened.length, 3);
	const overall = await panel(owner, ["escape"]);
	assert.match(overall.frames[0], /worker-sibling/);
	assert.match(overall.frames[0], /worker-nested/);
	assert.equal(tmux.windows.has(sibling.windowId), true);
	assert.equal(local(coordinator, w.id).closed, undefined);
});

test("dashboard subtree close preserves successful members and reports partial errors before explicit retry", async () => {
	const { owner, coordinator, c, w, tmux } = await tree({ ui: { confirm: [true, true] } });
	const kill = tmux.kill.bind(tmux);
	tmux.kill = async (id) => {
		if (id === w.windowId) throw new Error("injected worker kill refusal");
		await kill(id);
	};
	await panel(owner, ["x"]);
	assert.deepEqual(tmux.killed, [c.windowId]);
	assert.ok(owner.errors.some((error) => /Partial close of/.test(error) && error.includes(w.id)));
	assert.ok(owner.errors.some((error) => error.includes("injected worker kill refusal")));
	assert.equal(readTree(owner.parent).entries.find((entry) => entry.id === c.id)?.closed, true);
	assert.equal(readTree(owner.parent).entries.find((entry) => entry.id === w.id)?.closed, undefined);
	assert.equal(readTree(owner.parent).closes?.length, 1);
	assert.equal(local(coordinator, w.id).closed, undefined);
	tmux.kill = kill;
	await panel(owner, ["x"]);
	assert.deepEqual(tmux.killed, [c.windowId, w.windowId], "confirmed successes are not killed twice");
	assert.equal(readTree(owner.parent).closes?.length, 0);
	assert.ok(owner.notes.some((note) => /Closed delegation subtree/.test(note)));
	assert.equal(local(coordinator, w.id).closed, undefined);
	await coordinator.fire("context", { messages: [] });
	assert.equal(local(coordinator, w.id).closed, true);
});

test("one dashboard offers confirmed root close-all, never coordinator close-all or foreign-root kills", async () => {
	const { owner, coordinator, c, w, tmux } = await tree({ ui: { confirm: [false, true] } });
	const direct = await launch(owner, "worker", "other-branch");
	const foreign = instance({ tmux });
	const untouched = await launch(foreign, "worker", "foreign");
	const childScript = keyScript(["a", "escape"], 180);
	coordinator.queueCustom(childScript);
	await coordinator.command("delegates");
	assert.doesNotMatch(childScript.frames[0], /a close all subtrees/);
	assert.equal(coordinator.confirms.length, 0);
	const canceled = await panel(owner, ["a"]);
	assert.match(canceled.frames[0], /a close all subtrees/);
	assert.equal(tmux.killed.length, 0);
	await panel(owner, ["a"]);
	assert.equal(owner.confirms.length, 2);
	assert.equal(owner.confirms[1].title, "Close all delegate subtrees");
	assert.deepEqual(new Set(tmux.killed), new Set([c.windowId, w.windowId, direct.windowId]));
	assert.equal(tmux.windows.has(untouched.windowId), true);
	assert.equal(readTree(owner.parent).closes?.length, 0);
	assert.equal(local(coordinator, w.id).closed, undefined);
	const empty = instance({ ui: { confirm: [true] } });
	const script = await panel(empty, ["a"]);
	assert.match(script.frames[0], /No open delegates.*a close all subtrees/);
	assert.equal(empty.confirms.length, 1, "root close-all is reachable even with no rows");
});

test("root close-all partial failure stays an error and fenced until a confirmed retry", async () => {
	const { owner, w, tmux } = await tree({ ui: { confirm: [true, true] } });
	const kill = tmux.kill.bind(tmux);
	tmux.kill = async (id) => {
		if (id === w.windowId) throw new Error("close-all member unavailable");
		await kill(id);
	};
	await panel(owner, ["a"]);
	assert.ok(owner.errors.some((error) => error.includes("Partial close of") && error.includes(w.id)));
	assert.equal(readTree(owner.parent).closes?.length, 1);
	await assert.rejects(owner.toolCall("delegate", { agent: "worker", task: "fenced" }), /closing/);
	tmux.kill = kill;
	await panel(owner, ["a"]);
	assert.equal(readTree(owner.parent).closes?.length, 0);
	assert.ok(owner.notes.some((note) => note.includes("Closed delegation subtree")));
});

test("ownership loss during dashboard close-all confirmation refuses before any fence or window effect", async () => {
	const { owner, tmux } = await tree();
	await settle();
	const ownerFile = join(agentDir, "squire", "owners", `${owner.parent}.json`);
	const saved = readFileSync(ownerFile, "utf8");
	let release!: () => void, entered!: () => void;
	const ready = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	owner.context.ui.confirm = async () => {
		entered();
		await pending;
		return true;
	};
	owner.queueCustom(keyScript(["a"], 180));
	const action = owner.command("delegates");
	await ready;
	writeFileSync(ownerFile, JSON.stringify({ ...JSON.parse(saved), token: "replacement-runtime" }));
	try {
		release();
		await assert.rejects(action, /inactive/);
		assert.equal(tmux.killed.length, 0);
		assert.equal(readTree(owner.parent).closes?.length ?? 0, 0);
	} finally {
		writeFileSync(ownerFile, saved);
	}
});
