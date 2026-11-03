// Command navigation uses verified windows and the caller's attached tmux client.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { after, beforeEach, test } from "node:test";
import { placementProject } from "../src/window-placement.ts";

import { agentDir, agentFile, cleanup, keyScript, resetRoot, root, session, writeAgent } from "./harness.ts";

const companion = placementProject(root).companion;

beforeEach(() => {
	resetRoot();
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
});
after(() => cleanup());

type Session = ReturnType<typeof session>;
type Options = Parameters<typeof session>[0];

const setPlacement = (value: string): void => {
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(join(agentDir, "squire", "settings.json"), JSON.stringify({ windowPlacement: value }));
};

/** A started session; each `launch` adds a delegation and returns its id and window. */
async function started(options: Options = {}): Promise<Session> {
	const s = session({ mode: "tui", ...options });
	await s.start();
	return s;
}

async function launch(s: Session, label: string): Promise<{ id: string; windowId: string }> {
	const result = await s.toolCall("delegate", { agent: "scout", task: "look", label, autoExit: false });
	const { id } = result.structuredContent as { id: string };
	const windowId = s.tmux.opened[s.tmux.opened.length - 1].windowId;
	return { id, windowId };
}

/** A reply envelope for the delegation `id`, as the mailbox emits it on `message:inbound`. */
function reply(s: Session, id: string): unknown {
	const call = s.sendCalls.find((sent) => sent.to === id);
	assert.ok(call?.envelope, `no request was sent to ${id}`);
	const requestId = (call.envelope as { id: string }).id;
	return {
		envelope: {
			id: `reply-${id}`,
			from: id,
			to: s.parent,
			in_reply_to: [requestId],
			status: "done",
			ts: "",
			body: "ok",
		},
		path: "/mail/cur/reply.json",
		requests: [],
		handled: false,
	};
}

const tick = async (t: TestContext, times = 1): Promise<void> => {
	for (let i = 0; i < times; i++) {
		t.mock.timers.tick(5000);
		for (let j = 0; j < 3; j++) await new Promise((resolve) => setImmediate(resolve));
	}
};

test("delegate commands remain registered without the old panel or shortcut", async () => {
	const s = await started();
	assert.ok(!s.commands().includes("delegates"));
	assert.ok(s.commands().includes("delegate"));
	assert.ok(s.commands().includes("delegate-resume"));
	assert.ok(s.commands().includes("delegate-open"));
	assert.deepEqual(s.shortcuts(), []);
});

test("the client is the most recently active one attached to the parent's session", async () => {
	const s = await started();
	const one = await launch(s, "one");
	s.tmux.attachClient("stale", 10);
	s.tmux.attachClient("fresh", 90);
	s.tmux.attachClient("elsewhere", 500, "other-session");
	await s.command("delegate-open", one.id);
	assert.deepEqual(s.tmux.clientLookups, ["work"]);
	assert.deepEqual(
		s.tmux.switches.map((sw) => sw.client),
		["fresh"],
	);
});

test("with no client attached switch refuses with a notice and peek still works", async () => {
	const s = await started();
	const one = await launch(s, "one");
	s.tmux.screens.set(one.windowId, "hello from the pane");
	await s.command("delegate-open", one.id);
	assert.deepEqual(s.tmux.switches, []);
	assert.equal(s.warnings.length, 1);
	assert.match(s.warnings[0], /cannot switch: no tmux client is attached to session work/);
	const peek = keyScript(["x", "escape"]);
	s.queueCustom(peek);
	await s.command("delegate-open", `${one.id} --peek`);
	assert.match(peek.frames[1], /hello from the pane/);
});

