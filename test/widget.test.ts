import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import type { Delegation } from "../src/results.ts";
import { DELEGATE_WIDGET_KEY, WIDGET_REFRESH_MS } from "../src/widget.ts";
import { LiveActivityPublisher, LiveActivityReader } from "../src/widget-live.ts";
import { titleMirrorPath } from "../src/widget-title.ts";
import { agentDir, agentFile, cleanup, resetRoot, root, session, sessionDir, writeAgent } from "./harness.ts";
import { windowFields } from "./window-record.ts";

type Session = ReturnType<typeof session>;
const sessions: Session[] = [];
const settingsFile = join(agentDir, "squire", "settings.json");
beforeEach(() => {
	resetRoot();
	writeAgent("worker", agentFile({ model: "alpha/fast-model", auto_exit: "false" }));
});
afterEach(async () => {
	for (const s of sessions.splice(0)) await s.shutdown();
});
after(cleanup);

function create(options: Parameters<typeof session>[0] = {}): Session {
	const s = session({ mode: "tui", ...options });
	sessions.push(s);
	return s;
}
async function settle(): Promise<void> {
	for (let n = 0; n < 4; n++) await new Promise<void>((resolve) => setImmediate(resolve));
}
async function until(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(check(), "widget refresh completed");
}
async function tick(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, WIDGET_REFRESH_MS + 80));
	await settle();
}
function frame(s: Session, width = 120): string {
	return s.widgets.get(DELEGATE_WIDGET_KEY)?.render(width).join("\n") ?? "";
}
function starts(s: Session): Delegation[] {
	return s.entries.filter((entry) => typeof entry.data.requestId === "string").map((entry) => entry.data as Delegation);
}
function reply(s: Session, record: Delegation, status = "done"): void {
	s.events.emit("message:inbound", {
		envelope: {
			id: `reply-${record.id}`,
			from: record.sessionId ?? record.id,
			to: s.parent,
			in_reply_to: [record.requestId],
			status,
			ts: "",
			body: "answer",
		},
		path: "/mail/reply.json",
		requests: [],
		handled: false,
	});
}
function file(record: Delegation, name?: string): string {
	mkdirSync(sessionDir, { recursive: true });
	const path = join(sessionDir, `today_${record.sessionId ?? record.id}.jsonl`);
	const entries: object[] = [{ type: "session", version: 3, id: record.sessionId ?? record.id, cwd: root }];
	if (name !== undefined) entries.push({ type: "session_info", name });
	writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return path;
}
function configure(value: object): void {
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(settingsFile, JSON.stringify(value));
}

test("ten idle delegates use one pane listing and zero ps or per-pane calls per widget tick", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	configure({ delegateWidgetMaxEntries: 10 });
	const s = create();
	for (let n = 0; n < 10; n++) await s.delegate(`worker --label idle-${n} inspect`);
	const publishers = starts(s).map((record) => new LiveActivityPublisher(record.id, record.id));
	for (const publisher of publishers) publisher.publish(undefined);
	await Promise.all(publishers.map((publisher) => publisher.flush()));
	await until(() => frame(s).includes("idle-0") && frame(s).includes("idle-9"));
	await settle();
	let completedReads = 0;
	const read = LiveActivityReader.prototype.read;
	t.mock.method(
		LiveActivityReader.prototype,
		"read",
		async function (this: LiveActivityReader, id: string, launch: string): ReturnType<LiveActivityReader["read"]> {
			const value = await read.call(this, id, launch);
			completedReads++;
			return value;
		},
	);
	const listCalls = s.tmux.listCalls;
	const inspect = t.mock.method(s.tmux, "inspectPane");
	const locate = t.mock.method(LiveActivityReader.prototype, "locator");
	const exec = t.mock.method(childProcess, "execFile");
	const execSync = t.mock.method(childProcess, "execFileSync");
	syncBuiltinESMExports();
	try {
		for (let n = 0; n < 3; n++) {
			const calls = s.tmux.paneListCalls;
			t.mock.timers.tick(WIDGET_REFRESH_MS);
			await until(() => completedReads >= (n + 1) * 10);
			await settle();
			assert.equal(s.tmux.paneListCalls, calls + 1);
			assert.match(frame(s), /idle-0/);
			assert.match(frame(s), /idle-9/);
		}
		assert.equal(s.tmux.listCalls, listCalls);
		assert.equal(inspect.mock.callCount(), 0);
		assert.equal(locate.mock.callCount(), 0, "recorded open windows never read locators");
		assert.equal(exec.mock.callCount(), 0);
		assert.equal(execSync.mock.callCount(), 0);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		for (const publisher of publishers) publisher.stop();
		await Promise.all(publishers.map((publisher) => publisher.closed()));
	}
});

