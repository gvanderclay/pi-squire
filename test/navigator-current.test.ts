import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createNavigator } from "../src/navigator.ts";
import { branchItems, dashboardRows, NavigatorView } from "../src/navigator-view.ts";
import type { Results, StartedRecorded } from "../src/results.ts";
import { LiveActivityReader, type LiveLocator } from "../src/widget-live.ts";
import { FakeTmux } from "./fake-tmux.ts";

function setup() {
	const tmux = new FakeTmux();
	tmux.addWindow("@0", "caller", "work");
	tmux.addWindow("@1", "historical", "old-session");
	tmux.addWindow("@2", "reattached", "new-session");
	tmux.ownPane = "%0";
	tmux.panes.set("%0", { windowId: "@0" });
	tmux.panes.set("%2", { windowId: "@2", exited: false });
	const record: StartedRecorded = {
		id: "old-launch",
		sessionId: "child",
		agent: "worker",
		name: "stable-child",
		model: "local/model",
		thinking: "off",
		windowId: "@1",
		windowName: "historical",
		requestId: "request",
		gone: true,
	};
	const records = [record];
	const results = {
		list: () => records,
		find: (id: string) => records.find((entry) => entry.id === id),
	} as unknown as Results;
	let live: LiveLocator | undefined = {
		locator: { ...tmux.scope, paneId: "%2", windowId: "@2", windowName: "reattached", exited: false },
		generation: "generation",
		ownerToken: "token",
		pid: process.pid,
	};
	const reader = { locator: async () => live };
	const view = new NavigatorView(results, tmux, reader);
	return {
		tmux,
		record,
		records,
		results,
		view,
		reader,
		get live() {
			return live;
		},
		set live(value) {
			live = value;
		},
	};
}

test("current navigation preserves gone/failed launch facts and exact-pane liveness, never rewrites history", async () => {
	const f = setup();
	f.record.result = { status: "failed", replyId: "reply", envelopePath: "/result" };
	f.tmux.exit("@2"); // A DIFFERENT active pane is dead; the exact Pi pane is alive.
	const before = JSON.stringify(f.records);
	const [item] = (await f.view.items(true))!;
	assert.equal(item.window.id, "@2");
	assert.equal(item.navigable, true);
	assert.equal(item.state, "done");
	assert.match(dashboardRows([item])[0].label, /done \(failed\)/);
	assert.match(dashboardRows([item])[0].details.join("\n"), /launch window: historical \(@1\)/);
	assert.match(
		dashboardRows([item])[0].details.join("\n"),
		/current verified window: reattached \(@2\) in new-session/,
	);
	assert.equal(await f.view.verified(item), true);
	assert.equal(JSON.stringify(f.records), before);
});

test("lost/invalid current evidence never falls back to an old still-open window, including later refreshes", async () => {
	const f = setup();
	const [item] = (await f.view.items(true))!;
	f.live = undefined;
	assert.equal(await f.view.verified(item), false);
	assert.equal((await f.view.items(true))![0].navigable, false);
	assert.deepEqual(await f.view.items(), []);
	f.live = { ...item.live!, locator: { ...item.live!.locator, serverStarted: "other-incarnation" } };
	assert.equal((await f.view.items(true))![0].navigable, false);
	assert.equal(f.tmux.windows.has("@1"), true);
});

test("generation/owner/pane changes across verification refuse and obsolete attempts cannot acquire successor locators", async () => {
	const f = setup();
	const [item] = (await f.view.items(true))!;
	f.live = { ...f.live!, generation: "replacement", ownerToken: "replacement-token" };
	assert.equal(await f.view.verified(item), false);
	const current = (await f.view.items(true))![0];
	const inspect = f.tmux.inspectPane.bind(f.tmux);
	f.tmux.inspectPane = async (pane) => {
		const found = await inspect(pane);
		if (pane === "%2") f.live = undefined;
		return found;
	};
	assert.equal(await f.view.verified(current), false, "recheck owner snapshot after awaited pane/list verification");
	f.tmux.inspectPane = inspect;
	f.records.push({ ...f.record, id: "successor", resumedFrom: f.record.id, gone: undefined });
	f.live = item.live;
	const items = (await f.view.items(true))!;
	assert.equal(items[0].navigable, false);
	assert.equal(items[1].window.id, "@2");
});

