import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type Identity, writeIdentity } from "../src/identity.ts";
import type { Delegation } from "../src/results.ts";
import { withTreeLock } from "../src/tree-lock.ts";
import { readTree, readTreeDisplay, treePath } from "../src/tree-registry.ts";
import { visibleRecordFacts } from "../src/tree-view.ts";
import { DELEGATE_WIDGET_KEY, WIDGET_REFRESH_MS } from "../src/widget.ts";
import { ancestorSessions, BreadcrumbView } from "../src/widget-ancestors.ts";
import { DirectDelegateView } from "../src/widget-data.ts";
import { LiveActivityReader } from "../src/widget-live.ts";
import { renderDelegateWidget } from "../src/widget-render.ts";
import { WidgetSelection } from "../src/widget-selection.ts";
import { windowStates } from "../src/window-state.ts";
import { FakeTmux } from "./fake-tmux.ts";
import { agentDir, agentFile, cleanup, resetRoot, session, sessionDir, writeAgent } from "./harness.ts";
import { mailSession, scan } from "./mail-harness.ts";
import { windowFields } from "./window-record.ts";

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
	await until(() => frame(grand).includes("deep"));
	assert.match(frame(root), /^ {2}Delegates/);
	assert.doesNotMatch(frame(root), /second|deep|grand-leaf/);
	assert.match(frame(coord), /^ {2}root › first \(you\)/);
	assert.doesNotMatch(frame(coord), /sibling|deep/);
	await until(() => frame(grandLeaf).includes("(you)"));
	assert.doesNotMatch(frame(grandLeaf), /Delegates|\(parent\)/);
	assert.match(frame(grandLeaf), /^ {2}root › first › grand-leaf \(you\)/);
	const unfocused = frame(grand);
	assert.match(unfocused, /^ {2}root › first › second \(you\)\n {2}└─/);
	assert.equal(grand.terminalKey("down"), true);
	const rows = (text: string) =>
		text
			.split("\n")
			.slice(0, -1)
			.map((line) => line.slice(2));
	assert.deepEqual(rows(frame(grand)), rows(unfocused), "focusing keeps every row in its column");
	assert.match(frame(grand), /▸ root › first › second \(you\)/);
	grand.terminalKey("up");
	assert.doesNotMatch(frame(grand), /▸/);
	grand.terminalKey("down");
	grand.terminalKey("down");
	assert.match(frame(grand), /▸ .*deep/);
	grand.terminalKey("up");
	assert.match(frame(grand), /▸ root › first › second \(you\)/);
	assert.match(frame(grand), /enter parent/);
	writeFileSync(
		join(agentDir, "squire", "settings.json"),
		JSON.stringify({ maxDepth: 5, delegateWidgetMaxEntries: 0 }),
	);
	t.mock.timers.tick(WIDGET_REFRESH_MS);
	await until(() => !frame(grand).includes("deep"));
	assert.match(frame(grand), /root › first › second \(you\)/);
	assert.doesNotMatch(frame(grand), /Delegates/);
	assert.ok(grand.statuses.some(({ key, text }) => key === "delegate" && text?.includes("1 delegate running")));
	assert.equal(grand.terminalKey("down"), true);
	assert.equal(leaf.terminalKey("down"), true);
	assert.match(frame(leaf), /▸ root › sibling \(you\)/);
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
	await until(() => /direct.*\+2/.test(frame(root)), frame(root));
	assert.doesNotMatch(frame(root), /failed|grand/);
	await leaf.shutdown();
	root.tmux.exit(windowFields(w).windowId);
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
	await until(() => /direct.*\+2/.test(frame(root)), frame(root));
	await grand.toolCall("delegation_close", { id: retry.id });
	t.mock.timers.tick(WIDGET_REFRESH_MS);
	await until(() => /direct.*\+1/.test(frame(root)), frame(root));
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
	await until(() => /direct.*\+1/.test(frame(root)), frame(root));
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
	root.tmux.exit(windowFields(w).windowId);
	t.mock.timers.tick(5000);
	await until(() => direct.entries.some((entry) => entry.data.id === w.id && entry.data.gone === true));
	t.mock.timers.tick(WIDGET_REFRESH_MS);
	await until(() => /direct/.test(frame(current)) && !/\+1/.test(frame(current)));
	const owner = join(agentDir, "squire", "owners", `${encodeURIComponent(w.id)}.json`);
	writeFileSync(owner, "corrupt owner facts");
	await root.fire("session_info_changed", { name: "Fresh ancestor title" });
	direct.events.emit("message:reply", { to: c.id, inReplyTo: [d.requestId], body: "failed result", status: "failed" });
	scan(current);
	t.mock.timers.tick(WIDGET_REFRESH_MS);
	await until(() => /direct.*failed/.test(frame(current)));
	assert.match(frame(current), /root › current \(you\).*Fresh ancestor title/);
	assert.match(frame(current), /direct.*failed/);
	assert.doesNotMatch(frame(current), /1 task: 1 missing|direct.*running/);
});