test("real direct launches/results: running first, newest within groups, actual outcomes and overflow", async () => {
	const s = create();
	await s.start();
	assert.equal(frame(s), "", "no empty heading");
	for (const label of ["first", "second", "third", "fourth"]) await s.delegate(`worker --label ${label} do it`);
	await settle();
	let text = frame(s);
	assert.match(text, / {2}Delegates\n {2}├─ ◌ fourth/);
	assert.match(text, /\+1 more delegate/);
	assert.ok(!s.statuses.some(({ key, text }) => key === "delegate" && text), "list replaces Squire count only");
	const records = starts(s);
	reply(s, records[3], "failed");
	await settle();
	text = frame(s);
	assert.ok(text.indexOf("third") < text.indexOf("second"));
	assert.ok(!text.includes("fourth"), "finished entries follow running entries, even when newer");
	reply(s, records[2], "stopped");
	await settle();
	assert.match(frame(s), /✗ fourth.*failed/);
	configure({ delegateWidgetMaxEntries: 5 });
	await tick();
	assert.match(frame(s), /! third.*stopped/);
	assert.ok(!frame(s).includes("✓ fourth"));
});

test("finished-open rows keep refreshing file-backed renames, clears and window exits after results stop running", async () => {
	const s = create();
	await s.delegate("worker --label title inspect");
	const record = starts(s)[0];
	const path = file(record, "Initial native title");
	reply(s, record);
	await settle();
	assert.match(frame(s), /Initial native title.*done/);
	appendFileSync(path, `${JSON.stringify({ type: "session_info", name: "External picker rename" })}\n`);
	await tick();
	assert.match(frame(s), /External picker rename/);
	appendFileSync(path, `${JSON.stringify({ type: "session_info", name: "" })}\n`);
	await tick();
	assert.ok(!frame(s).includes("External picker rename"));
	s.tmux.exit(windowFields(record).windowId);
	await tick();
	assert.equal(frame(s), "", "dead pane is not a completed-open row");
});

test("native rename events cover unflushed sessions without a naming tool; title never replaces routing identity", async () => {
	const parent = create();
	await parent.delegate("worker --label unflushed inspect");
	const record = starts(parent)[0];
	const child = create({ parent: record.id, tmux: parent.tmux, mode: "json" });
	child.pi.setSessionName("Native before first transcript");
	await child.start();
	await tick();
	assert.match(frame(parent), /unflushed {2}Native before first transcript/);
	await child.fire("session_info_changed", { name: "Renamed locally" });
	await tick();
	assert.match(frame(parent), /unflushed {2}Renamed locally/);
	await child.fire("session_info_changed", { name: record.name });
	await tick();
	assert.equal(frame(parent).split("unflushed").length - 1, 1, "do not repeat native title identical to identity");
	await child.fire("session_info_changed", { name: undefined });
	await tick();
	assert.ok(!frame(parent).includes("Renamed locally"));
	const mirror = JSON.parse(readFileSync(titleMirrorPath(record.id), "utf8"));
	assert.equal(mirror.sessionId, record.id);
	assert.equal(mirror.name, "");
});

