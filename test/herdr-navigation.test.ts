import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { createHerdrClient } from "../src/herdr.ts";
import { herdrLocator, herdrPaneLocator } from "../src/herdr-locator.ts";
import { createMultiplexer } from "../src/multiplexer.ts";
import { NavigatorView } from "../src/navigator-view.ts";
import type { Results, StartedRecorded } from "../src/results.ts";
import { normalizeLiveLocator, validWindowLocator, verifyPaneWindow } from "../src/tmux-locator.ts";
import { DELEGATE_WIDGET_KEY } from "../src/widget.ts";
import { DirectDelegateView } from "../src/widget-data.ts";
import { LiveActivityReader, type LiveLocator } from "../src/widget-live.ts";
import { askPaneStates, askWindowStates } from "../src/window-state.ts";
import { FakeTmux } from "./fake-tmux.ts";
import { agentDir, agentFile, cleanup, resetRoot, session, writeAgent } from "./harness.ts";
import { HerdrWire } from "./herdr-adapter-fixture.ts";

const wires: HerdrWire[] = [];
const sessions: ReturnType<typeof session>[] = [];
beforeEach(() => {
	resetRoot();
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(join(agentDir, "squire", "settings.json"), JSON.stringify({ multiplexer: "herdr" }));
	writeAgent("scout", agentFile({ model: "alpha/fast-model", thinking: "low", auto_exit: "false" }));
});
afterEach(async () => {
	for (const s of sessions.splice(0).reverse()) await s.shutdown();
	for (const h of wires.splice(0)) h.dispose();
});
after(cleanup);
function wire(): HerdrWire {
	const h = new HerdrWire();
	wires.push(h);
	return h;
}
function instance(h: HerdrWire, pane = h.context.pane, parent?: string): ReturnType<typeof session> {
	const client = createHerdrClient({ run: h.run.bind(h), context: () => ({ ...h.context, pane }) });
	// A Herdr-hosted Pi: no tmux context, so its own-pane telemetry host is unambiguous.
	const tmux = Object.assign(new FakeTmux(), { inside: false });
	const s = session({ mode: "tui", parent, multiplexer: createMultiplexer(tmux, client, () => agentDir) });
	sessions.push(s);
	return s;
}
async function until(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(check(), "expected navigation observation");
}
function frame(s: ReturnType<typeof session>): string {
	return s.widgets.get(DELEGATE_WIDGET_KEY)?.render(160).join("\n") ?? "";
}

