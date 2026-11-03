import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type Identity, writeIdentity } from "../src/identity.ts";
import type { Delegation } from "../src/results.ts";
import { visibleRecordFacts } from "../src/tree-view.ts";
import { DELEGATE_WIDGET_KEY, WIDGET_REFRESH_MS } from "../src/widget.ts";
import { ancestorSessions } from "../src/widget-ancestors.ts";
import { DirectDelegateView } from "../src/widget-data.ts";
import { LiveActivityReader } from "../src/widget-live.ts";
import { renderDelegateWidget } from "../src/widget-render.ts";
import { WidgetSelection } from "../src/widget-selection.ts";
import { FakeTmux } from "./fake-tmux.ts";
import { agentDir, agentFile, cleanup, resetRoot, session, sessionDir, writeAgent } from "./harness.ts";
import { mailSession, scan } from "./mail-harness.ts";

type Session = ReturnType<typeof mailSession>;
const active: Session[] = [];
beforeEach(() => {
	resetRoot();
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(join(agentDir, "squire", "settings.json"), JSON.stringify({ maxDepth: 5 }));
	writeAgent("coord", agentFile({ model: "alpha/fast-model", allow_nested_delegation: "true", auto_exit: "false" }));
	writeAgent("leaf", agentFile({ model: "alpha/fast-model", auto_exit: "false" }));
});
afterEach(async () => {
	for (const s of active.splice(0).reverse()) await s.shutdown();
});
after(cleanup);
function instance(options: Parameters<typeof mailSession>[0] = {}): Session {
	const s = mailSession({ mode: "tui", ...options });
	active.push(s);
	return s;
}
function frame(s: Session): string {
	return s.widgets.get(DELEGATE_WIDGET_KEY)?.render(180).join("\n") ?? "";
}
async function until(check: () => boolean, message = "widget state"): Promise<void> {
	const end = Date.now() + 5000;
	while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
	assert.ok(check(), message);
}
async function launch(s: Session, agent: string, label: string): Promise<Delegation> {
	const result = await s.toolCall("delegate", { agent, label, task: "inspect" });
	return s.entries.find((e) => e.data.id === (result.structuredContent as { id: string }).id)!.data as Delegation;
}
const own = (parent: string, root: string, depth: number): Identity => ({
	parent,
	root,
	depth,
	agent: "coord",
	chain: ["coord"],
	rootPlacement: "project-delegate-session",
	autoExit: false,
});

test("five view shapes, root-to-parent chain, leaf cap0 and parent-first selection, direct-only main rows", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const root = instance();
	const c = await launch(root, "coord", "first");
	const coord = instance({ parent: c.id, tmux: root.tmux });
	await coord.start();
	scan(coord);
	const w = await launch(root, "leaf", "sibling");
	const leaf = instance({ parent: w.id, tmux: root.tmux });
	await leaf.start();
	const g = await launch(coord, "coord", "second");
	const grand = instance({ parent: g.id, tmux: root.tmux });
	await grand.start();
	scan(grand);
	const l = await launch(coord, "leaf", "grand-leaf");
	const grandLeaf = instance({ parent: l.id, tmux: root.tmux });
	await grandLeaf.start();
	const h = await launch(grand, "leaf", "deep");
	await until(() => frame(grand).includes("leaf-deep"));
	assert.match(frame(root), /^Delegates/);
	assert.doesNotMatch(frame(root), /coord-second|leaf-deep|grand-leaf/);
	assert.match(frame(coord), /^↑ root \(parent\)/);
	assert.doesNotMatch(frame(coord), /leaf-sibling|leaf-deep/);
	await until(() => frame(grandLeaf).includes("(parent)"));
	assert.doesNotMatch(frame(grandLeaf), /Delegates|grand-leaf|\(you\)/);
	assert.match(frame(grandLeaf), /^↑ root\n└─ ↑ coord-first \(parent\)/);
	assert.match(frame(grand), /^↑ root\n└─ ↑ coord-first \(parent\)\n {2}└─ Delegates/);
	assert.equal(grand.terminalKey("down"), true);
	assert.match(frame(grand), /▸ └─ ↑ coord-first \(parent\)/);
	grand.terminalKey("up");
	assert.match(frame(grand), /▸ ↑ root/);
	grand.terminalKey("down");
	grand.terminalKey("down");
	assert.match(frame(grand), /▸ .*leaf-deep/);
	writeFileSync(
		join(agentDir, "squire", "settings.json"),
		JSON.stringify({ maxDepth: 5, delegateWidgetMaxEntries: 0 }),
	);
	t.mock.timers.tick(WIDGET_REFRESH_MS);
	await until(() => !frame(grand).includes("leaf-deep"));
	assert.match(frame(grand), /↑ root/);
	assert.doesNotMatch(frame(grand), /Delegates/);
	assert.ok(grand.statuses.some(({ key, text }) => key === "delegate" && text?.includes("1 delegate running")));
	assert.equal(grand.terminalKey("down"), true);
	assert.equal(leaf.terminalKey("down"), true);
	assert.match(frame(leaf), /▸ ↑ root \(parent\)/);
	assert.equal(h.identity?.parent, g.id);
});