test("legacy id+name verification stays available without snapshots; listing failure is unknown and refuses actions", async () => {
	const f = setup();
	f.live = undefined;
	const [item] = (await f.view.items(true))!;
	assert.equal(item.window.id, "@1");
	assert.equal(await f.view.verified(item), true);
	f.tmux.failList = "unavailable";
	assert.equal(await f.view.verified(item), false);
	assert.equal((await f.view.items(true))![0].navigable, false);
	assert.equal(await f.view.items(), undefined);
});

test("shared navigator command/dashboard peek targets current exact pane and switch rechecks after client lookup", async () => {
	const f = setup();
	const original = LiveActivityReader.prototype.locator;
	LiveActivityReader.prototype.locator = f.reader.locator;
	try {
		f.tmux.attachClient("attached", 10);
		const notifications: string[] = [];
		const ctx = {
			mode: "tui",
			sessionManager: { getSessionId: () => "root" },
			ui: {
				notify: (text: string) => notifications.push(text),
				custom: async (
					factory: (...args: unknown[]) => { handleInput(data: string): void; render(width: number): string[] },
				) =>
					new Promise((resolve) => {
						const screen = factory(
							{ requestRender() {}, terminal: { rows: 30 } },
							{ fg: (_: string, text: string) => text, bold: (text: string) => text },
							{},
							resolve,
						);
						setImmediate(() => {
							screen.handleInput("\x1b");
						});
					}),
			},
		} as unknown as ExtensionContext;
		const navigator = createNavigator(f.results, f.tmux, {} as never, () => {});
		await navigator.openDelegate(ctx, f.record.id, "peek");
		assert.deepEqual(f.tmux.captures, ["%2"]);
		await navigator.openDelegate(ctx, f.record.id, "switch");
		assert.equal(f.tmux.switches.at(-1)?.windowId, "@2");
		const clientFor = f.tmux.clientFor.bind(f.tmux);
		f.tmux.clientFor = async (name) => {
			const client = await clientFor(name);
			f.live = undefined;
			return client;
		};
		await navigator.openDelegate(ctx, f.record.id, "switch");
		assert.equal(f.tmux.switches.length, 1);
		assert.ok(notifications.some((note) => note.includes("window changed or unavailable")));
		assert.equal(f.tmux.killed.length, 0);
	} finally {
		LiveActivityReader.prototype.locator = original;
	}
});

test("verified latest live window-closed rows stay in command/completions without inventing semantic disappearance", async () => {
	const f = setup();
	delete f.record.gone;
	f.tmux.windows.delete("@1");
	const before = JSON.stringify(f.records);
	const [item] = (await f.view.items())!;
	assert.equal(item.state, "window-closed");
	assert.equal(item.window.id, "@2");
	assert.equal(item.navigable, true);
	const original = LiveActivityReader.prototype.locator;
	LiveActivityReader.prototype.locator = f.reader.locator;
	try {
		f.tmux.attachClient("attached", 10);
		const ctx = {
			mode: "tui",
			ui: { notify: () => {} },
		} as unknown as ExtensionContext;
		const navigator = createNavigator(f.results, f.tmux, {} as never, () => {});
		assert.deepEqual(await navigator.openIds(), [f.record.id]);
		await navigator.openDelegate(ctx, f.record.id, "switch");
		assert.equal(f.tmux.switches.at(-1)?.windowId, "@2");
		f.record.closed = true;
		assert.deepEqual(await navigator.openIds(), []);
		delete f.record.closed;
		f.record.accountingOnly = true;
		assert.deepEqual(await navigator.openIds(), []);
		delete f.record.accountingOnly;
		assert.equal(JSON.stringify(f.records), before);
	} finally {
		LiveActivityReader.prototype.locator = original;
	}
});

