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
	c.start("a/1", "read", "a");
	c.start("a/2", "read", "a");
	assert.equal(c.snapshot()?.text, "reading…");
	c.end("a/2");
	c.end("unknown");
	assert.equal(c.snapshot()?.text, "reading…");
	c.start("a/1/1", "bash", "a/1");
	assert.equal(c.snapshot()?.text, "command call…");
	c.end("a/1/1");
	assert.equal(c.snapshot()?.text, "reading…");
	c.end("a/1");
	assert.equal(c.snapshot()?.text, "using codemode…");
	c.end("a");
	assert.equal(c.snapshot(), undefined);
	c.start("x", "edit");
	c.start("y", "write");
	assert.equal(c.snapshot()?.text, "writing… · editing…");
	c.start("y", "bash");
	assert.equal(c.snapshot()?.text, "writing… · editing…", "duplicate id is not another call");
});

test("only open response text is retained, tools clear pre-tool excerpts, all boundaries reset", () => {
	const c = new ActivityCollector();
	c.delta("closed");
	assert.equal(c.snapshot(), undefined);
	c.messageStart();
	c.delta("Literal response");
	assert.deepEqual(c.snapshot(), { kind: "response", text: "Literal response" });
	c.start("read", "read");
	c.end("read");
	assert.equal(c.snapshot(), undefined);
	c.delta("more");
	c.messageEnd();
	assert.equal(c.snapshot(), undefined);
	c.start("denied", "bash");
	c.end("denied");
	assert.equal(c.snapshot(), undefined, "denied/failed calls end by the same id");
	c.start("aborted", "read");
	c.clear();
	c.end("aborted");
	assert.equal(c.snapshot(), undefined);
	c.messageStart();
	c.delta("retry");
	assert.equal(c.snapshot()?.text, "retry");
});

test("collector storage and UTF-8/terminal projection are bounded and fail closed on untracked ids", () => {
	const c = new ActivityCollector();
	c.messageStart();
	c.delta("界🙂".repeat(100000));
	assert.ok(Buffer.byteLength(c.snapshot()!.text) <= 512);
	assert.ok(!c.snapshot()!.text.includes("�"));
	assert.equal(byteTail("a界", 3), "界");
	assert.equal(activityText("\x1b[31mred\x1b[0m\n\x00safe"), "red safe");
	c.clear();
	c.messageStart();
	c.delta("\x1b[");
	c.delta("31mred\x1b[0m");
	assert.equal(c.snapshot()?.text, "red");
	for (let n = 0; n < 257; n++) c.start(String(n), "read");
	assert.equal(c.snapshot(), undefined);
	c.messageStart();
	c.delta("not misleading text");
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
	lastActive: undefined,
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
			return { kind: "tools", text: "reading…" };
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
		read: async () => ({ kind: "tools", text: "reading…" }),
	});
	assert.equal(rows[0].activity?.text, "reading…");
	await joinActivities(rows, { offset: 0, limit: 1 }, results, {
		read: async () => {
			running.push({ id: "new-launch", sessionId: rows[0].sessionId });
			return { kind: "tools", text: "must not reappear on old launch" };
		},
	});
	assert.equal(rows[0].activity, undefined, "same stable id resumed during the read");
});

test("secondary line is literal and bounded, absent at completion, summary wins without extra child slots", () => {
	const theme = { fg: (_color: string, text: string) => `\x1b[31m${text}\x1b[0m`, bold: (s: string) => s };
	const r = row("界🙂worker");
	r.activity = { kind: "response", text: "a response\nwith \x1b[2Jcontrols" };
	for (let width = 0; width <= 150; width++) {
		const lines = renderDelegateWidget([r], 1, width, theme, 0);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
	}
	const text = renderDelegateWidget([r], 1, 120, theme, 0).join("\n");
	assert.match(text, /response: a response with controls/);
	assert.equal(renderDelegateWidget([r], 1, 120, theme).length, 3);
	assert.ok(activityLine(r, 22, true, theme, "3 descendants")!.includes("3 descendants"));
	r.running = false;
	assert.equal(activityLine(r, 80, true, theme), undefined);
});
