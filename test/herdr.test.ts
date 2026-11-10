import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { childEnvironment } from "../src/herdr.ts";
import { herdrLocator } from "../src/herdr-locator.ts";
import { createMultiplexer, multiplexerSetting } from "../src/multiplexer.ts";
import { readTree } from "../src/tree-registry.ts";
import { askPaneStates, askToClose, askWindowStates } from "../src/window-state.ts";
import { FakeTmux } from "./fake-tmux.ts";
import { agentDir, agentFile, cleanup, resetRoot, session, sessionDir, writeAgent } from "./harness.ts";
import { HerdrWire } from "./herdr-adapter-fixture.ts";

const wires: HerdrWire[] = [];
beforeEach(() => {
	resetRoot();
	writeAgent("scout", agentFile({ model: "alpha/fast-model", thinking: "low" }));
});
after(() => {
	for (const wire of wires) wire.dispose();
	cleanup();
});
function wire(): HerdrWire {
	const value = new HerdrWire();
	wires.push(value);
	return value;
}
const settings = join(agentDir, "squire", "settings.json");
function setSettings(value: unknown): void {
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(settings, JSON.stringify(value));
}

test("multiplexer is opt-in, read on each launch, and invalid settings name the file", async () => {
	const h = wire();
	const tmux = new FakeTmux();
	const mux = createMultiplexer(tmux, h.client, () => agentDir);
	assert.equal(multiplexerSetting(agentDir), "tmux");
	assert.equal(mux.forLaunch?.(), tmux);
	setSettings({ multiplexer: "herdr" });
	assert.equal(mux.forLaunch?.(), h.client);
	setSettings({ multiplexer: "tmux" });
	assert.equal(mux.forLaunch?.(), tmux);
	for (const value of ["auto", "", false, 3, null]) {
		setSettings({ multiplexer: value });
		assert.throws(
			() => mux.forLaunch?.(),
			(error: Error) => error.message.includes(settings),
		);
	}
});

test("chosen unusable Herdr refuses before task mail and never falls back to tmux", async () => {
	const h = wire();
	const tmux = new FakeTmux();
	setSettings({ multiplexer: "herdr" });
	const s = session({ tmux, multiplexer: createMultiplexer(tmux, h.client, () => agentDir) });
	await s.start();
	for (const mode of ["environment", "server", "protocol"]) {
		h.unavailable = mode === "environment";
		h.failedAsk = mode === "server";
		h.protocol = mode === "protocol" ? 21 : 22;
		await assert.rejects(s.toolCall("delegate", { agent: "scout", task: "look" }), /Herdr/);
	}
	assert.equal(s.sendCalls.length, 0);
	assert.equal(tmux.opened.length, 0);
});

test("Herdr delegate uses named unfocused tab, keeps mail authority, status and safe explicit close", async () => {
	const h = wire();
	const tmux = new FakeTmux();
	setSettings({ multiplexer: "herdr", windowPlacement: "invalid-tmux-only", companionSuffix: "invalid-tmux-only-99" });
	const s = session({ tmux, multiplexer: createMultiplexer(tmux, h.client, () => agentDir) });
	await s.start();
	const output = await s.toolCall("delegate", { agent: "scout", task: "look", label: "native", autoExit: false });
	assert.match(output.content[0].text, /in tab scout-native \(w1:t2\) in workspace w1/);
	assert.equal(s.sendCalls.length, 1);
	assert.equal(tmux.opened.length, 0);
	const start = s.entries.find((entry) => entry.customType === "delegate-start-v2")?.data as {
		id: string;
		locator: object;
	};
	const own = herdrLocator(start.locator);
	assert.ok(own);
	h.staged.push(dirname(own.launchFile));
	const create = h.calls.find((call) => call.args[1] === "create");
	assert.ok(create);
	assert.ok(create.args.includes("--no-focus"));
	assert.equal(create.args[create.args.indexOf("--workspace") + 1], "w1");
	assert.ok(h.calls.every((call) => call.session === "test-isolated"));
	assert.equal(
		readTree(s.parent).entries[0].locator && herdrLocator(readTree(s.parent).entries[0].locator)?.terminal,
		own.terminal,
	);
	const status = await s.toolCall("delegation_status", { id: start.id });
	assert.match(status.content[0].text, /state: running/);
	assert.match(status.content[0].text, /tab: scout-native \(w1:t2\) in workspace w1/);
	assert.match(status.content[0].text, /a clean exit closes its Herdr pane \(errors retain it\)/);
	writeFileSync(`${own.launchFile}.status`, JSON.stringify({ pid: 99, exit: 1 }));
	const exited = await s.toolCall("delegation_status", { id: start.id });
	assert.doesNotMatch(exited.content[0].text, /state: running/);
	assert.equal(h.panes.has(own.pane), true, "an error pane remains available for inspection and explicit close");
	const close = await s.toolCall("delegation_close", { id: start.id });
	assert.match(close.content[0].text, /Closed delegation subtree/);
	assert.equal(h.panes.has(own.pane), false);
	assert.equal(h.panes.has(h.context.pane), true);
	assert.equal(h.calls.filter((call) => call.args[0] === "tab" && call.args[1] === "close").length, 0);
});

