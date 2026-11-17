import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { createHerdrClient } from "../src/herdr.ts";
import { chooseMultiplexer, createMultiplexer } from "../src/multiplexer.ts";
import { launchEnvironment, rexInvocation } from "../src/rex.ts";
import { rexLocator } from "../src/rex-locator.ts";
import { askWindowStates } from "../src/window-state.ts";
import { FakeTmux } from "./fake-tmux.ts";
import { agentDir, agentFile, cleanup, resetRoot, session, writeAgent } from "./harness.ts";
import { RexWire } from "./rex-adapter-fixture.ts";

const wires: RexWire[] = [];
beforeEach(() => {
	resetRoot();
	writeAgent("scout", agentFile({ model: "alpha/fast-model", thinking: "low" }));
});
after(async () => {
	for (const wire of wires) wire.dispose();
	await cleanup();
});
function wire(): RexWire {
	const value = new RexWire();
	wires.push(value);
	return value;
}
const settings = join(agentDir, "squire", "settings.json");
function setSettings(value: unknown): void {
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(settings, JSON.stringify(value));
}
/** A Pi in the wire's Rex terminal; tmux and Herdr absent unless asked. */
function mux(r: RexWire, options: { inTmux?: boolean; inherited?: string } = {}) {
	const tmux = Object.assign(new FakeTmux(), { inside: options.inTmux ?? false });
	const herdr = createHerdrClient({ context: () => undefined });
	return {
		tmux,
		multiplexer: createMultiplexer(
			tmux,
			herdr,
			() => agentDir,
			() => options.inherited,
			undefined,
			r.client,
		),
	};
}
const creates = (r: RexWire) => r.calls.filter((call) => call.args[0] === "window" && call.args[1] === "new");

test("selection: Rex alone is detected; several terminals refuse naming each; the setting and launcher choose Rex", () => {
	const base = { agentDir, inherited: undefined, inPaseo: false, inTmux: false, inHerdr: false };
	assert.equal(chooseMultiplexer({ ...base, inRex: true }), "rex");
	assert.throws(
		() => chooseMultiplexer({ ...base, inTmux: true, inRex: true }),
		(error: Error) =>
			error.message.startsWith("this session is inside both tmux and Rex") &&
			error.message.includes('"multiplexer": "tmux" or "rex"'),
	);
	assert.throws(
		() => chooseMultiplexer({ ...base, inTmux: true, inHerdr: true, inRex: true }),
		(error: Error) =>
			error.message.startsWith("this session is inside tmux, Herdr and Rex") &&
			error.message.includes('"multiplexer": "tmux", "herdr" or "rex"'),
	);
	assert.equal(chooseMultiplexer({ ...base, inherited: "rex", inTmux: true, inHerdr: true }), "rex");
	setSettings({ multiplexer: "rex" });
	assert.equal(chooseMultiplexer({ ...base, inTmux: true }), "rex");
	setSettings({ multiplexer: "tmux" });
	assert.equal(chooseMultiplexer({ ...base, inRex: true }), "tmux");
});

test("every call names the endpoint and never starts a server", () => {
	assert.deepEqual(rexInvocation({ server: "unix:///s.sock" }, ["block", "ls"]), [
		"-S",
		"unix:///s.sock",
		"--autostart=false",
		"block",
		"ls",
	]);
});

test("the launch environment drops every multiplexer's routing and this coordinator's identity", () => {
	const env = launchEnvironment(
		{ env: { PI_DELEGATE_PARENT: "child-parent", EXTRA: "1", REX_SESSION: "spec-leak" } },
		{
			PATH: "/bin",
			REX_SERVER: "unix:///s",
			REX_SESSION: "session:p",
			REX_BLOCK: "block:p",
			TMUX: "/t",
			HERDR_ENV: "1",
			PI_DELEGATE_PARENT: "grandparent",
			PI_SQUIRE_LIVE_LAUNCH: "x",
		},
	);
	assert.deepEqual(env, { PATH: "/bin", PI_DELEGATE_PARENT: "child-parent", EXTRA: "1" });
});

test("availability refuses an old API, a changed endpoint and a block no longer in its session", async () => {
	const r = wire();
	assert.equal(await r.client.unavailable(true), undefined);
	r.revision = 15;
	assert.match((await r.client.unavailable(true)) ?? "", /API revision 16/);
	r.revision = 16;
	r.endpoint = "unix:///other.sock";
	assert.match((await r.client.unavailable(true)) ?? "", /identity changed/);
	r.endpoint = undefined;
	r.blocks.delete("block:parent");
	assert.match((await r.client.unavailable(true)) ?? "", /no longer in session/);
	r.failedAsk = true;
	assert.match((await r.client.unavailable(true)) ?? "", /^could not ask Rex/);
});