test("a failing client lookup or switch is reported, not thrown", async () => {
	const s = await started();
	const one = await launch(s, "one");
	s.tmux.attachClient("c1", 1);
	s.tmux.fail.switchTo = "can't find client";
	await s.command("delegate-open", `${one.id} --switch`);
	s.tmux.fail.clientFor = "server gone";
	await s.command("delegate-open", one.id);
	assert.deepEqual(s.errors.length + s.warnings.length, 2);
	assert.match(s.errors[0], /could not switch: can't find client/);
	assert.match(s.warnings[0], /could not list tmux clients: server gone/);
});

test("peek captures the pane in an overlay, r refreshes it and enter switches to the delegate", async () => {
	const s = await started();
	const one = await launch(s, "one");
	s.tmux.attachClient("c1", 1);
	s.tmux.screens.set(one.windowId, "first screen");
	// The pane changes between the capture and the refresh.
	const capture = s.tmux.capture.bind(s.tmux);
	s.tmux.capture = async (id: string) => {
		const text = await capture(id);
		s.tmux.screens.set(id, "second screen");
		return text;
	};
	const peek = keyScript(["x", "r", "enter"]);
	s.queueCustom(peek);
	await s.command("delegate-open", `${one.id} --peek`);
	assert.match(peek.frames[1], /Peek: scout-one/);
	assert.match(peek.frames[1], /first screen/);
	assert.match(peek.frames[2], /second screen/);
	assert.deepEqual(s.tmux.captures, [one.windowId, one.windowId]);
	assert.deepEqual(peek.result, { action: "switch" });
	assert.deepEqual(s.tmux.switches, [{ client: "c1", windowId: one.windowId }]);
	assert.deepEqual(s.customOptions[0], {
		overlay: true,
		overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center" },
	});
});

test("esc in a peek returns to the prompt", async () => {
	const s = await started();
	const one = await launch(s, "one");
	const peek = keyScript(["escape"]);
	s.queueCustom(peek);
	await s.command("delegate-open", `${one.id} --peek`);
	assert.match(peek.frames[0], /r refresh · enter switch · esc back/);
	assert.equal(s.customs.length, 1);
	assert.deepEqual(s.tmux.switches, []);
});

test("a failing capture is shown in the peek", async () => {
	const s = await started();
	const one = await launch(s, "one");
	s.tmux.fail.capture = "can't find pane";
	const peek = keyScript(["x", "escape"]);
	s.queueCustom(peek);
	await s.command("delegate-open", `${one.id} --peek`);
	assert.match(peek.frames[1], /Could not capture the pane: can't find pane/);
});

test("/delegate-open takes an id and at most one mode flag", async () => {
	const s = await started();
	const one = await launch(s, "one");
	for (const [args, message] of [
		["", /give one delegation id; \/delegate-open <id>/],
		[`${one.id} ${one.id}`, /give one delegation id/],
		[`${one.id} --peek --switch`, /at most one of/],
		[`${one.id} --popup`, /unknown flag --popup/],
		[`${one.id} --window`, /unknown flag --window/],
		["nope", /no open delegate "nope"; open: /],
	] as const) {
		s.errors.length = 0;
		await s.command("delegate-open", args);
		assert.match(s.errors[0], message, args);
	}
});

test("/delegate-open switches by default and with --switch, in either session", async () => {
	setPlacement("current");
	const s = await started();
	const here = await launch(s, "here");
	s.tmux.attachClient("c1", 1);
	await s.command("delegate-open", here.id);
	assert.equal(s.tmux.switches.length, 1);
	await s.command("delegate-open", `${here.id} --switch`);
	assert.equal(s.tmux.switches.length, 2);
	s.tmux.moveWindow(here.windowId, companion);
	await s.command("delegate-open", here.id);
	assert.equal(s.tmux.switches.length, 3);
	assert.deepEqual(s.tmux.switches.at(-1), { client: "c1", windowId: here.windowId });
});

test("/delegate-open --peek shows the pane and enter escalates to a switch", async () => {
	const s = await started();
	const one = await launch(s, "one");
	s.tmux.attachClient("c1", 1);
	s.tmux.screens.set(one.windowId, "pane text");
	const script = keyScript(["x", "enter"]);
	s.queueCustom(script);
	await s.command("delegate-open", `${one.id} --peek`);
	assert.match(script.frames[1], /pane text/);
	assert.equal(s.customOptions[0] !== undefined && (s.customOptions[0] as { overlay: boolean }).overlay, true);
	assert.equal(s.tmux.switches.length, 1);
	const back = keyScript(["escape"]);
	s.queueCustom(back);
	await s.command("delegate-open", `${one.id} --peek`);
	assert.equal(s.tmux.switches.length, 1, "esc leaves without switching");
});

test("/delegate-open completes the ids of open delegations, then the flags", async () => {
	const s = await started();
	const open = await launch(s, "open-one");
	const shut = await launch(s, "shut-one");
	await s.toolCall("delegation_close", { id: shut.id });
	const values = async (prefix: string): Promise<string[] | null> =>
		(await s.completionsFor("delegate-open", prefix))?.map((item) => item.value) ?? null;
	assert.deepEqual(await values(""), [open.id, "--switch", "--peek"]);
	assert.deepEqual(await values("--p"), ["--peek"]);
	assert.deepEqual(
		await values(`${open.id} `),
		["--switch", "--peek"].map((flag) => `${open.id} ${flag}`),
	);
	assert.deepEqual(await values(`${open.id} --s`), [`${open.id} --switch`]);
	assert.equal(await values(`${open.id} --peek `), null);
});

test("the poll runs only while a delegation is running", async (t) => {
	// Keep the TUI navigator active but isolate its authoritative poll from the
	// passive widget, which deliberately observes finished-open windows too.
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(join(agentDir, "squire", "settings.json"), JSON.stringify({ delegateWidgetMaxEntries: 0 }));
	t.mock.timers.enable({ apis: ["setInterval"] });
	const s = await started();
	const one = await launch(s, "one");
	s.tmux.attachClient("c1", 1);
	await tick(t);
	const listed = s.tmux.listCalls;
	assert.ok(listed > 0, "the poll runs while the delegation does");
	s.events.emit("message:inbound", reply(s, one.id)); // done: nothing is running
	await s.command("delegate-open", one.id);
	await tick(t, 3);
	assert.ok(s.tmux.listCalls <= listed + 2, "a switch starts no poll of its own");
	const after = s.tmux.listCalls;
	await tick(t, 3);
	assert.equal(s.tmux.listCalls, after, "the poll stopped with nothing running");
});