test("collapsed counts follow open stable sessions through failure, resume, close and late result without barrier writes", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const root = instance();
	const c = await launch(root, "coord", "direct");
	const coord = instance({ parent: c.id, tmux: root.tmux });
	await coord.start();
	scan(coord);
	const g = await launch(coord, "coord", "grand");
	const grand = instance({ parent: g.id, tmux: root.tmux });
	await grand.start();
	scan(grand);
	const w = await launch(grand, "leaf", "failed");
	const leaf = instance({ parent: w.id, tmux: root.tmux, mode: "json" });
	await leaf.start();
	scan(leaf);
	leaf.events.emit("message:reply", { to: g.id, inReplyTo: [w.requestId], body: "failure", status: "failed" });
	scan(grand);
	t.mock.timers.tick(WIDGET_REFRESH_MS);
	await until(() => /coord-direct.*\+2/.test(frame(root)), frame(root));
	assert.doesNotMatch(frame(root), /leaf-failed|coord-grand/);
	await leaf.shutdown();
	root.tmux.exit(w.windowId);
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(
		join(sessionDir, `saved_${w.id}.jsonl`),
		`${JSON.stringify({ type: "session", id: w.id, cwd: grand.context.cwd })}\n`,
	);
	const resumed = await grand.toolCall("delegation_resume", { id: w.id, task: "retry" });
	const retryId = (resumed.structuredContent as { id: string }).id;
	const retry = grand.entries.find((entry) => entry.data.id === retryId)!.data as Delegation;
	assert.equal(retry.sessionId, w.id);
	t.mock.timers.tick(WIDGET_REFRESH_MS);
	await until(() => /coord-direct.*\+2/.test(frame(root)), frame(root));
	await grand.toolCall("delegation_close", { id: retry.id });
	t.mock.timers.tick(WIDGET_REFRESH_MS);
	await until(() => /coord-direct.*\+1/.test(frame(root)), frame(root));
	// A genuine late correlated result supersedes missing, never the earlier failed task.
	const late = instance({ parent: w.id, tmux: root.tmux, mode: "json" });
	await late.start();
	late.events.emit("message:reply", {
		to: g.id,
		inReplyTo: [retry.requestId],
		body: "late genuine answer",
		status: "done",
	});
	scan(grand);
	t.mock.timers.tick(WIDGET_REFRESH_MS);
	await until(() => /coord-direct.*\+1/.test(frame(root)), frame(root));
	assert.equal(root.sent.length, 0);
	assert.equal(coord.sent.length, 0);
	assert.equal(
		root.entries.some((entry) => entry.data.id === w.id || entry.data.id === retry.id),
		false,
	);
	await coord.run();
	assert.equal(
		coord.sent.length,
		0,
		"read-only summaries never satisfy a coordinator's child/result processing barrier",
	);
});

