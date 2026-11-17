import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { createHerdrClient } from "../src/herdr.ts";
import { chooseMultiplexer, createMultiplexer } from "../src/multiplexer.ts";
import { launchEnvironment, rexInvocation } from "../src/rex.ts";
import { rexLocator } from "../src/rex-locator.ts";
import { placementProject } from "../src/window-placement.ts";
import { askWindowStates } from "../src/window-state.ts";
import { FakeTmux } from "./fake-tmux.ts";
import { agentDir, agentFile, cleanup, resetRoot, root, session, sessionDir, writeAgent } from "./harness.ts";
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

test("Rex delegate opens one unfocused window in the managed companion session and closes only its block", async () => {
	const r = wire();
	setSettings({ multiplexer: "rex" });
	const { tmux, multiplexer } = mux(r);
	const s = session({ tmux, multiplexer });
	await s.start();
	const output = await s.toolCall("delegate", { agent: "scout", task: "look", label: "native", autoExit: false });
	assert.equal(s.sendCalls.length, 1, "a fresh launch mails its task once");
	assert.equal(tmux.opened.length, 0);
	const start = s.entries.find((entry) => entry.customType === "delegate-start-v2")?.data as {
		id: string;
		locator: object;
	};
	const own = rexLocator(start.locator);
	assert.ok(own);
	r.staged.push(dirname(own.launchFile));
	// The default placement creates one EMPTY companion session, then one full
	// delegate window in it: no initial shell window, no split, no adoption.
	const created = r.calls.filter((call) => call.args[0] === "api" && call.args[2] === "session.create");
	assert.equal(created.length, 1);
	const request = JSON.parse(created[0].args[3]) as { label: string; initial_windows?: unknown };
	assert.equal(request.initial_windows, undefined, "the companion is created with no windows");
	assert.match(request.label, /-delegates$/);
	const companion = [...r.sessions.values()].find((session) => session.label === request.label);
	assert.ok(companion);
	assert.equal(own.session, companion.id, "the locator names the exact created session id");
	assert.ok(output.content[0].text.includes(`in Rex session ${request.label} (${companion.id})`));
	const [create] = creates(r);
	assert.deepEqual(create.args.slice(0, 5), ["window", "new", "-s", companion.id, "scout-native"]);
	assert.ok(create.args.includes("--focus=false") && create.args.includes("--shell=none"));
	assert.deepEqual(create.args.slice(-3), ["--", process.execPath, own.launchFile]);
	assert.equal(r.session.blocks.size, 1, "the caller session keeps only its own block");
	assert.equal(companion.blocks.size, 1, "the companion holds exactly the delegate tab");
	const staged = readFileSync(own.launchFile, "utf8");
	assert.match(staged, /"PI_DELEGATE_MULTIPLEXER":"rex"/);
	assert.doesNotMatch(staged, /"REX_SESSION"/);

	const status = await s.toolCall("delegation_status", { id: start.id });
	assert.match(status.content[0].text, /state: running/);
	assert.ok(status.content[0].text.includes(`window: scout-native (${own.window})`));
	// A start that fails at once leaves Rex's terminal for inspection; it is not running.
	writeFileSync(`${own.launchFile}.status`, JSON.stringify({ pid: 99, exit: 1 }));
	assert.doesNotMatch((await s.toolCall("delegation_status", { id: start.id })).content[0].text, /state: running/);
	// The user added a block to the delegate's window: close leaves it alone.
	companion.blocks.set("block:user", {
		block_id: "block:user",
		window_id: own.window,
		label: "shell",
		placement: "placed",
	});
	const close = await s.toolCall("delegation_close", { id: start.id });
	assert.match(close.content[0].text, /Closed delegation subtree/);
	assert.equal(companion.blocks.has(own.block), false);
	assert.equal(companion.blocks.has("block:user"), true);
	assert.equal(r.blocks.has("block:parent"), true);
	assert.equal(r.sessions.has(companion.id), true, "the companion session is retained, never destroyed");
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

test("a locator in another session of the same server is observed and closed; another server is never touched", async () => {
	const r = wire();
	const record = await r.open("mine");
	const own = rexLocator(record.locator);
	assert.ok(own);
	// A delegate in a companion session is this server's resource, not another's.
	const companion = r.addSession("project-delegates");
	companion.blocks.set(own.block, { block_id: own.block, window_id: own.window, label: "shell", placement: "placed" });
	r.session.blocks.delete(own.block);
	const observed = await askWindowStates(r.client);
	const moved = { ...own, session: companion.id };
	assert.equal(observed.state({ locator: moved }), "running");
	// Close re-queries the locator's own session, then removes only that block.
	assert.equal(await observed.close({ locator: moved }), true);
	assert.equal(companion.blocks.has(own.block), false);
	assert.equal(await observed.close({ locator: moved }), false, "a second close is a no-op");
	// A foreign endpoint is unknown and never closed.
	const foreign = { ...own, server: "unix:///other.sock" };
	assert.equal(observed.state({ locator: foreign }), "unknown");
	await assert.rejects(observed.close({ locator: foreign }));
	// A successful list that omits the exact session positively proves it gone.
	assert.equal(observed.state({ locator: { ...own, session: "session:missing" } }), "gone");
	assert.equal(await observed.close({ locator: { ...own, session: "session:missing" } }), false);
});

test("navigation selects the app's current target window before focusing its exact block", async () => {
	const r = wire();
	const record = await r.open("show");
	const own = rexLocator(record.locator);
	assert.ok(own);
	// Window identity is presentation: the block can move after launch.
	r.blocks.get(own.block)!.window_id = "window:moved";
	const result = await r.client.show({ windowId: own.window, locator: own }, async () => true);
	assert.ok("shown" in result && result.shown);
	assert.equal(r.visible, "window:moved");
	assert.equal(r.active, "window:moved");
	const select = r.calls.findIndex((call) => call.args[0] === "-C");
	const focus = r.calls.findIndex((call) => call.args[0] === "focus");
	assert.deepEqual(r.calls[select].args, [
		"-C",
		"client:app",
		"do",
		"session.select",
		"session_id=session:test",
		"window_id=window:moved",
	]);
	assert.ok(select < focus, "a denied app action must not leave server-only focus changed");
});

test("app selection failure does not change server focus", async () => {
	const r = wire();
	const record = await r.open("denied");
	const own = rexLocator(record.locator);
	assert.ok(own);
	r.failSelect = true;
	await assert.rejects(
		r.client.show({ windowId: own.window, locator: own }, async () => true),
		/Remote Control/,
	);
	assert.equal(r.active, "window:main");
	assert.equal(r.visible, "window:main");
	assert.equal(
		r.calls.some((call) => call.args[0] === "focus"),
		false,
	);
});

test("a block moved during app selection is not focused in an invisible window", async () => {
	const r = wire();
	const record = await r.open("moving");
	const own = rexLocator(record.locator);
	assert.ok(own);
	const run = r.run.bind(r);
	r.run = async (route, args) => {
		const result = await run(route, args);
		if (args[0] === "-C") r.blocks.get(own.block)!.window_id = "window:other";
		return result;
	};
	await assert.rejects(
		r.client.show({ windowId: own.window, locator: own }, async () => true),
		/moved or closed/,
	);
	assert.equal(r.visible, own.window);
	assert.equal(
		r.calls.some((call) => call.args[0] === "focus"),
		false,
	);
});

test("navigation refuses ambiguous apps and ignores non-app clients before verification", async () => {
	const r = wire();
	const record = await r.open("apps");
	const own = rexLocator(record.locator);
	assert.ok(own);
	for (const clients of [
		[{ client_id: "client:cli", info: { kind: "cli" } }],
		[
			{ client_id: "client:one", info: { kind: "app" } },
			{ client_id: "client:two", info: { kind: "app" } },
		],
	]) {
		r.clients = clients;
		const result = await r.client.show({ windowId: own.window, locator: own }, async () => {
			assert.fail("no unambiguous viewer");
		});
		assert.ok("text" in result);
	}
	assert.equal(r.active, "window:main");
	assert.equal(r.visible, "window:main");
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

// ---- Placement admission, managed companions and cross-session lifecycle. ----

/** The companion base this test root's project prefers, with an optional suffix. */
function projectBase(suffix = "delegates"): string {
	const companion = placementProject(root).companion;
	return `${companion.slice(0, companion.length - "delegates".length)}${suffix}`;
}
const sessionCreates = (r: RexWire) =>
	r.calls.filter((call) => call.args[0] === "api" && call.args[2] === "session.create");
const startedRecord = (s: ReturnType<typeof session>) =>
	s.entries.find((entry) => entry.customType === "delegate-start-v2")?.data as
		| { id: string; locator: object; windowSession?: string }
		| undefined;

test("invalid Rex placement settings refuse at admission before mail or a window; valid values reach the open", async () => {
	const r = wire();
	const { tmux, multiplexer } = mux(r);
	const s = session({ tmux, multiplexer });
	await s.start();
	for (const value of [{ windowPlacement: "pane" }, { companionSuffix: "x-2" }, { companionSuffix: "" }]) {
		setSettings({ multiplexer: "rex", ...value });
		await assert.rejects(s.toolCall("delegate", { agent: "scout", task: "look" }), /window placement settings/);
	}
	assert.equal(s.sendCalls.length, 0, "no task was mailed");
	assert.equal(creates(r).length, 0);
	assert.equal(sessionCreates(r).length, 0);
	setSettings({ multiplexer: "rex", windowPlacement: "current" });
	const current = (await s.toolCall("delegate", { agent: "scout", task: "look", label: "current" }))
		.structuredContent as { windowSession: string };
	assert.equal(current.windowSession, r.context.session);
	setSettings({ multiplexer: "rex", companionSuffix: "playpen" });
	const companion = (await s.toolCall("delegate", { agent: "scout", task: "look", label: "companion" }))
		.structuredContent as { windowSession: string };
	assert.equal(r.sessions.get(companion.windowSession)?.label, projectBase("playpen"));
});

test("placement is frozen at admission even when the settings file changes before the open", async () => {
	const r = wire();
	setSettings({ multiplexer: "rex", windowPlacement: "companion" });
	const { tmux, multiplexer } = mux(r);
	const s = session({ tmux, multiplexer });
	await s.start();
	const off = s.events.on("session:launch", () => setSettings({ multiplexer: "rex", windowPlacement: "current" }));
	const result = (await s.toolCall("delegate", { agent: "scout", task: "look" })).structuredContent as {
		windowSession: string;
	};
	off();
	assert.notEqual(result.windowSession, r.context.session, "the admitted companion placement was used");
	assert.equal(r.sessions.get(result.windowSession)?.label, projectBase());
});

test("root A -> coordinator in B -> worker in C keeps A's saved companion base and one tab per delegate", async () => {
	const r = wire();
	setSettings({ multiplexer: "rex", maxDepth: 2 });
	writeAgent(
		"coordinator",
		agentFile({
			model: "alpha/fast-model",
			thinking: "low",
			allow_nested_delegation: "[worker]",
			tools: "read",
			auto_exit: "false",
		}),
	);
	writeAgent(
		"worker",
		agentFile({ model: "alpha/fast-model", thinking: "low", tools: "read,write", auto_exit: "false" }),
	);
	const b = join(root, "case-b");
	const c = join(root, "case-c");
	mkdirSync(b, { recursive: true });
	mkdirSync(c, { recursive: true });
	const { tmux, multiplexer } = mux(r);
	const owner = session({ tmux, multiplexer });
	await owner.start();
	const coordinator = (await owner.toolCall("delegate", { agent: "coordinator", task: "coordinate", cwd: b }))
		.structuredContent as { id: string; windowSession: string };
	assert.equal(r.sessions.get(coordinator.windowSession)?.label, projectBase());
	const child = session({ parent: coordinator.id, cwd: b, tmux, multiplexer });
	await child.start();
	const worker = (await child.toolCall("delegate", { agent: "worker", task: "work", cwd: c })).structuredContent as {
		id: string;
		windowSession: string;
	};
	assert.equal(worker.windowSession, coordinator.windowSession, "the worker reuses A's companion");
	assert.equal(sessionCreates(r).length, 1, "the base was created once, not per delegate");
	assert.equal(r.sessions.get(worker.windowSession)?.blocks.size, 2, "one full tab per delegate");
	assert.equal(r.session.blocks.size, 1, "the root session keeps only its own block");
});

test("resume and fork keep the saved root base, apply the current mode, and never move existing windows", async () => {
	const r = wire();
	setSettings({ multiplexer: "rex" });
	const { tmux, multiplexer } = mux(r);
	const s = session({ tmux, multiplexer });
	await s.start();
	const first = (await s.toolCall("delegate", { agent: "scout", task: "first" })).structuredContent as {
		id: string;
		windowSession: string;
	};
	const own = rexLocator(startedRecord(s)?.locator);
	assert.ok(own);
	const companion = r.sessions.get(first.windowSession);
	assert.ok(companion);
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(
		join(sessionDir, `20261026T000000_${first.id}.jsonl`),
		`${JSON.stringify({ type: "session", version: 3, id: first.id, timestamp: "2026-10-26T00:00:00.000Z", cwd: root })}\n`,
	);
	// The delegate's terminal exited; Rex removed its block.
	companion.blocks.delete(own.block);
	// A mode change affects only the next window, never the existing one.
	setSettings({ multiplexer: "rex", windowPlacement: "current" });
	const resumed = (await s.toolCall("delegation_resume", { id: first.id, task: "more" })).structuredContent as {
		windowSession: string;
	};
	assert.equal(resumed.windowSession, r.context.session, "the current mode applies to the new window");
	assert.equal(companion.label, projectBase(), "the saved companion is not renamed or moved");
	setSettings({ multiplexer: "rex" });
	const forked = (await s.toolCall("delegation_fork", { id: first.id, task: "forked" })).structuredContent as {
		windowSession: string;
	};
	assert.equal(r.sessions.get(forked.windowSession)?.label, projectBase(), "the fork returns to the saved base");
});

test("a current-session record restores, reports, peeks and closes without a companion receipt", async () => {
	const r = wire();
	setSettings({ multiplexer: "rex", windowPlacement: "current" });
	const { tmux, multiplexer } = mux(r);
	const s = session({ tmux, multiplexer });
	await s.start();
	const record = (await s.toolCall("delegate", { agent: "scout", task: "one" })).structuredContent as { id: string };
	const own = rexLocator(startedRecord(s)?.locator);
	assert.ok(own);
	assert.equal(own.session, r.context.session);
	setSettings({ multiplexer: "rex" });
	assert.deepEqual(r.receipts(projectBase()), [], "no companion receipt was needed");
	assert.match(await r.client.peek({ windowId: own.window, locator: own }), /SQUIRE-ADAPTER-SCREEN/);
	await s.shutdown();
	const reopened = session({ parent: s.parent, entries: s.entries, tmux, multiplexer });
	await reopened.start();
	assert.match((await reopened.toolCall("delegation_status", { id: record.id })).content[0].text, /state: running/);
	await reopened.toolCall("delegation_close", { id: record.id });
	assert.equal(r.sessions.get(own.session)?.blocks.has(own.block), false);
	assert.equal(r.sessions.has(own.session), true, "the caller session is never destroyed");
});

test("a failed session query leaves only its own delegate unknown; a healthy session still reports running", async () => {
	const r = wire();
	setSettings({ multiplexer: "rex" });
	const { tmux, multiplexer } = mux(r);
	const s = session({ tmux, multiplexer });
	await s.start();
	const inCompanion = (await s.toolCall("delegate", { agent: "scout", task: "one", label: "in-companion" }))
		.structuredContent as { id: string; windowSession: string };
	setSettings({ multiplexer: "rex", windowPlacement: "current" });
	const inCurrent = (await s.toolCall("delegate", { agent: "scout", task: "two", label: "in-current" }))
		.structuredContent as {
		id: string;
		windowSession: string;
	};
	const companion = r.sessions.get(inCompanion.windowSession);
	assert.ok(companion);
	companion.failBlocks = true;
	const mixed = (await s.toolCall("delegation_status", {})).content[0].text;
	assert.match(mixed, /could not be asked whether the window is open/);
	assert.match(mixed, /state: running/);
	// A successful list that omits the exact session positively proves it gone.
	companion.failBlocks = false;
	r.removeSession(companion.id);
	const gone = (await s.toolCall("delegation_status", {})).content[0].text;
	assert.doesNotMatch(gone, /could not be asked whether the window is open/);
	assert.match(gone, /state: closed — the window is gone/);
	assert.match((await s.toolCall("delegation_status", { id: inCurrent.id })).content[0].text, /state: running/);
});

test("a foreign server endpoint is refused for show, peek, close and live-parent verification", async () => {
	const r = wire();
	const record = await r.open("foreign");
	const own = rexLocator(record.locator);
	assert.ok(own);
	const foreign = { ...own, server: "unix:///other.sock" };
	await assert.rejects(
		r.client.show({ windowId: own.window, locator: foreign }, async () => true),
		/no verified open window/,
	);
	await assert.rejects(r.client.peek({ windowId: own.window, locator: foreign }), /no verified open window/);
	await assert.rejects((await askWindowStates(r.client)).close({ locator: foreign }));
	assert.equal(
		await r.client.verifyLivePane?.({
			adapter: "rex",
			version: 1,
			kind: "pane",
			server: "unix:///other.sock",
			session: own.session,
			window: own.window,
			block: own.block,
			name: own.name,
		}),
		undefined,
	);
});

test("two roots share one companion; closing one subtree leaves the other's window and manual blocks", async () => {
	const r = wire();
	setSettings({ multiplexer: "rex" });
	const { tmux, multiplexer } = mux(r);
	const a = session({ tmux, multiplexer });
	const b = session({ tmux, multiplexer });
	await a.start();
	await b.start();
	const first = (await a.toolCall("delegate", { agent: "scout", task: "one" })).structuredContent as {
		id: string;
		windowSession: string;
	};
	const second = (await b.toolCall("delegate", { agent: "scout", task: "two" })).structuredContent as {
		id: string;
		windowSession: string;
	};
	assert.equal(first.windowSession, second.windowSession);
	const companion = r.sessions.get(first.windowSession);
	assert.ok(companion);
	companion.blocks.set("block:manual", { block_id: "block:manual", label: "shell", placement: "manual" });
	await a.toolCall("delegation_close", {});
	assert.equal(companion.blocks.size, 2, "the other root's delegate and the manual block remain");
	assert.equal(r.sessions.has(companion.id), true, "the shared companion is retained");
	assert.match((await b.toolCall("delegation_status", { id: second.id })).content[0].text, /state: running/);
});

test("navigation to a companion selects the caller's app session and window, then focuses the exact block", async () => {
	const r = wire();
	const companion = r.addSession("project-delegates");
	companion.blocks.set("block:delegate", {
		block_id: "block:delegate",
		window_id: "window:delegate",
		label: "shell",
		placement: "placed",
	});
	companion.windows.set("window:delegate", { id: "window:delegate", label: "delegate" });
	const locator = {
		adapter: "rex",
		version: 1,
		kind: "window",
		server: r.context.server,
		session: companion.id,
		window: "window:delegate",
		block: "block:delegate",
		name: "worker",
		launchFile: "/tmp/launch.mjs",
	};
	assert.deepEqual(r.attachedFor(companion.id), [], "the target session has no app attached");
	const result = await r.client.show({ windowId: "window:delegate", locator }, async () => true);
	assert.ok("shown" in result && result.shown);
	assert.equal(r.visibleSession, companion.id, "the app's visible session changed");
	assert.equal(r.visibleWindow, "window:delegate", "the app's visible window changed");
	assert.equal(companion.active, "window:delegate", "the exact block was focused");
	assert.match(result.returnHint, new RegExp(r.context.session), "the return hint names the originating session");
});

test("navigation accepts a same-server parent pane in another session, as a child returning home needs", async () => {
	const r = wire();
	const parent = r.addSession("root-work");
	parent.blocks.set("block:root", {
		block_id: "block:root",
		window_id: "window:root",
		label: "shell",
		placement: "placed",
	});
	parent.windows.set("window:root", { id: "window:root", label: "root" });
	const pane = {
		adapter: "rex",
		version: 1,
		kind: "pane",
		server: r.context.server,
		session: parent.id,
		window: "window:root",
		block: "block:root",
		name: "root",
	};
	assert.equal((await r.client.verifyLivePane?.(pane))?.paneTarget, "block:root");
	const result = await r.client.show(
		{ windowId: "window:root", paneId: "block:root", locator: pane },
		async () => true,
	);
	assert.ok("shown" in result && result.shown);
	assert.equal(r.visibleSession, parent.id);
	assert.equal(r.visibleWindow, "window:root");
	assert.equal(parent.active, "window:root");
});

test("viewer selection ignores lost and non-app clients and still finds the one connected app", async () => {
	const r = wire();
	const record = await r.open("apps");
	const own = rexLocator(record.locator);
	assert.ok(own);
	const target = { windowId: own.window, locator: own };
	for (const clients of [
		[],
		[{ client_id: "client:cli", info: { kind: "cli" } }],
		// `info` is optional in Rex's client schema: a client that said nothing is not an app.
		[{ client_id: "client:bare" }],
		[{ client_id: "client:lost", info: { kind: "app" }, connection_state: "lost" }],
		[
			{ client_id: "client:one", info: { kind: "app" }, connection_state: "connected" },
			{ client_id: "client:two", info: { kind: "app" } },
		],
	]) {
		r.clients = clients;
		const answer = await r.client.show(target, async () => {
			assert.fail("no unambiguous viewer");
		});
		assert.ok("text" in answer);
	}
	assert.equal(r.active, "window:main");
	assert.equal(r.visible, "window:main");
	r.clients = [
		{ client_id: "client:bare" },
		{ client_id: "client:lost", info: { kind: "app" }, connection_state: "lost" },
		{ client_id: "client:app", info: { kind: "app" }, connection_state: "connected" },
	];
	const shown = await r.client.show(target, async () => true);
	assert.ok("shown" in shown && shown.shown);
	assert.equal(r.calls.filter((call) => call.args[0] === "-C").at(-1)?.args[1], "client:app");
});

test("peek reads a delegate in another session without changing selection or focus", async () => {
	const r = wire();
	const companion = r.addSession("project-delegates");
	companion.blocks.set("block:delegate", {
		block_id: "block:delegate",
		window_id: "window:delegate",
		label: "shell",
		placement: "placed",
	});
	companion.windows.set("window:delegate", { id: "window:delegate", label: "delegate" });
	const locator = {
		adapter: "rex",
		version: 1,
		kind: "window",
		server: r.context.server,
		session: companion.id,
		window: "window:delegate",
		block: "block:delegate",
		name: "worker",
		launchFile: "/tmp/launch.mjs",
	};
	assert.match(await r.client.peek({ windowId: "window:delegate", locator }), /SQUIRE-ADAPTER-SCREEN/);
	assert.equal(r.visibleSession, r.context.session);
	assert.equal(r.visibleWindow, "window:main");
	assert.equal(companion.active, undefined);
	assert.equal(r.session.active, "window:main");
});