test("display tree projections and breadcrumb remain readable while a writer holds admission", async () => {
	const root = instance();
	const c = await launch(root, "coord", "parent");
	const coord = instance({ parent: c.id, tmux: root.tmux });
	await coord.start();
	const w = await launch(coord, "leaf", "nested");
	const results = {
		list: () => root.entries.filter((e) => e.data.requestId).map((e) => e.data),
	} as unknown as Parameters<typeof visibleRecordFacts>[0];
	const ctx = root.context as unknown as ExtensionContext;
	let breadcrumb: ReturnType<BreadcrumbView["read"]> | undefined;
	withTreeLock(`${treePath(root.parent)}.lock`, () => {
		assert.throws(() => readTree(root.parent, 0), /busy/);
		assert.equal(readTreeDisplay(root.parent).entries.length, 2);
		assert.ok(visibleRecordFacts(results, ctx, 0, false, readTreeDisplay).records.some((record) => record.id === w.id));
		breadcrumb = new BreadcrumbView().read(coord.context as unknown as ExtensionContext, new LiveActivityReader());
	});
	assert.equal((await breadcrumb)?.parentSessionId, root.parent);
});

test("breadcrumb waits for slow title refresh but Results notifications refresh it immediately", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval", "Date"] });
	const root = instance();
	const c = await launch(root, "coord", "child");
	const child = instance({ parent: c.id, tmux: root.tmux });
	await child.start();
	await until(() => frame(child).includes("(you)"));
	const read = t.mock.method(BreadcrumbView.prototype, "read");
	await root.fire("session_info_changed", { name: "Slow title" });
	for (let n = 0; n < 2; n++) {
		t.mock.timers.tick(WIDGET_REFRESH_MS);
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
	assert.equal(read.mock.callCount(), 0);
	assert.doesNotMatch(frame(child), /Slow title/);
	t.mock.timers.tick(30_000);
	await until(() => frame(child).includes("Slow title"));
	assert.ok(read.mock.callCount() > 0);
	const d = await launch(child, "leaf", "notifies");
	await root.fire("session_info_changed", { name: "Immediate title" });
	child.events.emit("message:inbound", {
		envelope: { id: "reply", from: d.id, to: c.id, in_reply_to: [d.requestId], status: "done", ts: "", body: "done" },
		path: "/mail/reply",
		requests: [],
		handled: false,
	});
	await until(() => frame(child).includes("Immediate title"));
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
		windowId: "@701",
		windowName: "old",
		requestId: "req",
		gone: true,
	};
	const results = { list: () => [record], running: () => [] } as unknown as Parameters<DirectDelegateView["read"]>[0];
	const view = new DirectDelegateView();
	const rows = view.read(
		results,
		windowStates([{ id: "@702", name: "new", session: "moved", exited: false }]),
		undefined,
		{ offset: 0, limit: 0 },
		new Map([["old", { windowId: "@702", windowName: "new" }]]),
	);
	assert.equal(rows[0].state, "missing");
	assert.equal(rows[0].running, false);
	assert.equal(windowFields(record).windowId, "@701");
	assert.equal(record.gone, true);
});

test("breadcrumb excluded from cap, running indicator stays on one line, no empty headings", () => {
	const breadcrumb = {
		key: "ap",
		parentSessionId: "p",
		crumbs: [{ identity: "root" }, { identity: "coord" }],
		self: { identity: "worker-self", agent: "worker" },
	};
	const row = {
		key: "c",
		sessionId: "c",
		launchId: "c",
		identity: "worker",
		title: undefined,
		state: "running",
		running: true,
		window: "running" as const,
		model: "m",
		lastActive: undefined,
		activity: { kind: "tools" as const, text: "reading very long command description…" },
	};
	const theme = { fg: (_c: string, text: string) => text, bold: (text: string) => text };
	const wide = renderDelegateWidget([row], 1, 140, theme, 0, { breadcrumb });
	assert.equal(wide.length, 4);
	assert.match(wide[2], /working\.\.\./);
	const narrow = renderDelegateWidget([row], 1, 45, theme, 0, { breadcrumb });
	assert.match(narrow[2], /working\.\.\./);
	assert.equal(renderDelegateWidget([], 0, 100, theme, 0, { breadcrumb }).length, 2);
	for (let width = 1; width < 100; width++)
		assert.ok(
			renderDelegateWidget([row], 1, width, theme, 0, { breadcrumb }).every((line) => visibleWidth(line) <= width),
		);
	const selection = new WidgetSelection();
	selection.update(["c", "d", "e"], 1, "ap");
	selection.enter();
	assert.equal(selection.selectedKey, "ap");
	selection.move(1);
	selection.move(1);
	assert.equal(selection.offset, 1);
	selection.update(["c"], 0, "ap");
	assert.equal(selection.active, true);
	assert.equal(selection.selectedKey, "ap");
});