test("resume keeps one stable session row, replaces the launch id, and reload restores direct facts", async () => {
	const first = create();
	await first.delegate("worker --label original inspect");
	const record = starts(first)[0];
	file(record, "Persistent native title");
	first.tmux.exit(windowFields(record).windowId);
	await first.toolCall("delegation_resume", { id: record.id, task: "continue" });
	await settle();
	const resumed = starts(first).at(-1)!;
	assert.notEqual(resumed.id, record.id);
	assert.equal(resumed.sessionId, record.id);
	assert.equal(frame(first).split("Persistent native title").length - 1, 1);
	await first.shutdown();
	const reloaded = create({ parent: first.parent, entries: structuredClone(first.entries), tmux: first.tmux });
	await reloaded.start();
	await settle();
	assert.match(frame(reloaded), /Persistent native title.*running/);
	reply(reloaded, resumed, "failed");
	await settle();
	assert.match(frame(reloaded), /Persistent native title.*failed/);
	assert.equal(frame(first), "");
});

test("cap zero preserves count and own badge; placement and settings refresh use the same file", async () => {
	configure({ delegateWidgetPlacement: "below", delegateWidgetMaxEntries: 0 });
	const s = create({ parentEnv: "root-session", agentEnv: "coordinator", autoExitEnv: "0" });
	// A coordinator grant is needed for real direct launches.
	writeAgent("coordinator", agentFile({ allow_nested_delegation: "true" }));
	configure({ maxDepth: 2, delegateWidgetPlacement: "below", delegateWidgetMaxEntries: 0 });
	await s.delegate("worker inspect");
	await settle();
	assert.match(frame(s), /^ {2}root › coordinator \(you\)\n↓ to manage delegates$/);
	assert.ok(s.statuses.some(({ key, text }) => key === "delegate" && text?.includes("1 delegate running")));
	assert.ok(s.statuses.some(({ key }) => key === "delegate-self"));
	configure({ maxDepth: 2, delegateWidgetPlacement: "below", delegateWidgetMaxEntries: 1 });
	await tick();
	assert.match(frame(s), /running/);
	assert.deepEqual(s.widgetCalls.at(-1)?.placement, { placement: "belowEditor" });
	assert.deepEqual(s.statuses.at(-1), { key: "delegate", text: undefined });
});

test("unknown tmux listing is not absence or success; id/name mismatch fails closed", async () => {
	const s = create();
	await s.delegate("worker inspect");
	const record = starts(s)[0];
	s.tmux.failList = "unavailable";
	await tick();
	assert.match(frame(s), /running/);
	assert.equal(
		s.entries.some((entry) => entry.data.gone),
		false,
	);
	reply(s, record, "failed");
	await settle();
	assert.equal(frame(s), "", "finished row requires positive open-window proof");
	s.tmux.failList = undefined;
	await tick();
	assert.match(frame(s), /failed/);
	s.tmux.windows.get(windowFields(record).windowId)!.name = "foreign-window";
	await tick();
	assert.equal(frame(s), "");
});

test("regular/fullscreen migration uses current UI updates; shutdown cancels timers and late reads", async () => {
	const s = create();
	await s.delegate("worker --label migrate inspect");
	const record = starts(s)[0];
	await settle();
	s.switchRenderer("fullscreen");
	reply(s, record, "failed");
	await settle();
	assert.equal(s.widgetCalls.at(-1)?.renderer, "fullscreen");
	assert.match(frame(s), /failed/);
	s.switchRenderer("regular");
	const path = file(record, "Changed after migration");
	await tick();
	assert.match(frame(s), /Changed after migration/);
	assert.equal(s.widgetCalls.at(-1)?.renderer, "regular");
	const switches = [...s.tmux.switches];
	const captures = [...s.tmux.captures];
	await s.shutdown();
	const calls = s.widgetCalls.length;
	appendFileSync(path, `${JSON.stringify({ type: "session_info", name: "Too late" })}\n`);
	await tick();
	assert.equal(s.widgetCalls.length, calls);
	assert.equal(frame(s), "");
	assert.deepEqual(s.tmux.switches, switches);
	assert.deepEqual(s.tmux.captures, captures);
	assert.ok(!s.shortcuts().includes("down"));
});