test("Herdr show and recent peek verify locator identity and never route by presentation ids", async () => {
	const h = wire();
	const record = await h.open("owned");
	const locator = herdrLocator(record.locator)!;
	const target = { windowId: "wrong-display-id", paneId: "wrong-display-pane", locator };
	assert.equal(await h.client.peek(target), "SQUIRE-ADAPTER-SCREEN");
	const read = h.calls.findLast((call) => call.args[1] === "read")!;
	assert.deepEqual(read.args, ["pane", "read", locator.pane, "--source", "recent"]);
	assert.equal(h.shown, "w1:t1", "peek never focuses");
	const shown = await h.client.show(target, async () => true);
	assert.ok("shown" in shown && shown.shown);
	assert.match(shown.returnHint, /tab w1:t1.*Herdr's tab bar/);
	assert.doesNotMatch(shown.returnHint, /key|ctrl|alt/i);
	assert.equal(h.shown, locator.tab);
	assert.equal(h.calls.filter((call) => call.args[1] === "focus").length, 1);
	await assert.rejects(h.client.peek({ windowId: locator.tab, paneId: locator.pane }), /no verified open tab/);
});

test("Herdr focus and peek refuse replaced terminals, failed probes and cancellation without focusing or reading", async () => {
	const h = wire();
	const record = await h.open("race");
	const locator = herdrLocator(record.locator)!;
	const target = { windowId: locator.tab, locator };
	const before = h.calls.length;
	assert.deepEqual(await h.client.show(target, async () => false), { shown: false });
	await assert.rejects(
		h.client.show(target, async () => {
			h.panes.get(locator.pane)!.terminal_id = "restored";
			return true;
		}),
		/tab changed or unavailable/,
	);
	await assert.rejects(h.client.peek(target), /tab changed or unavailable/);
	h.panes.get(locator.pane)!.terminal_id = locator.terminal;
	h.failedAsk = true;
	await assert.rejects(h.client.peek(target), /server unavailable/);
	await assert.rejects(
		h.client.show(target, async () => true),
		/server unavailable/,
	);
	assert.equal(
		h.calls.slice(before).some((call) => ["focus", "read", "close"].includes(call.args[1])),
		false,
	);
});

test("Herdr rechecks the exact terminal after its snapshot immediately before focus and capture", async () => {
	const h = wire();
	const record = await h.open("final-race");
	const locator = herdrLocator(record.locator)!;
	const client = createHerdrClient({
		context: () => h.context,
		run: async (session: string, args: string[]): Promise<string> => {
			if (args[0] === "pane" && args[1] === "get" && args[2] === locator.pane)
				h.panes.get(locator.pane)!.terminal_id = "replacement";
			return h.run(session, args);
		},
	});
	const target = { windowId: locator.tab, locator };
	await assert.rejects(
		client.show(target, async () => true),
		/tab changed or unavailable/,
	);
	h.panes.get(locator.pane)!.terminal_id = locator.terminal;
	await assert.rejects(client.peek(target), /tab changed or unavailable/);
	assert.equal(
		h.calls.some((call) => ["focus", "read"].includes(call.args[1])),
		false,
	);
});

test("Herdr disposable root-pane telemetry verifies same server/terminal but cannot become durable launch authority", async () => {
	const h = wire();
	const live = await h.client.observeLivePane!();
	assert.ok(herdrPaneLocator(live));
	assert.ok(normalizeLiveLocator(live));
	assert.equal(validWindowLocator(live), false, "navigation evidence is never a durable close/resume locator");
	assert.equal((await verifyPaneWindow(h.client, live!))?.paneTarget, h.context.pane);
	await assert.rejects(
		(await askWindowStates(h.client)).close({ locator: live }),
		/could not verify Herdr terminal identity/,
	);
	const wrong = { ...live, socket: "/other-server" };
	assert.equal(await verifyPaneWindow(h.client, wrong), undefined);
	h.panes.get(h.context.pane)!.terminal_id = "restored";
	assert.equal(await verifyPaneWindow(h.client, live!), undefined);
});

test("retained Herdr error tabs stay in navigator and widget without rewriting gone/result facts", async () => {
	const h = wire();
	const own = await h.open("failed");
	const locator = herdrLocator(own.locator)!;
	const record: StartedRecorded = {
		...own,
		id: "launch",
		sessionId: "child",
		agent: "scout",
		name: "failed",
		model: "local/model",
		thinking: "off",
		requestId: "request",
		result: { status: "failed", replyId: "reply", envelopePath: "/result" },
	};
	const results = { list: () => [record], running: () => [] } as unknown as Results;
	let live: LiveLocator | undefined = {
		locator: { ...locator, kind: "pane" },
		generation: "generation",
		ownerToken: "token",
		pid: process.pid,
	};
	const view = new NavigatorView(results, h.client, { locator: async () => live });
	assert.equal((await view.items())?.length, 1);
	live = undefined;
	writeFileSync(`${locator.launchFile}.status`, JSON.stringify({ pid: 10, exit: 1 }));
	record.gone = true;
	const before = JSON.stringify(record);
	const [item] = (await view.items())!;
	assert.equal(item.window.id, locator.tab);
	assert.equal(await view.verified(item), true);
	const states = await askWindowStates(h.client);
	assert.equal(states.state(record), "gone", "program exit remains factual");
	const rows = new DirectDelegateView().read(results, states, undefined);
	assert.equal(rows[0].state, "failed");
	assert.equal(JSON.stringify(record), before);
	h.panes.get(locator.pane)!.terminal_id = "restored";
	assert.deepEqual(await view.items(), []);
	assert.deepEqual(new DirectDelegateView().read(results, await askWindowStates(h.client), undefined), []);
});

test("widget Enter explicitly focuses a Herdr delegate and child breadcrumb returns to its live parent", async () => {
	const h = wire();
	const root = instance(h);
	await root.start();
	const output = await root.toolCall("delegate", { agent: "scout", label: "navigation", task: "look" });
	const id = (output.details as { id: string }).id;
	const record = root.entries.find((entry) => entry.customType === "delegate-start-v2")!.data as StartedRecorded;
	const locator = herdrLocator(record.locator)!;
	h.staged.push(join(locator.launchFile, ".."));
	await until(() => frame(root).includes("navigation"));
	assert.equal(h.shown, "w1:t1", "launch and observation remain unfocused");
	root.terminalKey("down");
	root.terminalKey("enter");
	await until(() => h.shown === locator.tab);
	assert.ok(root.notes.some((note) => /switched to.*Herdr's tab bar/.test(note)));
	const child = instance(h, locator.pane, id);
	await child.start();
	const reader = new LiveActivityReader();
	await until(() => frame(child).includes("(you)"));
	await until(() => h.calls.some((call) => call.args[0] === "api"));
	assert.ok(await reader.locator(root.parent), "root publishes disposable terminal evidence");
	child.terminalKey("down");
	child.terminalKey("enter");
	await until(() => h.shown === "w1:t1");
	assert.ok(child.notes.some((note) => /switched to ancestor/.test(note)));
	await root.command("delegate-open", id);
	assert.equal(h.shown, locator.tab, "live child telemetry routes to Herdr even through the mixed adapter");
	h.panes.delete(locator.pane);
	await root.command("delegate-open", id);
	assert.ok(root.errors.some((note) => /no verified open tab.*tab changed or unavailable/.test(note)));
});

test("mixed-backend navigation follows the locator after the launch setting changes", async () => {
	const h = wire();
	const tmux = new FakeTmux();
	const mux = createMultiplexer(tmux, h.client, () => agentDir);
	const record = await h.open("history");
	const locator = herdrLocator(record.locator)!;
	writeFileSync(join(agentDir, "squire", "settings.json"), JSON.stringify({ multiplexer: "tmux" }));
	assert.equal((await askPaneStates(mux)).state(record), "running");
	await mux.show({ windowId: locator.tab, locator }, async () => true);
	assert.equal(h.shown, locator.tab);
	assert.equal(await mux.peek({ windowId: locator.tab, locator }), "SQUIRE-ADAPTER-SCREEN");
	assert.equal(tmux.switches.length, 0);
	assert.equal(tmux.captures.length, 0);
	assert.throws(() => mux.show({ windowId: locator.tab }, async () => true), /no verified delegate navigation locator/);
	assert.throws(
		() => mux.peek({ windowId: "@1", locator: { adapter: "unsupported" } }),
		/no verified delegate navigation locator/,
	);
	assert.equal(tmux.switches.length, 0);
	assert.equal(tmux.captures.length, 0);
});