test("close confirms verified live gone/done/window-closed rows but passes only id and current ctx to control", async () => {
	const original = LiveActivityReader.prototype.locator;
	try {
		for (const state of ["gone", "done", "window-closed"]) {
			const f = setup();
			if (state !== "gone") delete f.record.gone;
			if (state === "done") f.record.result = { status: "done", replyId: "reply", envelopePath: "/result" };
			if (state === "window-closed") f.tmux.windows.delete("@1");
			LiveActivityReader.prototype.locator = f.reader.locator;
			const before = JSON.stringify(f.records);
			let choose = true;
			let consent = false;
			let closes = 0;
			const confirmations: string[] = [];
			const ctx = {
				mode: "tui",
				sessionManager: { getSessionId: () => "root" },
				ui: {
					notify: () => {},
					confirm: async (_title: string, message: string) => {
						confirmations.push(message);
						return consent;
					},
					custom: async () => {
						if (!choose) return undefined;
						choose = false;
						return { action: "close", id: f.record.id };
					},
				},
			} as unknown as ExtensionContext;
			const navigator = createNavigator(f.results, f.tmux, {} as never, () => {}, {
				close: async (id, context) => {
					assert.equal(id, f.record.id);
					assert.equal(context, ctx);
					closes++;
					return { text: "Durable control result, not a telemetry-targeted kill" };
				},
			});
			await navigator.panel(ctx);
			assert.equal(closes, 0, "No cancels before control effects");
			choose = true;
			consent = true;
			await navigator.panel(ctx);
			assert.equal(closes, 1);
			assert.equal(confirmations.length, 2);
			assert.match(confirmations[0], /verified shared-control windows.*Reattached navigation windows may remain open/);
			assert.deepEqual(f.tmux.killed, [], "presentation never retargets a close with its live locator");
			assert.equal(f.tmux.windows.has("@2"), true);
			assert.equal(JSON.stringify(f.records), before);
		}
	} finally {
		LiveActivityReader.prototype.locator = original;
	}
});

test("ownership loss after successful switch reports the completed effect, not a failed switch", async () => {
	const f = setup();
	const original = LiveActivityReader.prototype.locator;
	LiveActivityReader.prototype.locator = f.reader.locator;
	try {
		f.tmux.attachClient("attached", 10);
		let active = true;
		const notes: { text: string; type: string }[] = [];
		const switchTo = f.tmux.switchTo.bind(f.tmux);
		f.tmux.switchTo = async (client, windowId) => {
			await switchTo(client, windowId);
			active = false;
		};
		const ctx = {
			mode: "tui",
			ui: { notify: (text: string, type: string) => notes.push({ text, type }) },
		} as unknown as ExtensionContext;
		const navigator = createNavigator(f.results, f.tmux, {} as never, () => {}, {
			assertActive: () => {
				if (!active) throw Error("replacement owner");
			},
		});
		await navigator.openDelegate(ctx, f.record.id, "switch");
		assert.equal(f.tmux.switches.length, 1);
		assert.ok(notes.some((note) => /switched to.*session ownership lost/.test(note.text) && note.type === "warning"));
		assert.ok(notes.every((note) => !note.text.includes("could not switch")));
	} finally {
		LiveActivityReader.prototype.locator = original;
	}
});

test("branch projection retains all historical attempts and depth, but never siblings or an unrelated root", async () => {
	const f = setup();
	const identity = (parent: string, root: string, depth: number) => ({
		parent,
		root,
		depth,
		agent: "worker",
		chain: [],
		autoExit: false,
		rootPlacement: "project-delegate-session",
	});
	f.record.identity = identity("root", "root", 1);
	f.records.push(
		{ ...f.record, id: "grandchild", sessionId: "grandchild", identity: identity("child", "root", 2) },
		{ ...f.record, id: "retry", resumedFrom: f.record.id },
		{ ...f.record, id: "deep", sessionId: "deep", identity: identity("grandchild", "root", 3) },
		{ ...f.record, id: "sibling", sessionId: "sibling" },
		{ ...f.record, id: "foreign", sessionId: "foreign", identity: identity("foreign-root", "foreign-root", 1) },
	);
	const all = (await f.view.items(true))!;
	const branch = branchItems(all, "child");
	assert.deepEqual(
		branch.map((item) => item.id),
		["old-launch", "grandchild", "retry", "deep"],
	);
	assert.deepEqual(
		dashboardRows(branch).map((row) => row.depth),
		[0, 1, 0, 2],
	);
	assert.deepEqual(branchItems(all, "absent"), []);
	assert.equal(branchItems(all, undefined), all);
});
