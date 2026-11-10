import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Results, StartedRecorded } from "../src/results.ts";
import { windowLocator } from "../src/tmux.ts";
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
	for (const listing of [undefined, await tmux.listPanes()]) {
		const found = await currentChildWindows(results([record]), listing, reader);
		assert.equal(found.size, 0);
	}
	tmux.addWindow("@1", "child");
	const listing = await tmux.listPanes();
	for (const records of [[], [record, { ...record, id: "newest", closed: true }]]) {
		assert.equal((await currentChildWindows(results(records), listing, reader)).size, 0);
	}
	assert.equal(inspect.mock.callCount(), 0);
	assert.equal(locate.mock.callCount(), 0);
});

test("only missing recorded windows read locators and resolve stable panes from the listing", async (t) => {
	const tmux = new FakeTmux();
	tmux.addWindow("@1", "child");
	tmux.addWindow("@8", "renamed");
	tmux.panes.set("%7", { windowId: "@8" });
	const reader = new LiveActivityReader();
	const scope = { ...tmux.scope };
	const locate = t.mock.method(reader, "locator", async () => ({
		locator: { ...scope, paneId: "%7", windowId: "@70", windowName: "old", exited: false },
		generation: "g",
		ownerToken: "owner",
		pid: process.pid,
	}));
	const inspect = t.mock.method(tmux, "inspectPane");
	assert.equal((await currentChildWindows(results([record]), await tmux.listPanes(), reader)).size, 0);
	assert.equal(locate.mock.callCount(), 0);
	tmux.windows.delete("@1");
	let found = await currentChildWindows(results([record]), await tmux.listPanes(), reader);
	assert.deepEqual(found.get(record.id), { locator: windowLocator({ id: "@8", name: "renamed" }) });
	tmux.addWindow("@9", "broken-out");
	tmux.panes.set("%7", { windowId: "@9" });
	found = await currentChildWindows(results([record]), await tmux.listPanes(), reader);
	assert.deepEqual(found.get(record.id), { locator: windowLocator({ id: "@9", name: "broken-out" }) });
	tmux.scope = { ...tmux.scope, serverStarted: "new-server" };
	assert.equal((await currentChildWindows(results([record]), await tmux.listPanes(), reader)).size, 0);
	assert.equal(inspect.mock.callCount(), 0);
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
			async () => {},
			() => {},
		);
		const ctx = s.context as unknown as ExtensionContext;
		try {
			await handlers.get("session_start")?.({}, ctx);
			const deadline = Date.now() + 5000;
			while (!s.widgetCalls.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
			assert.ok(s.widgetCalls.length, "observer completed an actual refresh");
			assert.equal(tmux.listCalls + tmux.paneListCalls, 0);
			assert.equal(inspect.mock.callCount(), 0);
			assert.equal(locate.mock.callCount(), 0);
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
		}
	}
});
