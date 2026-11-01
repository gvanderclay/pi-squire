import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Results, StartedRecorded } from "../src/results.ts";
import { registerDelegateWidget } from "../src/widget.ts";
import { currentChildWindows } from "../src/widget-current.ts";
import { LiveActivityReader } from "../src/widget-live.ts";
import { FakeTmux } from "./fake-tmux.ts";
import { agentDir, cleanup, resetRoot, session } from "./harness.ts";

beforeEach(resetRoot);
after(cleanup);
const record: StartedRecorded = {
	id: "child",
	sessionId: "stable",
	agent: "worker",
	model: "m",
	thinking: "off",
	windowId: "@1",
	windowName: "child",
	requestId: "request",
};
function results(records: StartedRecorded[]): Results {
	return {
		list: () => records,
		running: () => records,
		subscribe: () => () => {},
		setCountVisible: () => {},
	} as unknown as Results;
}
test("current child lookup does zero locator/inspect work for unavailable/empty windows and no current candidates", async (t) => {
	const tmux = new FakeTmux();
	const inspect = t.mock.method(tmux, "inspectPane", async () => {
		throw new Error("unexpected inspect");
	});
	const reader = new LiveActivityReader();
	const locate = t.mock.method(reader, "locator", async () => {
		throw new Error("unexpected locator");
	});
	for (const windows of [undefined, []]) {
		const found = await currentChildWindows(results([record]), tmux, windows, reader);
		assert.equal(found.size, 0);
	}
	const windows = [{ id: "@1", name: "child", session: "work", exited: false }];
	for (const records of [[], [record, { ...record, id: "newest", closed: true }]]) {
		assert.equal((await currentChildWindows(results(records), tmux, windows, reader)).size, 0);
	}
	assert.equal(inspect.mock.callCount(), 0);
	assert.equal(locate.mock.callCount(), 0);
});

test("cap0 and no-candidate Overview refreshes never inspect/locate children independently of the publisher", async (t) => {
	const locate = t.mock.method(LiveActivityReader.prototype, "locator", async () => undefined);
	for (const { cap, records } of [
		{ cap: 0, records: [record] },
		{ cap: 3, records: [] },
	]) {
		mkdirSync(join(agentDir, "squire"), { recursive: true });
		writeFileSync(join(agentDir, "squire", "settings.json"), JSON.stringify({ delegateWidgetMaxEntries: cap }));
		const s = session({ mode: "tui" }); // Do not start the independent runtime publisher in this observer-only test.
		const handlers = new Map<string, (event: object, ctx: ExtensionContext) => unknown>();
		const pi = {
			on: (name: string, handler: (event: object, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
			getSessionName: () => undefined,
		} as unknown as ExtensionAPI;
		const tmux = new FakeTmux();
		const inspect = t.mock.method(tmux, "inspectPane", async () => {
			throw new Error("widget must not inspect");
		});
		registerDelegateWidget(
			pi,
			results(records),
			tmux,
			async () => {},
			() => {},
		);
		const ctx = s.context as unknown as ExtensionContext;
		try {
			await handlers.get("session_start")?.({}, ctx);
			const deadline = Date.now() + 5000;
			while (!s.widgetCalls.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
			assert.ok(s.widgetCalls.length, "observer completed an actual refresh");
			assert.equal(tmux.listCalls, 0);
			assert.equal(inspect.mock.callCount(), 0);
			assert.equal(locate.mock.callCount(), 0);
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
		}
	}
});