test("running window exit stays observation-only until the existing mail-first poll records gone; close removes a row promptly", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const s = create();
	await s.delegate("worker --label vanished inspect");
	await settle();
	const record = starts(s)[0];
	s.tmux.exit(windowFields(record).windowId);
	t.mock.timers.tick(WIDGET_REFRESH_MS);
	await settle();
	assert.equal(frame(s), "");
	assert.equal(
		s.entries.some((entry) => entry.data.gone),
		false,
		"view cannot record a semantic terminal fact",
	);
	t.mock.timers.tick(5000);
	await settle();
	assert.equal(
		s.entries.some((entry) => entry.data.gone),
		true,
		"the unchanged authoritative poll handles missing results",
	);
	await s.delegate("worker --label close inspect");
	await settle();
	const next = starts(s).at(-1)!;
	assert.match(frame(s), /close/);
	await s.toolCall("delegation_close", { id: next.id });
	await settle();
	assert.equal(frame(s), "");
	await s.shutdown();
});

test("cosmetic settings errors warn once and fall back without refusing real launches", async () => {
	configure({ delegateWidgetPlacement: "sideways", delegateWidgetMaxEntries: -1 });
	const s = create();
	await s.delegate("worker inspect");
	await settle();
	assert.match(frame(s), /Delegates/);
	assert.deepEqual(s.widgetCalls.at(-1)?.placement, { placement: "aboveEditor" });
	assert.equal(s.warnings.filter((warning) => warning.includes("widget defaults")).length, 1);
	await tick();
	assert.equal(s.warnings.filter((warning) => warning.includes("widget defaults")).length, 1);
});

test("shutdown while a window read is pending cannot resurrect a widget", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const s = create();
	await s.delegate("worker inspect");
	await settle();
	const listing = await s.tmux.listPanes();
	let release: (value: typeof listing) => void = () => {};
	s.tmux.listPanes = () =>
		new Promise((resolve) => {
			release = resolve;
		});
	t.mock.timers.tick(WIDGET_REFRESH_MS);
	await settle();
	await s.shutdown();
	const calls = s.widgetCalls.length;
	release(listing);
	await settle();
	assert.equal(frame(s), "");
	assert.equal(s.widgetCalls.length, calls);
});

test("cap zero and terminal-only history stop overview tmux reads", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	configure({ delegateWidgetMaxEntries: 0 });
	const s = create();
	await s.delegate("worker inspect");
	await settle();
	let calls = s.tmux.paneListCalls;
	t.mock.timers.tick(WIDGET_REFRESH_MS);
	await settle();
	assert.equal(s.tmux.paneListCalls, calls, "cap zero does not list panes");
	const record = starts(s)[0];
	await s.toolCall("delegation_close", { id: record.id });
	await settle();
	configure({ delegateWidgetMaxEntries: 3 });
	t.mock.timers.tick(5000);
	await settle(); // The unchanged task poll can now stop too.
	calls = s.tmux.paneListCalls;
	t.mock.timers.tick(WIDGET_REFRESH_MS);
	await settle();
	assert.equal(s.tmux.paneListCalls, calls, "closed history does not keep the view listing forever");
	await s.delegate("worker --label gone inspect");
	await settle();
	const vanished = starts(s).at(-1)!;
	s.tmux.exit(windowFields(vanished).windowId);
	t.mock.timers.tick(5000);
	await settle();
	assert.ok(s.entries.some((entry) => entry.data.id === vanished.id && entry.data.gone));
	calls = s.tmux.paneListCalls;
	t.mock.timers.tick(WIDGET_REFRESH_MS);
	await settle();
	assert.equal(s.tmux.paneListCalls, calls, "gone history without a result needs no view listing");
	await s.shutdown();
});

test("non-TUI hosts keep legacy footer and do not register passive widgets", async () => {
	for (const mode of ["json", "rpc"] as const) {
		const s = create({ mode });
		await s.delegate("worker inspect");
		await settle();
		assert.equal(s.widgetCalls.length, 0);
		assert.ok(s.statuses.some(({ key, text }) => key === "delegate" && text?.includes("1 delegate")));
	}
});