test("corrupt descendant owner facts cannot freeze fresh ancestor titles or direct outcome rows", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const root = instance();
	const c = await launch(root, "coord", "current");
	const current = instance({ parent: c.id, tmux: root.tmux });
	await current.start();
	scan(current);
	const d = await launch(current, "coord", "direct");
	const direct = instance({ parent: d.id, tmux: root.tmux });
	await direct.start();
	scan(direct);
	const w = await launch(direct, "leaf", "gone");
	root.tmux.exit(w.windowId);
	t.mock.timers.tick(5000);
	await until(() => direct.entries.some((entry) => entry.data.id === w.id && entry.data.gone === true));
	t.mock.timers.tick(WIDGET_REFRESH_MS);
	await until(() => /coord-direct/.test(frame(current)) && !/\+1/.test(frame(current)));
	const owner = join(agentDir, "squire", "owners", `${encodeURIComponent(w.id)}.json`);
	writeFileSync(owner, "corrupt owner facts");
	await root.fire("session_info_changed", { name: "Fresh ancestor title" });
	direct.events.emit("message:reply", { to: c.id, inReplyTo: [d.requestId], body: "failed result", status: "failed" });
	scan(current);
	t.mock.timers.tick(WIDGET_REFRESH_MS);
	await until(() => /coord-direct.*failed/.test(frame(current)));
	assert.match(frame(current), /↑ root \(parent\).*Fresh ancestor title/);
	assert.match(frame(current), /coord-direct.*failed/);
	assert.doesNotMatch(frame(current), /1 task: 1 missing|coord-direct.*running/);
});

test("provenance exposes unoverlaid semantic facts, registry-only closed is unknown and unreadable tree retains saved facts", async () => {
	const root = instance();
	const c = await launch(root, "coord", "semantic");
	const coord = instance({ parent: c.id, tmux: root.tmux });
	await coord.start();
	const w = await launch(coord, "leaf", "worker");
	const reader = { list: () => root.entries.filter((e) => e.data.requestId).map((e) => e.data) };
	const results = reader as unknown as Parameters<typeof visibleRecordFacts>[0];
	const ctx = root.context as unknown as ExtensionContext;
	let view = visibleRecordFacts(results, ctx, 20, false);
	assert.ok(view.facts.find((f) => f.record.id === w.id)?.semantic);
	writeFileSync(join(agentDir, "squire", "child-tasks", `${encodeURIComponent(c.id)}.json`), "broken");
	view = visibleRecordFacts(results, ctx, 20, false);
	assert.equal(view.facts.find((f) => f.record.id === w.id)?.semantic, undefined);
	assert.equal(view.complete, false);
	writeFileSync(join(agentDir, "squire", "trees", `${encodeURIComponent(root.parent)}.json`), "broken");
	view = visibleRecordFacts(results, ctx, 20, false);
	assert.equal(view.complete, false);
	assert.equal(view.facts[0].semantic?.id, c.id);
});

test("reopened gone direct child can be inspected at current window without rewriting history or counting as running", () => {
	const record = {
		id: "old",
		sessionId: "stable",
		agent: "coord",
		model: "m",
		thinking: "off",
		windowId: "@old",
		windowName: "old",
		requestId: "req",
		gone: true,
	};
	const results = { list: () => [record], running: () => [] } as unknown as Parameters<DirectDelegateView["read"]>[0];
	const view = new DirectDelegateView();
	const rows = view.read(
		results,
		[{ id: "@new", name: "new", session: "moved", exited: false }],
		undefined,
		{ offset: 0, limit: 0 },
		new Map([["old", { windowId: "@new", windowName: "new" }]]),
	);
	assert.equal(rows[0].state, "missing");
	assert.equal(rows[0].running, false);
	assert.equal(record.windowId, "@old");
	assert.equal(record.gone, true);
});

