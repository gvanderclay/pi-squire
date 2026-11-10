// Ticket 10: Herdr parity (resume, fork, nested), restart/restored-tab guard,
// and multiplexer auto-detection. Every Herdr call goes to the in-memory wire.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { createHerdrClient } from "../src/herdr.ts";
import { herdrLocator } from "../src/herdr-locator.ts";
import { chooseMultiplexer, createMultiplexer, MULTIPLEXER_ENV } from "../src/multiplexer.ts";
import type { StartedRecorded } from "../src/results.ts";
import { NOT_IN_TMUX } from "../src/tmux.ts";
import { readTree } from "../src/tree-registry.ts";
import { askWindowStates } from "../src/window-state.ts";
import { FakeTmux } from "./fake-tmux.ts";
import { agentDir, agentFile, cleanup, resetRoot, session, sessionDir, writeAgent } from "./harness.ts";
import { HerdrWire } from "./herdr-adapter-fixture.ts";

const wires: HerdrWire[] = [];
const sessions: ReturnType<typeof session>[] = [];
const settingsFile = join(agentDir, "squire", "settings.json");
function setSettings(value: unknown): void {
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(settingsFile, JSON.stringify(value));
}
beforeEach(() => {
	resetRoot();
	writeAgent("scout", agentFile({ model: "alpha/fast-model", thinking: "low", auto_exit: "false" }));
	writeAgent(
		"coordinator",
		agentFile({ model: "alpha/fast-model", allow_nested_delegation: "[scout]", tools: "read", auto_exit: "false" }),
	);
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
/** A Pi hosted in the wire's pane (no tmux unless `inTmux`), with an optional launcher-recorded backend. */
function instance(
	h: HerdrWire,
	options: { pane?: string; parent?: string; inTmux?: boolean; inherited?: string; tmux?: FakeTmux } = {},
) {
	const tmux = options.tmux ?? Object.assign(new FakeTmux(), { inside: options.inTmux ?? false });
	const pane = options.pane ?? h.context.pane;
	const client = createHerdrClient({
		run: h.run.bind(h),
		context: () => (h.unavailable ? undefined : { ...h.context, pane }),
	});
	const s = session({
		tmux,
		parent: options.parent,
		multiplexer: createMultiplexer(
			tmux,
			client,
			() => agentDir,
			() => options.inherited,
		),
		...(options.parent
			? { activeTools: ["read", "delegate", "delegation_status", "delegation_close", "delegation_resume"] }
			: {}),
	});
	sessions.push(s);
	return { s, tmux };
}
async function delegated(h: HerdrWire, s: ReturnType<typeof session>, agent = "scout") {
	const output = await s.toolCall("delegate", { agent, task: "first" });
	const id = (output.details as { id: string }).id;
	const record = s.entries.findLast((entry) => (entry.data as { id?: string }).id === id)?.data as StartedRecorded;
	const locator = herdrLocator(record.locator);
	assert.ok(locator);
	h.staged.push(dirname(locator.launchFile));
	return { id, record, locator, output };
}
function sessionFile(id: string, cwd: string): string {
	mkdirSync(sessionDir, { recursive: true });
	const file = join(sessionDir, `20261110T000000_${id}.jsonl`);
	writeFileSync(
		file,
		`${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-11-10T00:00:00.000Z", cwd })}\n`,
	);
	return file;
}
const creates = (h: HerdrWire) => h.calls.filter((call) => call.args[0] === "tab" && call.args[1] === "create");
const closes = (h: HerdrWire) => h.calls.filter((call) => call.args[1] === "close");

// --- selection -------------------------------------------------------------

test("auto-detect: tmux only, Herdr only, both refuses naming the setting, neither names both", () => {
	const base = { agentDir, inherited: undefined };
	assert.equal(chooseMultiplexer({ ...base, inTmux: true, inHerdr: false }), "tmux");
	assert.equal(chooseMultiplexer({ ...base, inTmux: false, inHerdr: true }), "herdr");
	assert.throws(
		() => chooseMultiplexer({ ...base, inTmux: true, inHerdr: true }),
		(error: Error) =>
			/inside both tmux and Herdr/.test(error.message) &&
			error.message.includes('"multiplexer": "tmux" or "herdr"') &&
			error.message.includes(settingsFile),
	);
	assert.throws(
		() => chooseMultiplexer({ ...base, inTmux: false, inHerdr: false }),
		/inside neither tmux nor Herdr; start Pi in a tmux pane or a Herdr pane/,
	);
});

test("the setting overrides detection in every presence combination, and a launcher's backend overrides only detection", () => {
	for (const inTmux of [true, false])
		for (const inHerdr of [true, false]) {
			for (const forced of ["tmux", "herdr"] as const) {
				setSettings({ multiplexer: forced });
				assert.equal(chooseMultiplexer({ agentDir, inherited: undefined, inTmux, inHerdr }), forced);
				assert.equal(
					chooseMultiplexer({ agentDir, inherited: forced === "tmux" ? "herdr" : "tmux", inTmux, inHerdr }),
					forced,
					"explicit setting beats the launcher-recorded backend",
				);
			}
			setSettings({});
			for (const inherited of ["tmux", "herdr"] as const)
				assert.equal(chooseMultiplexer({ agentDir, inherited, inTmux, inHerdr }), inherited);
		}
	setSettings({});
	assert.throws(
		() => chooseMultiplexer({ agentDir, inherited: "screen", inTmux: true, inHerdr: false }),
		new RegExp(`invalid ${MULTIPLEXER_ENV}`),
	);
});

test("createMultiplexer routes launches by detection and a forced unusable backend refuses without fallback", async () => {
	const h = wire();
	const tmux = new FakeTmux();
	const mux = createMultiplexer(
		tmux,
		h.client,
		() => agentDir,
		() => undefined,
	);
	h.unavailable = true;
	assert.equal(mux.forLaunch?.(), tmux, "tmux only");
	tmux.inside = false;
	h.unavailable = false;
	assert.equal(mux.forLaunch?.(), h.client, "Herdr only");
	h.unavailable = true;
	assert.match(mux.unavailable() ?? "", /neither tmux nor Herdr/);
	assert.match((await mux.unavailable(true)) ?? "", /neither tmux nor Herdr/);
	tmux.inside = true;
	h.unavailable = false;
	assert.match(mux.unavailable() ?? "", /both tmux and Herdr/);
	// Forced tmux while only Herdr is present: the old tmux wording, no Herdr call.
	tmux.inside = false;
	setSettings({ multiplexer: "tmux" });
	const before = h.calls.length;
	assert.equal(await mux.unavailable(true), NOT_IN_TMUX);
	assert.equal(h.calls.length, before);
});

test("both-env root refuses before any side effect; a delegate inherits its launcher's backend", async () => {
	const h = wire();
	const { s, tmux } = instance(h, { inTmux: true });
	await s.start();
	await assert.rejects(s.toolCall("delegate", { agent: "scout", task: "x" }), /both tmux and Herdr.*settings\.json/);
	assert.equal(s.sendCalls.length, 0);
	assert.equal(tmux.opened.length, 0);
	assert.equal(creates(h).length, 0);
	assert.deepEqual(readTree(s.parent).entries, []);
	const child = instance(h, { inTmux: true, inherited: "herdr" });
	await child.s.start();
	await child.s.toolCall("delegate", { agent: "scout", task: "x" });
	assert.equal(creates(h).length, 1, "the launcher-recorded backend resolves the both-env case");
	assert.equal(child.tmux.opened.length, 0);
});

test("child environment records the launch backend; routing variables never pass through", async () => {
	const h = wire();
	const { s } = instance(h);
	await s.start();
	await delegated(h, s);
	const env = creates(h)[0].args.filter((_arg, i, all) => all[i - 1] === "--env");
	assert.ok(env.includes(`${MULTIPLEXER_ENV}=herdr`));
	assert.ok(!env.some((pair) => /^(TMUX|HERDR)/.test(pair)));
	const tmux = new FakeTmux();
	const t = session({
		tmux,
		multiplexer: createMultiplexer(
			tmux,
			wire().client,
			() => agentDir,
			() => undefined,
		),
	});
	sessions.push(t);
	wires.at(-1)!.unavailable = true;
	await t.start();
	await t.toolCall("delegate", { agent: "scout", task: "x" });
	assert.equal(tmux.opened[0].env[MULTIPLEXER_ENV], "tmux");
});

test("own-pane telemetry follows the actual host, not the launch setting; both is ambiguous", async () => {
	const h = wire();
	const tmux = new FakeTmux();
	let inherited: string | undefined;
	const mux = createMultiplexer(
		tmux,
		h.client,
		() => agentDir,
		() => inherited,
	);
	setSettings({ multiplexer: "herdr" });
	h.unavailable = true;
	const tmuxPane = await mux.observeLivePane?.();
	assert.ok(
		tmuxPane === undefined || !("adapter" in tmuxPane && (tmuxPane as { adapter?: string }).adapter === "herdr"),
	);
	assert.equal(h.calls.length, 0, "a tmux-hosted Pi with a Herdr setting never asks Herdr for its own pane");
	setSettings({ multiplexer: "tmux" });
	h.unavailable = false;
	tmux.inside = false;
	assert.equal(
		(await mux.observeLivePane?.()) && "herdr",
		"herdr",
		"a Herdr-hosted Pi with a tmux setting observes Herdr",
	);
	tmux.inside = true;
	const asked = h.calls.length;
	assert.equal(await mux.observeLivePane?.(), undefined, "both present with no launcher evidence is ambiguous");
	assert.equal(h.calls.length, asked);
	inherited = "herdr";
	assert.ok(await mux.observeLivePane?.(), "the launcher-recorded backend is reliable host evidence");
});

// --- parity ----------------------------------------------------------------

test("nested delegates open as flat unfocused tabs in the root's workspace", async () => {
	setSettings({ maxDepth: 2 });
	const h = wire();
	const root = instance(h);
	await root.s.start();
	const c = await delegated(h, root.s, "coordinator");
	const child = instance(h, { pane: c.locator.pane, parent: c.id, inherited: "herdr" });
	await child.s.start();
	const nested = await delegated(h, child.s, "scout");
	assert.equal(creates(h).length, 2);
	for (const call of creates(h)) {
		assert.equal(call.args[call.args.indexOf("--workspace") + 1], "w1");
		assert.ok(call.args.includes("--no-focus"));
	}
	assert.equal(nested.locator.workspace, "w1");
	assert.notEqual(nested.locator.tab, c.locator.tab, "a nested delegate gets its own tab, not a split");
	assert.match(nested.output.content[0].text, /in tab scout.* in workspace w1/);
});

test("a moved parent pane refuses launch, naming both workspaces, before any tab or mail", async () => {
	const h = wire();
	const { s } = instance(h);
	await s.start();
	const parent = h.panes.get(h.context.pane);
	assert.ok(parent);
	parent.workspace_id = "w2";
	await assert.rejects(
		s.toolCall("delegate", { agent: "scout", task: "x" }),
		/moved from workspace w1 to w2.*launch refused/,
	);
	assert.equal(creates(h).length, 0);
	assert.equal(s.sendCalls.length, 0);
});

test("a moved delegate terminal is unknown, never gone, and is not closed", async () => {
	const h = wire();
	const { s } = instance(h);
	await s.start();
	const { record, locator } = await delegated(h, s);
	const live = h.panes.get(locator.pane);
	assert.ok(live);
	h.panes.delete(locator.pane);
	h.panes.set("w2:p9", { ...live, pane_id: "w2:p9", tab_id: "w2:t9", workspace_id: "w2" });
	const states = await askWindowStates(h.client);
	assert.equal(states.state(record), "unknown");
	await assert.rejects(states.close(record), /moved/);
	assert.equal(closes(h).length, 0);
});

test("Herdr fork opens a new tab from the copied session", async () => {
	const h = wire();
	const { s } = instance(h);
	await s.start();
	const { id } = await delegated(h, s);
	sessionFile(id, s.context.cwd);
	const forked = await s.toolCall("delegation_fork", { id, task: "branch" });
	assert.match(forked.content[0].text, /^Forked delegation .* in tab scout-\S+ \(w1:t3\) in workspace w1 in /);
	assert.equal(creates(h).length, 2);
	assert.equal((forked.structuredContent as { location?: string }).location, undefined);
	const forkStart = s.entries.findLast((entry) => (entry.data as { forkedFrom?: string }).forkedFrom === id)!;
	const forkLocator = herdrLocator((forkStart.data as StartedRecorded).locator)!;
	assert.equal(forkLocator.tab, "w1:t3");
	h.staged.push(dirname(forkLocator.launchFile));
});

test("Herdr resume closes only its own exited pane, opens a new tab, then mails the task", async () => {
	const h = wire();
	const { s, tmux } = instance(h);
	await s.start();
	const { id, locator } = await delegated(h, s);
	sessionFile(id, s.context.cwd);
	writeFileSync(`${locator.launchFile}.status`, JSON.stringify({ pid: 99, exit: 1 }));
	const sent = s.sendCalls.length;
	const resumed = await s.toolCall("delegation_resume", { id, task: "again" });
	assert.match(resumed.content[0].text, /in tab scout-\S+ \(w1:t3\) in workspace w1\. It runs/);
	assert.equal(h.panes.has(locator.pane), false, "the owned, exited, retained pane was closed");
	assert.equal(creates(h).length, 2);
	assert.equal(s.sendCalls.length, sent + 1);
	assert.equal(tmux.opened.length, 0);
	const next = s.entries.findLast((entry) => (entry.data as { resumedFrom?: string }).resumedFrom === id)
		?.data as StartedRecorded;
	const own = herdrLocator(next.locator);
	assert.ok(own, "the resumed record keeps the adapter's terminal-fenced locator");
	h.staged.push(dirname(own.launchFile));
	assert.equal(own.tab, "w1:t3");
	assert.equal(own.terminal, "term_3");
	const picked = s.selects.length;
	await s.command("delegate-resume", "");
	assert.equal(s.selects.length, picked, "the picker offers nothing while the resumed tab runs");
});

test("after a Herdr restart the old delegation is gone and resume refuses, naming the restored tab, before side effects", async () => {
	const h = wire();
	const { s, tmux } = instance(h);
	await s.start();
	const { id, record, locator } = await delegated(h, s);
	const file = sessionFile(id, s.context.cwd);
	// Restart: same pane/tab ids, new terminal, Herdr relaunched `pi --session <file>` there.
	h.panes.set(locator.pane, {
		pane_id: locator.pane,
		tab_id: locator.tab,
		workspace_id: "w1",
		terminal_id: "term_restored",
		agent: "pi",
		agent_session: { source: "herdr:pi", value: file },
	});
	assert.equal((await askWindowStates(h.client)).state(record), "gone");
	const status = await s.toolCall("delegation_status", { id });
	assert.doesNotMatch(status.content[0].text, /state: running/);
	const tree = readTree(s.parent);
	const sent = s.sendCalls.length;
	const calls = h.calls.length;
	await assert.rejects(
		s.toolCall("delegation_resume", { id, task: "again" }),
		new RegExp(`Herdr tab scout-\\S+ \\(${locator.tab}\\) already runs delegation session .*restored`),
	);
	assert.deepEqual(readTree(s.parent), tree, "no reservation was published");
	assert.equal(s.sendCalls.length, sent);
	assert.equal(tmux.opened.length, 0);
	assert.equal(creates(h).length, 1);
	assert.equal(closes(h).length, 0, "the restored tab is neither adopted nor closed");
	assert.ok(
		h.calls.slice(calls).every((call) => ["status", "api"].includes(call.args[0]) || call.args[1] === "get"),
		"only read-only Herdr calls were made",
	);
	const picked = s.selects.length;
	await s.command("delegate-resume", "");
	assert.equal(s.selects.length, picked, "the picker excludes a session another tab already runs");
	const close = await s.toolCall("delegation_close", { id });
	assert.doesNotMatch(close.content[0].text, /Closed delegation subtree.*1 closed/);
	assert.equal(h.panes.get(locator.pane)?.terminal_id, "term_restored", "close leaves the restored tab alone");
});

test("restored panes that do not report a session refuse unless Herdr proves only a shell runs there", async () => {
	const h = wire();
	const { s } = instance(h);
	await s.start();
	const { id, locator } = await delegated(h, s);
	sessionFile(id, s.context.cwd);
	const restored = { pane_id: locator.pane, tab_id: locator.tab, workspace_id: "w1", terminal_id: "term_restored" };
	h.panes.set(locator.pane, { ...restored, agent: "pi", agent_session: null });
	await assert.rejects(
		s.toolCall("delegation_resume", { id, task: "x" }),
		/restored after a restart and may still run/,
	);
	h.panes.set(locator.pane, { ...restored, agent: null });
	h.foreground = [{ pid: 10 }, { pid: 77, argv: ["pi", "--session"] }];
	await assert.rejects(
		s.toolCall("delegation_resume", { id, task: "x" }),
		/restored after a restart and may still run/,
	);
	h.beforeProcessInfo = () => {
		throw new Error("process-info timed out");
	};
	await assert.rejects(
		s.toolCall("delegation_resume", { id, task: "x" }),
		/restored after a restart and may still run/,
	);
	h.beforeProcessInfo = undefined;
	assert.equal(creates(h).length, 1);
	assert.equal(closes(h).length, 0);
	h.foreground = [{ pid: 10 }];
	const resumed = await s.toolCall("delegation_resume", { id, task: "x" });
	assert.match(resumed.content[0].text, /in tab/);
	assert.equal(h.panes.get(locator.pane)?.terminal_id, "term_restored", "the restored shell tab is left alone");
	assert.equal(closes(h).length, 0);
	const next = s.entries.findLast((entry) => (entry.data as { resumedFrom?: string }).resumedFrom === id)
		?.data as StartedRecorded;
	h.staged.push(dirname(herdrLocator(next.locator)!.launchFile));
});

test("unknown Herdr evidence refuses resume before reservation, close or mail", async () => {
	const h = wire();
	const { s } = instance(h);
	await s.start();
	const { id, locator } = await delegated(h, s);
	sessionFile(id, s.context.cwd);
	writeFileSync(`${locator.launchFile}.status`, JSON.stringify({ pid: 99, exit: 1 }));
	const tree = readTree(s.parent);
	const sent = s.sendCalls.length;
	h.snapshotFails = true;
	await assert.rejects(
		s.toolCall("delegation_resume", { id, task: "x" }),
		/could not ask Herdr whether a tab already runs .*so two Pis cannot write one session/,
	);
	h.snapshotFails = false;
	// Another tab (not the record's) already writing the same session file.
	h.panes.set("w1:p50", {
		pane_id: "w1:p50",
		tab_id: "w1:t50",
		workspace_id: "w1",
		terminal_id: "term_user",
		agent: "pi",
		agent_session: { source: "herdr:pi", value: id },
	});
	h.tabs.set("w1:t50", "user-pi");
	await assert.rejects(s.toolCall("delegation_resume", { id, task: "x" }), /Herdr tab user-pi \(w1:t50\) already runs/);
	assert.deepEqual(readTree(s.parent), tree);
	assert.equal(s.sendCalls.length, sent);
	assert.equal(closes(h).length, 0);
	assert.equal(h.panes.has(locator.pane), true);
});

test("a Herdr record resumed after switching to tmux still needs Herdr evidence, then opens in tmux", async () => {
	const h = wire();
	const tmux = new FakeTmux();
	setSettings({ multiplexer: "herdr" });
	const { s } = instance(h, { tmux });
	await s.start();
	const { id, locator } = await delegated(h, s);
	sessionFile(id, s.context.cwd);
	writeFileSync(`${locator.launchFile}.status`, JSON.stringify({ pid: 99, exit: 0 }));
	setSettings({ multiplexer: "tmux" });
	h.snapshotFails = true;
	await assert.rejects(s.toolCall("delegation_resume", { id, task: "x" }), /could not ask Herdr/);
	assert.equal(tmux.opened.length, 0);
	h.snapshotFails = false;
	const resumed = await s.toolCall("delegation_resume", { id, task: "x" });
	assert.match(resumed.content[0].text, /in window scout-/);
	assert.equal(tmux.opened.length, 1);
	assert.equal(tmux.opened[0].env[MULTIPLEXER_ENV], "tmux");
	assert.equal(h.panes.has(locator.pane), false, "its own exited Herdr pane was closed through the Herdr adapter");
});

test("tmux-only resumes need no Herdr evidence even when Herdr is present but unanswering", async () => {
	const h = wire();
	const tmux = new FakeTmux();
	setSettings({ multiplexer: "tmux" });
	const { s } = instance(h, { tmux });
	await s.start();
	const output = await s.toolCall("delegate", { agent: "scout", task: "x" });
	const id = (output.details as { id: string }).id;
	sessionFile(id, s.context.cwd);
	tmux.exit(tmux.opened[0].windowId);
	h.snapshotFails = true;
	const resumed = await s.toolCall("delegation_resume", { id, task: "again" });
	assert.match(resumed.content[0].text, /in window scout-/);
	assert.equal(tmux.opened.length, 2);
	assert.equal(creates(h).length, 0);
});