test("launch backend is frozen before mail even if a hook changes settings", async () => {
	const h = wire();
	const tmux = new FakeTmux();
	setSettings({ multiplexer: "herdr" });
	const s = session({
		tmux,
		multiplexer: createMultiplexer(tmux, h.client, () => agentDir),
		beforeSquire: (pi) => {
			pi.events.on("session:launch", () => setSettings({ multiplexer: "tmux" }));
		},
	});
	await s.start();
	await s.toolCall("delegate", { agent: "scout", task: "look" });
	assert.equal(tmux.opened.length, 0);
	assert.ok(h.calls.some((call) => call.args[1] === "create"));
});

test("ambiguous create remains charged and never types, adopts or closes the possible tab", async () => {
	const h = wire();
	const tmux = new FakeTmux();
	setSettings({ multiplexer: "herdr" });
	h.ambiguous = true;
	const s = session({ tmux, multiplexer: createMultiplexer(tmux, h.client, () => agentDir) });
	await s.start();
	await assert.rejects(s.toolCall("delegate", { agent: "scout", task: "look" }), /unknown|reply lost/);
	const entry = readTree(s.parent).entries[0];
	assert.equal(entry.createPending, true);
	assert.equal(entry.locator, undefined);
	await s.toolCall("delegation_close", { id: entry.id });
	assert.equal(
		h.calls.some((call) => call.args[1] === "run" || call.args[1] === "close"),
		false,
	);
	assert.ok(h.ambiguousPane && h.panes.has(h.ambiguousPane));
});

test("staged launch safely handles long argv/env and preserves only the child's own routing context", async () => {
	const h = wire();
	const payload = `spaces ' quotes "\\ $HOME ;\n${"long".repeat(10_000)}`;
	const record = await h.open("quoted", {
		argv: [process.execPath, "-p", "JSON.stringify({args:process.argv.slice(1),env:process.env})", payload],
		env: { SQUIRE_LONG: payload, HERDR_PANE_ID: "evil", TMUX: "evil" },
	});
	const own = herdrLocator(record.locator);
	assert.ok(own);
	assert.equal(statSync(own.launchFile).mode & 0o777, 0o600);
	const command = h.calls.find((call) => call.args[1] === "run")?.args[3];
	assert.ok(command && command.length < 1024);
	assert.ok(!command.includes("long"));
	const stdout = execFileSync("sh", ["-c", command], {
		encoding: "utf8",
		env: {
			...process.env,
			HERDR_PANE_ID: "child-pane",
			HERDR_TAB_ID: "child-tab",
			TMUX: "server-leak",
			TMUX_PANE: "%999",
		},
	});
	const result = JSON.parse(stdout);
	assert.deepEqual(result.args, [payload]);
	assert.equal(result.env.SQUIRE_LONG, payload);
	assert.equal(result.env.HERDR_PANE_ID, "child-pane");
	assert.equal(result.env.HERDR_TAB_ID, "child-tab");
	assert.equal(result.env.TMUX, undefined);
	assert.equal(result.env.TMUX_PANE, undefined);
	assert.equal(
		(await askWindowStates(h.client)).state(record),
		"gone",
		"runner exit is factual, not an agent-status guess",
	);
	assert.deepEqual(childEnvironment({ HERDR_SESSION: "parent", TMUX_PANE: "parent", OK: "yes" }), { OK: "yes" });
});