test("Rex delegate opens an unfocused window running the staged launcher, reports status and closes only its block", async () => {
	const r = wire();
	setSettings({ multiplexer: "rex", windowPlacement: "invalid-tmux-only" });
	const { tmux, multiplexer } = mux(r);
	const s = session({ tmux, multiplexer });
	await s.start();
	const output = await s.toolCall("delegate", { agent: "scout", task: "look", label: "native", autoExit: false });
	assert.match(output.content[0].text, /window scout-native \(window:2\) in Rex session session:test/);
	assert.equal(s.sendCalls.length, 1, "a fresh launch mails its task once");
	assert.equal(tmux.opened.length, 0);
	const start = s.entries.find((entry) => entry.customType === "delegate-start-v2")?.data as {
		id: string;
		locator: object;
	};
	const own = rexLocator(start.locator);
	assert.ok(own);
	r.staged.push(dirname(own.launchFile));
	const [create] = creates(r);
	assert.deepEqual(create.args.slice(0, 5), ["window", "new", "-s", "session:test", "scout-native"]);
	assert.ok(create.args.includes("--focus=false") && create.args.includes("--shell=none"));
	assert.deepEqual(create.args.slice(-3), ["--", process.execPath, own.launchFile]);
	const staged = readFileSync(own.launchFile, "utf8");
	assert.match(staged, /"PI_DELEGATE_MULTIPLEXER":"rex"/);
	assert.doesNotMatch(staged, /"REX_SESSION"/);

	const status = await s.toolCall("delegation_status", { id: start.id });
	assert.match(status.content[0].text, /state: running/);
	assert.match(status.content[0].text, /window: scout-native \(window:2\)/);
	// A start that fails at once leaves Rex's terminal for inspection; it is not running.
	writeFileSync(`${own.launchFile}.status`, JSON.stringify({ pid: 99, exit: 1 }));
	assert.doesNotMatch((await s.toolCall("delegation_status", { id: start.id })).content[0].text, /state: running/);
	// The user added a block to the delegate's window: close leaves it alone.
	r.blocks.set("block:user", { block_id: "block:user", window_id: own.window, label: "shell", placement: "placed" });
	const close = await s.toolCall("delegation_close", { id: start.id });
	assert.match(close.content[0].text, /Closed delegation subtree/);
	assert.equal(r.blocks.has(own.block), false);
	assert.equal(r.blocks.has("block:user"), true);
	assert.equal(r.blocks.has("block:parent"), true);
	assert.equal(r.calls.filter((call) => call.args[0] === "window" && call.args[1] === "close").length, 0);
});

test("a chosen unusable Rex refuses before task mail and never falls back to tmux", async () => {
	const r = wire();
	setSettings({ multiplexer: "rex" });
	const { tmux, multiplexer } = mux(r, { inTmux: true });
	const s = session({ tmux, multiplexer });
	await s.start();
	for (const mode of ["environment", "server", "revision"]) {
		r.unavailable = mode === "environment";
		r.failedAsk = mode === "server";
		r.revision = mode === "revision" ? 1 : 16;
		await assert.rejects(s.toolCall("delegate", { agent: "scout", task: "look" }), /Rex/);
	}
	assert.equal(s.sendCalls.length, 0);
	assert.equal(tmux.opened.length, 0);
	assert.equal(creates(r).length, 0);
});

test("a block that exits between observation and close is gone, not an error", async () => {
	const r = wire();
	const record = await r.open("racing");
	const own = rexLocator(record.locator);
	assert.ok(own);
	const states = await askWindowStates(r.client);
	r.beforeClose = () => r.blocks.delete(own.block);
	assert.equal(await states.close(record), false);
});

test("another session's or server's locator is unknown and never closed", async () => {
	const r = wire();
	const record = await r.open("mine");
	const own = rexLocator(record.locator);
	assert.ok(own);
	const states = await askWindowStates(r.client);
	for (const foreign of [
		{ ...own, session: "session:other" },
		{ ...own, server: "unix:///other.sock" },
	]) {
		assert.equal(states.state({ locator: foreign }), "unknown");
		await assert.rejects(states.close({ locator: foreign }));
	}
	assert.equal(r.blocks.has(own.block), true);
});

test("peek keeps only the recent rows of the whole scrollback", async () => {
	const r = wire();
	const record = await r.open("long");
	const own = rexLocator(record.locator);
	assert.ok(own);
	const run = r.run.bind(r);
	r.run = async (route, args) =>
		args[0] === "capture" ? Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n") : run(route, args);
	const text = await r.client.peek({ windowId: own.window, locator: own });
	const lines = text.split("\n");
	assert.equal(lines.length, 500);
	assert.equal(lines.at(-1), "line 1999");
});

test("own-block telemetry names the caller's window and verifies only a listed block", async () => {
	const r = wire();
	const live = await r.client.observeLivePane?.();
	assert.deepEqual(live, {
		adapter: "rex",
		version: 1,
		kind: "pane",
		server: r.context.server,
		session: r.context.session,
		block: "block:parent",
		window: "window:main",
		name: "main",
	});
	assert.ok(live);
	assert.equal((await r.client.verifyLivePane?.(live))?.paneTarget, "block:parent");
	r.blocks.delete("block:parent");
	assert.equal(await r.client.verifyLivePane?.(live), undefined);
});