test("breadcrumb collapses middle crumbs, drops title before names, and keeps the warning", () => {
	const breadcrumb = {
		key: "parent",
		parentSessionId: "p",
		crumbs: [
			{ identity: "root" },
			{ identity: "coord-middle-one", agent: "coord" },
			{ identity: "coord-middle-two", agent: "coord" },
			{ identity: "coord-parent", agent: "coord" },
		],
		self: { identity: "leaf-self", agent: "leaf" },
		parentTitle: "Parent title that truncates first",
	};
	const theme = { fg: (_c: string, text: string) => text, bold: (text: string) => text };
	const render = (width: number) => renderDelegateWidget([], 0, width, theme, 0, { breadcrumb });
	assert.equal(
		render(120)[0],
		"  root › middle-one › middle-two › parent › self (you)  Parent title that truncates first",
	);
	assert.equal(render(55)[0], "  root › middle-one › middle-two › parent › self (you)");
	assert.equal(render(35)[0], "  root › … › parent › self (you)");
	assert.match(render(45)[0], /^ {2}root › … › parent › self \(you\) {2}Parent/);
	assert.match(
		renderDelegateWidget([], 0, 100, theme, 0, { breadcrumb, ancestryError: "Ancestor information unavailable" }).join(
			"\n",
		),
		/\n {2}Ancestor information unavailable\n/,
	);
});

test("actual widget Enter switches only the direct parent at either depth and refuses an unavailable parent", async () => {
	for (const nested of [false, true]) {
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
		if (nested) writeIdentity("live-root", own("grand-root", "grand-root", 1));
		const root = instance({ parent: "live-root", tmux: server("%1") });
		await root.start();
		writeIdentity("live-leaf", own("live-root", nested ? "grand-root" : "live-root", nested ? 2 : 1));
		const leaf = instance({ parent: "live-leaf", tmux: server("%2") });
		await leaf.start();
		const reader = new LiveActivityReader();
		for (let n = 0; n < 200 && !(await reader.locator("live-root")); n++) await new Promise((r) => setTimeout(r, 10));
		assert.ok(await reader.locator("live-root"));
		const trail = nested ? "root › coord › coord (you)" : "root › coord (you)";
		await until(() => frame(leaf).includes(trail));
		assert.equal(leaf.terminalKey("down"), true);
		assert.ok(frame(leaf).startsWith(`▸ ${trail}`));
		const focused = frame(leaf);
		leaf.terminalKey("left");
		leaf.terminalKey("right");
		assert.equal(frame(leaf), focused, "breadcrumb ignores horizontal keys");
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
		await leaf.shutdown();
	}
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
	await until(() => /branch.*\+3/.test(frame(root)));
	assert.doesNotMatch(frame(root), /nested|deep|sibling|tasks:/);
	root.terminalKey("down");
	assert.match(frame(root), /→ expand/);
	root.terminalKey("right");
	assert.match(frame(root), /▸ .*branch/);
	assert.match(frame(root), /sibling/);
	assert.match(frame(root), /nested.*\+1/);
	assert.doesNotMatch(frame(root), /deep/);
	assert.match(frame(root), /← collapse/);
	root.terminalKey("right");
	assert.match(frame(root), /▸ .*sibling/);
	assert.doesNotMatch(frame(root), /→ expand|← collapse/);
	assert.match(frame(root), /← parent/);
	root.terminalKey("right");
	assert.match(frame(root), /▸ .*sibling/, "Right on a childless row does nothing");
	root.terminalKey("left");
	assert.match(frame(root), /▸ .*branch/, "Left on a childless child jumps to its parent");
	root.terminalKey("down");
	root.terminalKey("down");
	root.terminalKey("left");
	assert.match(frame(root), /▸ .*branch/, "Left on collapsed child jumps to its parent");
	root.terminalKey("down");
	root.terminalKey("down");
	root.terminalKey("right");
	assert.match(frame(root), /deep/);
	root.terminalKey("right");
	assert.match(frame(root), /▸ .*deep/);
	root.terminalKey("enter");
	await until(() => root.tmux.switches.length === 1);
	assert.equal(root.tmux.switches[0].windowId, windowFields(deep).windowId);
	await new Promise<void>((resolve) => setImmediate(resolve));
	root.terminalKey("x");
	await until(() => root.confirms.length === 1);
	assert.equal(root.tmux.killed.length, 0);
	await new Promise<void>((resolve) => setImmediate(resolve));
	root.terminalKey("x");
	await until(() => root.tmux.killed.includes(windowFields(deep).windowId));
	t.mock.timers.tick(WIDGET_REFRESH_MS);
	await until(() => !frame(root).includes("deep"));
	assert.equal(root.tmux.windows.has(windowFields(sibling).windowId), true);
	assert.equal(root.tmux.windows.has(windowFields(c).windowId), true);
	root.terminalKey("escape");
	assert.doesNotMatch(frame(root), /nested|sibling|▸/);
	assert.match(frame(root), /branch.*\+2/);
	for (const exit of ["typing", "up"]) {
		root.terminalKey("down");
		root.terminalKey("right");
		assert.match(frame(root), /nested/);
		assert.equal(root.terminalKey(exit), exit === "up");
		assert.doesNotMatch(frame(root), /nested|sibling|▸/);
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