test("runner exits only its launching shell on success and keeps failures readable with factual stopped state", async () => {
	for (const scenario of [
		{ argv: [process.execPath, "-e", "console.log('CLEAN-EXIT')"], code: 0, message: /CLEAN-EXIT/ },
		{ argv: [process.execPath, "-e", "console.error('PI-ERROR');process.exit(23)"], code: 23, message: /PI-ERROR/ },
		{ argv: ["/pi-squire-test/missing-executable"], code: 1, message: /failed to start delegate:.*ENOENT/ },
		{
			argv: [process.execPath, "-e", "process.kill(process.pid,'SIGKILL')"],
			code: 1,
			message: /terminated by SIGKILL/,
		},
	]) {
		const h = wire();
		const record = await h.open("exit", { argv: scenario.argv });
		const own = herdrLocator(record.locator);
		assert.ok(own);
		const command = h.calls.find((call) => call.args[1] === "run")?.args[3];
		assert.ok(command);
		// The trailing command models returning to the interactive shell. On a
		// clean exit it must never run; errors must leave that shell available.
		const run = spawnSync("sh", ["-c", `${command}; printf SHELL-RETAINED`], { encoding: "utf8" });
		assert.equal(run.status, 0);
		assert.match(run.stdout + run.stderr, scenario.message);
		assert.equal(run.stdout.includes("SHELL-RETAINED"), scenario.code !== 0);
		if (scenario.code !== 0) assert.match(run.stderr, new RegExp(`delegate exited with status ${scenario.code}`));
		assert.equal(JSON.parse(readFileSync(`${own.launchFile}.status`, "utf8")).exit, scenario.code);
		const states = await askWindowStates(h.client);
		assert.equal(states.state(record), "gone", "runner exit, not sidebar metadata, decides liveness");
		assert.equal(states.listed?.(record), true, "a retained pane can still be explicitly closed");
		assert.equal(await states.close(record), true);
	}
});

test("sidebar display metadata labels delegates without agent lifecycle authority", async () => {
	const h = wire();
	const record = await h.open("scout-sidebar");
	const own = herdrLocator(record.locator);
	assert.ok(own);
	const metadata = h.calls.find((call) => call.args[1] === "report-metadata");
	assert.deepEqual(metadata?.args, [
		"pane",
		"report-metadata",
		own.pane,
		"--source",
		"pi-squire",
		"--display-agent",
		"scout-sidebar",
	]);
	assert.equal(
		h.calls.some((call) => ["report-agent", "release-agent"].includes(call.args[1])),
		false,
	);
	assert.equal((await askWindowStates(h.client)).state(record), "running");
	h.metadataFails = true;
	const unlabelled = await h.open("still-launch");
	assert.equal(
		(await askWindowStates(h.client)).state(unlabelled),
		"running",
		"metadata failure is not launch failure",
	);
	assert.equal(h.calls.filter((call) => call.args[1] === "run").length, 2);
});

test("terminal replacement during metadata reporting prevents launch into the replacement", async () => {
	const h = wire();
	h.beforeMetadata = () => {
		h.panes.get("w1:p2")!.terminal_id = "replacement";
	};
	await assert.rejects(h.open("metadata-race"), /terminal changed before launch/);
	assert.equal(
		h.calls.some((call) => call.args[1] === "run" || call.args[1] === "close"),
		false,
	);
	const metadataPane = h.panes.get("w1:p2");
	assert.equal(metadataPane?.terminal_id, "replacement");
});

test("close rechecks terminal after observation, leaves restored identity and user-added panes alone", async () => {
	const h = wire();
	const record = await h.open("owned");
	const own = herdrLocator(record.locator);
	assert.ok(own);
	const observed = await askWindowStates(h.client);
	h.panes.set("w1:user", { pane_id: "w1:user", tab_id: own.tab, workspace_id: own.workspace, terminal_id: "user" });
	h.panes.get(own.pane)!.terminal_id = "restored-terminal";
	assert.equal(await observed.close(record), false);
	assert.equal(h.panes.has("w1:user"), true);
	assert.equal((await askWindowStates(h.client)).state(record), "gone");
	h.panes.get(own.pane)!.terminal_id = own.terminal;
	assert.equal(await (await askWindowStates(h.client)).close(record), true);
	assert.equal(h.panes.has("w1:user"), true);
});

test("unknown probes and replaced foreground processes are never permission to close", async () => {
	const h = wire();
	const record = await h.open("owned");
	h.failedAsk = true;
	assert.equal((await askWindowStates(h.client)).state(record), "unknown");
	await assert.rejects((await askWindowStates(h.client)).close(record));
	h.failedAsk = false;
	h.foreground = [{ pid: 99 }];
	await assert.rejects((await askWindowStates(h.client)).close(record), /another foreground/);
	assert.equal(h.panes.size, 2);
	h.foreground = [];
	await assert.rejects((await askWindowStates(h.client)).close(record), /identity unavailable/);
});

test("the final identity check fences restoration during the foreground probe", async () => {
	const h = wire();
	const record = await h.open("race");
	const own = herdrLocator(record.locator);
	assert.ok(own);
	h.beforeProcessInfo = () => {
		const p = h.panes.get(own.pane);
		assert.ok(p);
		p.terminal_id = "replacement";
	};
	assert.equal(await (await askWindowStates(h.client)).close(record), false);
	assert.equal(h.panes.has(own.pane), true);
});

