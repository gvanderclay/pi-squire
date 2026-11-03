import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Results } from "../src/results.ts";
import { ActivityCollector, activityText, byteTail } from "../src/widget-activity.ts";
import { joinActivities } from "../src/widget-activity-join.ts";
import type { DelegateRow } from "../src/widget-data.ts";
import { liveLaunch } from "../src/widget-live.ts";
import { activityLine, renderDelegateWidget } from "../src/widget-render.ts";

test("actual ids retain concurrent same-name and nested leaf calls without counting parents", () => {
	const c = new ActivityCollector();
	c.start("a", "codemode");
	c.start("a/1", "read", "a", { path: "src/index.ts" });
	assert.deepEqual(c.snapshot(), { text: "reading…", target: "src/index.ts" });
	c.start("a/2", "read", "a");
	assert.equal(c.snapshot()?.text, "reading…");
	c.end("a/2");
	c.end("unknown");
	assert.equal(c.snapshot()?.text, "reading…");
	c.start("a/1/1", "bash", "a/1");
	assert.equal(c.snapshot()?.text, "running…");
	c.end("a/1/1");
	assert.equal(c.snapshot()?.text, "reading…");
	c.end("a/1");
	assert.equal(c.snapshot()?.text, "using codemode…");
	c.end("a");
	assert.equal(c.snapshot(), undefined);
	c.start("x", "edit");
	c.start("y", "write");
	assert.equal(c.snapshot()?.text, "writing…", "the most recent leaf wins");
	c.start("y", "bash");
	assert.equal(c.snapshot()?.text, "writing…", "duplicate id is not another call");
	c.end("y");
	assert.equal(c.snapshot()?.text, "editing…");
});

test("composing uses thinking, tools take precedence, and run boundaries reset", () => {
	const c = new ActivityCollector();
	assert.equal(c.snapshot(), undefined);
	c.messageStart();
	assert.deepEqual(c.snapshot(), { text: "thinking…" });
	c.start("read", "read");
	assert.equal(c.snapshot()?.text, "reading…");
	c.end("read");
	assert.deepEqual(c.snapshot(), { text: "thinking…" });
	c.clear();
	c.start("denied", "bash");
	c.end("denied");
	assert.equal(c.snapshot(), undefined, "denied/failed calls end by the same id");
	c.start("aborted", "read");
	c.clear();
	c.end("aborted");
	assert.equal(c.snapshot(), undefined);
	c.messageStart();
	assert.equal(c.snapshot()?.text, "thinking…");
});

test("collector storage and UTF-8/terminal projection are bounded and fail closed on untracked ids", () => {
	const c = new ActivityCollector();
	c.start("wide", "read", undefined, { path: "界🙂".repeat(100000) });
	assert.ok(Buffer.byteLength(c.snapshot()!.target!) <= 120);
	assert.ok(!c.snapshot()!.target!.includes("�"));
	assert.equal(byteTail("a界", 3), "界");
	assert.equal(activityText("\x1b[31mred\x1b[0m\n\x00safe"), "red safe");
	c.clear();
	c.start("safe", "read", undefined, { path: "\x1b[31mred\x1b[0m\n\x00safe" });
	assert.equal(c.snapshot()?.target, "red safe");
	for (let n = 0; n < 257; n++) c.start(String(n), "read");
	assert.equal(c.snapshot(), undefined);
	c.messageStart();
	assert.equal(c.snapshot(), undefined);
	c.clear();
	c.start("x".repeat(513), "read");
	assert.equal(c.snapshot(), undefined);
	c.clear();
	c.start("ok", "\x1b[31munknown\nname");
	assert.equal(c.snapshot()?.text, "using unknown name…");
	c.clear();
	c.start("custom", "constructor");
	assert.equal(c.snapshot()?.text, "using constructor…");
});