test("ancestors excluded from cap, activity stays on one line, no empty headings or self rows", () => {
	const ancestors = [
		{ key: "ar", sessionId: "r", identity: "root", parent: false },
		{ key: "ap", sessionId: "p", identity: "coord", parent: true },
	];
	const row = {
		key: "c",
		sessionId: "c",
		launchId: "c",
		identity: "worker",
		title: undefined,
		state: "running",
		running: true,
		window: "open" as const,
		model: "m",
		lastActive: undefined,
		activity: { kind: "tools" as const, text: "reading very long command description…" },
	};
	const theme = { fg: (_c: string, text: string) => text, bold: (text: string) => text };
	const wide = renderDelegateWidget([row], 1, 140, theme, 0, { ancestors });
	assert.equal(wide.length, 6);
	assert.match(wide[4], /reading/);
	const narrow = renderDelegateWidget([row], 1, 45, theme, 0, { ancestors });
	assert.match(narrow[4], /reading/);
	assert.equal(renderDelegateWidget([], 0, 100, theme, 0, { ancestors }).length, 3);
	for (let width = 1; width < 100; width++)
		assert.ok(
			renderDelegateWidget([row], 1, width, theme, 0, { ancestors }).every((line) => visibleWidth(line) <= width),
		);
	const selection = new WidgetSelection();
	selection.update(["c", "d", "e"], 1, ["ar", "ap"]);
	selection.enter();
	assert.equal(selection.selectedKey, "ap");
	selection.move(1);
	selection.move(1);
	assert.equal(selection.offset, 1);
	selection.update(["c"], 0, ["ar", "ap"]);
	assert.equal(selection.active, true);
	assert.equal(selection.selectedKey, "ap");
});

test("actual widget Enter switches live root, unavailable parent refuses without dashboard/resume or window effects", async () => {
	const server = (ownPane: string): FakeTmux => {
		const fake = new FakeTmux();
		fake.ownPane = ownPane;
		fake.addWindow("@1", "root", "root-session");
		fake.addWindow("@2", "leaf", "leaf-session");
		fake.panes.set("%1", { windowId: "@1" });
		fake.panes.set("%2", { windowId: "@2" });
		fake.parentSession = ownPane === "%1" ? "root-session" : "leaf-session";
		fake.attachClient("attached-client", 1);
		return fake;
	};
	const root = instance({ parent: "live-root", tmux: server("%1") });
	await root.start();
	writeIdentity("live-leaf", own("live-root", "live-root", 1));
	const leaf = instance({ parent: "live-leaf", tmux: server("%2") });
	await leaf.start();
	const reader = new LiveActivityReader();
	for (let n = 0; n < 200 && !(await reader.locator("live-root")); n++) await new Promise((r) => setTimeout(r, 10));
	assert.ok(await reader.locator("live-root"));
	await until(() => frame(leaf).includes("root (parent)"));
	assert.equal(leaf.terminalKey("down"), true);
	assert.match(frame(leaf), /▸ ↑ root \(parent\)/);
	assert.doesNotMatch(frame(leaf), /x close/);
	assert.equal(leaf.terminalKey("x"), true);
	await until(() => leaf.warnings.some((warning) => warning.includes("cannot close an ancestor")));
	assert.equal(leaf.confirms.length, 0);
	assert.equal(leaf.tmux.killed.length, 0);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(leaf.terminalKey("enter"), true);
	assert.equal(leaf.terminalKey("enter"), true, "busy gap is consumed, not a second action");
	await until(() => leaf.tmux.switches.length === 1);
	assert.deepEqual(leaf.tmux.switches, [{ client: "attached-client", windowId: "@1" }]);
	assert.equal(leaf.customs.length, 0, "ancestors bypass dashboard");
	await root.shutdown();
	await until(() => !frame(leaf).includes("enter details"));
	// Wait until the previous switch's finally releases the busy flag.
	await new Promise((r) => setTimeout(r, 20));
	leaf.terminalKey("enter");
	await until(() => leaf.errors.some((error) => error.includes("verified live window")));
	assert.equal(leaf.tmux.switches.length, 1);
	assert.equal(leaf.tmux.opened.length, 0);
	assert.equal(leaf.tmux.killed.length, 0);
});