test("foreground PID reuse alone cannot authorize closing a user's new process", async () => {
	const h = wire();
	const record = await h.open("pid");
	const own = herdrLocator(record.locator);
	assert.ok(own);
	writeFileSync(`${own.launchFile}.status`, JSON.stringify({ pid: 99, child: 100 }));
	h.foreground = [{ pid: 99, argv: ["node", "user-command.mjs"] }, { pid: 100 }];
	await assert.rejects((await askWindowStates(h.client)).close(record), /another foreground/);
	h.foreground = [{ pid: 99, argv: [process.execPath, own.launchFile] }];
	assert.equal(await (await askWindowStates(h.client)).close(record), true);
});

test("Herdr resume is refused before closing a retained tab", async () => {
	const h = wire();
	const tmux = new FakeTmux();
	setSettings({ multiplexer: "herdr" });
	const s = session({ tmux, multiplexer: createMultiplexer(tmux, h.client, () => agentDir) });
	await s.start();
	const result = await s.toolCall("delegate", { agent: "scout", task: "look" });
	const id = (result.details as { id: string }).id;
	await assert.rejects(
		s.toolCall("delegation_resume", { id, task: "again" }),
		/Herdr delegation resume is not available/,
	);
	assert.equal(
		h.calls.some((call) => call.args[1] === "close"),
		false,
	);
});

test("historical Herdr resume refuses before reservation or close after switching to tmux", async () => {
	const h = wire();
	const tmux = new FakeTmux();
	setSettings({ multiplexer: "herdr" });
	const s = session({ tmux, multiplexer: createMultiplexer(tmux, h.client, () => agentDir) });
	await s.start();
	const result = await s.toolCall("delegate", { agent: "scout", task: "look" });
	const id = (result.details as { id: string }).id;
	const entry = readTree(s.parent).entries.find((candidate) => candidate.id === id);
	assert.ok(entry);
	const own = herdrLocator(entry.locator);
	assert.ok(own);
	h.staged.push(dirname(own.launchFile));
	writeFileSync(`${own.launchFile}.status`, JSON.stringify({ pid: 99, exit: 0 }));
	assert.equal((await askWindowStates(h.client)).state(entry), "gone");
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(
		join(sessionDir, `20261026T000000_${id}.jsonl`),
		`${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-26T00:00:00.000Z", cwd: s.context.cwd })}\n`,
	);
	setSettings({ multiplexer: "tmux" });
	const before = readTree(s.parent);
	const sent = s.sendCalls.length;
	await assert.rejects(
		s.toolCall("delegation_resume", { id, task: "again" }),
		/Herdr delegation resume is not available/,
	);
	const selections = s.selects.length;
	await s.command("delegate-resume", "");
	assert.equal(s.selects.length, selections, "the picker still excludes an otherwise resumable Herdr record");
	assert.equal(h.calls.filter((call) => call.args[1] === "close").length, 0);
	assert.equal(h.panes.has(own.pane), true, "the exited delegate's retained pane stays untouched");
	assert.deepEqual(readTree(s.parent), before, "no resume reservation or reconciliation was published");
	assert.equal(s.sendCalls.length, sent);
	assert.equal(tmux.opened.length, 0);
});

test("mixed histories route by durable locator even after setting changes and backend failure", async () => {
	const h = wire();
	const tmux = new FakeTmux();
	const mux = createMultiplexer(tmux, h.client, () => agentDir);
	const t = await tmux.openWindow({ name: "tmux", cwd: process.cwd(), argv: [], env: {} }, "current", "unused");
	const tr = { windowId: t.id, windowName: "tmux" };
	const hr = await h.open("herdr");
	h.failedAsk = true;
	const states = await askWindowStates(mux);
	assert.equal(states.state(tr), "running");
	assert.equal(states.state(hr), "unknown");
	h.failedAsk = false;
	tmux.failList = "tmux gone";
	const refused = await askToClose(mux);
	await assert.rejects(refused.close(tr), /tmux gone/);
	const other = await askWindowStates(mux);
	assert.equal(other.state(tr), "unknown");
	assert.equal(other.state(hr), "running");
	tmux.failList = undefined;
	assert.equal(
		(await askPaneStates(mux)).state(hr),
		"running",
		"widget observations route Herdr identity through its own adapter, not a tmux pane listing",
	);
	assert.equal(await other.close(hr), true);
});