test("targets use only known string arguments and the first non-empty bounded command line", () => {
	const c = new ActivityCollector();
	for (const name of ["read", "edit", "write"]) {
		c.clear();
		c.start("path", name, undefined, { path: "src/index.ts" });
		assert.equal(c.snapshot()?.target, "src/index.ts");
	}
	c.clear();
	c.start("bash", "bash", undefined, { command: "\n \r\npnpm test\nsecret second line" });
	assert.deepEqual(c.snapshot(), { text: "running…", target: "pnpm test" });
	c.clear();
	c.start("long", "bash", undefined, { command: "界🙂".repeat(100) });
	assert.ok(Buffer.byteLength(c.snapshot()!.target!) <= 80);
	assert.ok(!c.snapshot()!.target!.includes("�"));
	for (const [name, args] of [
		["read", { path: 42 }],
		["read", null],
		["read", []],
		["read", "path"],
		["custom", { path: "hidden" }],
		["bash", { command: "\n  " }],
		["write", {}],
	] as const) {
		c.clear();
		c.start("invalid", name, undefined, args);
		assert.equal(c.snapshot()?.target, undefined);
	}
});

test("launch seed matches native session identity and keeps launch separate on resume", () => {
	assert.equal(liveLaunch(JSON.stringify({ version: 1, sessionId: "stable", launchId: "resume" }), "stable"), "resume");
	assert.equal(liveLaunch(JSON.stringify({ version: 1, sessionId: "stable", launchId: "resume" }), "new"), undefined);
	for (const seed of [undefined, "", "null", "[]", "bad", "x".repeat(5000)])
		assert.equal(liveLaunch(seed, "stable"), undefined);
});

const row = (id: string): DelegateRow => ({
	key: id,
	sessionId: id,
	launchId: `${id}-launch`,
	identity: id,
	title: undefined,
	state: "running",
	running: true,
	window: "open",
	model: "provider/model",
});
test("async join only reads viewport/running rows and masks results/close/resume arriving during read", async () => {
	const rows = [row("one"), row("two"), row("three")];
	const reads: string[] = [];
	let running = rows.map((r) => ({ id: r.launchId, sessionId: r.sessionId }));
	const results = { running: () => running, list: () => running } as unknown as Results;
	await joinActivities(rows, { offset: 1, limit: 1 }, results, {
		read: async (id) => {
			reads.push(id);
			running = [];
			return { text: "reading…" };
		},
	});
	assert.deepEqual(reads, ["two"]);
	assert.equal(rows[1].activity, undefined);
	running = rows.map((r) => ({ id: r.launchId, sessionId: r.sessionId }));
	await joinActivities(rows, { offset: 0, limit: 0 }, results, {
		read: async () => {
			throw Error("must not read");
		},
	});
	await joinActivities(rows, { offset: 0, limit: 3 }, results, {
		read: async () => {
			throw Error("metadata unavailable");
		},
	});
	assert.ok(rows.every((r) => r.activity === undefined));
	await joinActivities(rows, { offset: 0, limit: 1 }, results, {
		read: async () => ({ text: "reading…" }),
	});
	assert.equal(rows[0].activity?.text, "reading…");
	await joinActivities(rows, { offset: 0, limit: 1 }, results, {
		read: async () => {
			running.push({ id: "new-launch", sessionId: rows[0].sessionId });
			return { text: "must not reappear on old launch" };
		},
	});
	assert.equal(rows[0].activity, undefined, "same stable id resumed during the read");
});

test("secondary activity line is literal and bounded, absent at completion, without extra child slots", () => {
	const theme = { fg: (_color: string, text: string) => `\x1b[31m${text}\x1b[0m`, bold: (s: string) => s };
	const r = row("界🙂worker");
	r.activity = { text: "reading…", target: "a path\nwith \x1b[2Jcontrols" };
	for (let width = 0; width <= 150; width++) {
		const lines = renderDelegateWidget([r], 1, width, theme);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
	}
	const text = renderDelegateWidget([r], 1, 120, theme).join("\n");
	assert.match(text, /reading…/);
	assert.match(text, /a path with controls/);
	assert.doesNotMatch(text, /running/);
	assert.equal(activityLine({ ...r, activity: { text: "thinking…" } }, 80, true, theme), undefined);
	assert.equal(renderDelegateWidget([r], 1, 120, theme).length, 4);
	r.running = false;
	assert.equal(activityLine(r, 80, true, theme), undefined);
});