test("tree expands at every depth, switches and closes nested rows, and collapses on every focus exit", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	writeFileSync(
		join(agentDir, "squire", "settings.json"),
		JSON.stringify({ maxDepth: 5, delegateWidgetMaxEntries: 8 }),
	);
	const root = instance({ ui: { confirm: [false, true] } });
	root.tmux.attachClient("client", 1);
	const c = await launch(root, "coord", "branch");
	const coordinator = instance({ parent: c.id, tmux: root.tmux });
	await coordinator.start();
	const g = await launch(coordinator, "coord", "nested");
	const grand = instance({ parent: g.id, tmux: root.tmux });
	await grand.start();
	const deep = await launch(grand, "leaf", "deep");
	const sibling = await launch(coordinator, "leaf", "sibling");
	t.mock.timers.tick(WIDGET_REFRESH_MS);
	await until(() => /coord-branch.*\+3/.test(frame(root)));
	assert.doesNotMatch(frame(root), /coord-nested|leaf-deep|leaf-sibling|tasks:/);
	root.terminalKey("down");
	assert.match(frame(root), /→ expand/);
	root.terminalKey("right");
	assert.match(frame(root), /▸ .*coord-branch/);
	assert.match(frame(root), /leaf-sibling/);
	assert.match(frame(root), /coord-nested.*\+1/);
	assert.doesNotMatch(frame(root), /leaf-deep/);
	assert.match(frame(root), /← collapse/);
	root.terminalKey("right");
	assert.match(frame(root), /▸ .*leaf-sibling/);
	assert.doesNotMatch(frame(root), /→ expand|← collapse/);
	root.terminalKey("left");
	assert.match(frame(root), /▸ .*leaf-sibling/);
	root.terminalKey("down");
	root.terminalKey("left");
	assert.match(frame(root), /▸ .*coord-branch/, "Left on collapsed child jumps to its parent");
	root.terminalKey("down");
	root.terminalKey("down");
	root.terminalKey("right");
	assert.match(frame(root), /leaf-deep/);
	root.terminalKey("right");
	assert.match(frame(root), /▸ .*leaf-deep/);
	root.terminalKey("enter");
	await until(() => root.tmux.switches.length === 1);
	assert.equal(root.tmux.switches[0].windowId, deep.windowId);
	await new Promise<void>((resolve) => setImmediate(resolve));
	root.terminalKey("x");
	await until(() => root.confirms.length === 1);
	assert.equal(root.tmux.killed.length, 0);
	await new Promise<void>((resolve) => setImmediate(resolve));
	root.terminalKey("x");
	await until(() => root.tmux.killed.includes(deep.windowId));
	t.mock.timers.tick(WIDGET_REFRESH_MS);
	await until(() => !frame(root).includes("leaf-deep"));
	assert.equal(root.tmux.windows.has(sibling.windowId), true);
	assert.equal(root.tmux.windows.has(c.windowId), true);
	root.terminalKey("escape");
	assert.doesNotMatch(frame(root), /coord-nested|leaf-sibling|▸/);
	assert.match(frame(root), /coord-branch.*\+2/);
	for (const exit of ["typing", "up"]) {
		root.terminalKey("down");
		root.terminalKey("right");
		assert.match(frame(root), /coord-nested/);
		assert.equal(root.terminalKey(exit), exit === "up");
		assert.doesNotMatch(frame(root), /coord-nested|leaf-sibling|▸/);
		assert.match(frame(root), /↓ to manage delegates/);
	}
});

test("invalid ancestry refuses cycles and copied/new sessions gain no parent chain", async () => {
	const s = instance({ parent: "child" });
	await s.start();
	writeIdentity("child", own("parent", "r", 2));
	writeIdentity("parent", own("child", "r", 1));
	assert.throws(() => ancestorSessions(s.context as unknown as ExtensionContext), /invalid|incomplete/);
	const fresh = session({ parent: "new-session" });
	assert.deepEqual(ancestorSessions(fresh.context as unknown as ExtensionContext), []);
});
