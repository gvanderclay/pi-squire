// The model-facing tools: `delegate`, which starts without a dialog,
// `delegation_status` and `delegation_close`. These tests drive the extension
// only through its registration function: a temporary agent directory, a fake
// Pi session with a scripted `ctx.ui`, the fake tmux, `message:send` stubbed.

import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { agentFile, cleanup, resetRoot, session, writeAgent } from "./harness.ts";

beforeEach(() => resetRoot());
after(() => cleanup());

const SCOUT = agentFile(
	{ description: "Looks things up", model: "alpha/fast-model", thinking: "low" },
	"You look things up.",
);
const RESEARCHER = agentFile(
	{ description: "Digs deeper", model: "alpha/deep-model", thinking: "high" },
	"You dig deeper.",
);

// ---------------------------------------------------------------------------
// The tool description

test("the delegate tool description lists the roster and its defaults", async () => {
	writeAgent("scout", SCOUT);
	writeAgent("researcher", RESEARCHER);
	const s = session();
	const description = s.tool("delegate").description;
	assert.match(description, /scout/);
	assert.match(description, /Looks things up/);
	assert.match(description, /alpha\/fast-model/);
	assert.match(description, /thinking low/);
	assert.match(description, /researcher — Digs deeper \(default alpha\/deep-model, thinking high\)/);
	assert.match(description, /delegation_status/);
});

test("a roster written after registration shows up in the description at session start", async () => {
	const s = session();
	writeAgent("scout", SCOUT);
	await s.start();
	assert.match(s.tool("delegate").description, /scout/);
});

test("with an empty roster the description says how to add an agent", async () => {
	const s = session();
	assert.match(s.tool("delegate").description, /AGENT\.md/);
});

test("inside a delegate no tools are registered", async () => {
	writeAgent("scout", SCOUT);
	const s = session({ parentEnv: "some-parent" });
	assert.deepEqual(s.tools(), []);
});

// ---------------------------------------------------------------------------
// The delegate tool: refusals

test("an invalid agent, model or thinking level is refused with close matches and starts nothing", async () => {
	writeAgent("scout", SCOUT);
	const s = session();
	await s.start();
	await assert.rejects(s.toolCall("delegate", { agent: "nobody", task: "do it" }), /nobody.*scout/s);
	await assert.rejects(
		s.toolCall("delegate", { agent: "scout", task: "do it", model: "alpha/fast-modle" }),
		/close matches: alpha\/fast-model/,
	);
	await assert.rejects(
		s.toolCall("delegate", { agent: "scout", task: "do it", thinking: "hihg" }),
		/close matches: high/,
	);
	assert.deepEqual(s.selects, []);
	assert.deepEqual(s.sendCalls, []);
	assert.deepEqual(s.tmux.opened, []);
});

test("outside tmux the delegate tool refuses and starts nothing", async () => {
	writeAgent("scout", SCOUT);
	const s = session();
	await s.start();
	s.tmux.inside = false;
	await assert.rejects(s.toolCall("delegate", { agent: "scout", task: "do it" }), /tmux/);
	assert.deepEqual(s.selects, []);
	assert.deepEqual(s.sendCalls, []);
	assert.deepEqual(s.entries, []);
});

// ---------------------------------------------------------------------------
// The delegate tool: starting

test("a call starts the delegation with the agent's defaults and returns its id, with no dialog", async () => {
	writeAgent("scout", SCOUT);
	const s = session();
	await s.start();
	const result = await s.toolCall("delegate", { agent: "scout", task: "find the answer" });

	assert.deepEqual(s.selects, []);
	assert.deepEqual(s.editors, []);
	assert.deepEqual(s.customs, []);
	const id = s.entries[0].data.id as string;
	assert.equal(result.content[0].type, "text");
	assert.ok(result.content[0].text.includes(id), result.content[0].text);
	assert.ok(result.content[0].text.includes(`scout-${id.slice(0, 8)}`), result.content[0].text);
	assert.equal(s.sendCalls[0].body, "find the answer");
	assert.equal(s.tmux.opened[0].name, `scout-${id.slice(0, 8)}`);
	assert.equal(s.tmux.opened[0].argv[s.tmux.opened[0].argv.indexOf("--model") + 1], "alpha/fast-model");
	assert.equal(s.tmux.opened[0].argv[s.tmux.opened[0].argv.indexOf("--thinking") + 1], "low");
	assert.deepEqual(s.entries[0], {
		customType: "delegate",
		data: {
			id,
			agent: "scout",
			model: "alpha/fast-model",
			thinking: "low",
			name: `scout-${id.slice(0, 8)}`,
			windowId: s.tmux.opened[0].windowId,
			windowName: `scout-${id.slice(0, 8)}`,
			requestId: (s.sendCalls[0].envelope as { id: string }).id,
			autoExit: true,
		},
	});
	assert.equal(s.notes.at(-1), `delegate: scout ${id} started in window scout-${id.slice(0, 8)}`);
});

test("a label names the session and the window, shows in the reply and in delegation_status", async () => {
	writeAgent("scout", SCOUT);
	const s = session();
	await s.start();
	const result = await s.toolCall("delegate", { agent: "scout", task: "find it", label: "roster" });
	const { argv, name, windowId } = s.tmux.opened[0];
	assert.equal(name, "scout-roster");
	assert.equal(argv[argv.indexOf("--name") + 1], "scout-roster");
	assert.ok(result.content[0].text.includes("in window scout-roster."), result.content[0].text);
	const statusResult = await s.toolCall("delegation_status", {});
	const status = statusResult.content[0].text;
	assert.ok(status.includes("name: scout-roster\n"), status);
	const [detail] = (statusResult.details as { delegations: { name: string }[] }).delegations;
	assert.equal(detail.name, "scout-roster");
	assert.ok(status.includes(`window: scout-roster (${windowId})`), status);
});

test("a bad label is refused and opens no window", async () => {
	writeAgent("scout", SCOUT);
	const s = session();
	await s.start();
	await assert.rejects(s.toolCall("delegate", { agent: "scout", task: "find it", label: "has space" }), /label/);
	assert.deepEqual(s.tmux.opened, []);
	assert.deepEqual(s.sendCalls, []);
});

test("model and thinking overrides shape the launched argv", async () => {
	writeAgent("researcher", RESEARCHER);
	const s = session();
	await s.start();
	await s.toolCall("delegate", {
		agent: "researcher",
		task: "dig",
		model: "alpha/fast-model",
		thinking: "xhigh",
	});
	const { argv } = s.tmux.opened[0];
	assert.equal(argv[argv.indexOf("--model") + 1], "alpha/fast-model");
	assert.equal(argv[argv.indexOf("--thinking") + 1], "xhigh");
	assert.equal(s.entries[0].data.model, "alpha/fast-model");
	assert.equal(s.entries[0].data.thinking, "xhigh");
});

test("without a UI the delegate tool still starts the delegation", async () => {
	writeAgent("scout", SCOUT);
	const s = session({ hasUI: false });
	await s.start();
	const result = await s.toolCall("delegate", { agent: "scout", task: "do it" });
	assert.match(result.content[0].text, /Started delegation/);
	assert.equal(s.tmux.opened.length, 1);
	assert.deepEqual(s.selects, []);
});

test("two concurrent delegate calls each start a delegation and return their own result", async () => {
	writeAgent("scout", SCOUT);
	writeAgent("researcher", RESEARCHER);
	const s = session();
	await s.start();
	const [one, two] = await Promise.all([
		s.toolCall("delegate", { agent: "scout", task: "answer one" }),
		s.toolCall("delegate", { agent: "researcher", task: "answer two" }),
	]);

	assert.deepEqual(s.selects, []);
	assert.equal(s.tmux.opened.length, 2);
	assert.equal(s.entries.length, 2);
	const byAgent = new Map(s.entries.map((entry) => [entry.data.agent as string, entry.data.id as string]));
	const first = one.details as { outcome: string; id: string };
	const second = two.details as { outcome: string; id: string };
	assert.equal(first.outcome, "started");
	assert.equal(second.outcome, "started");
	assert.equal(first.id, byAgent.get("scout"));
	assert.equal(second.id, byAgent.get("researcher"));
	assert.notEqual(first.id, second.id);
	assert.ok(one.content[0].text.includes(byAgent.get("scout")!), one.content[0].text);
	assert.ok(two.content[0].text.includes(byAgent.get("researcher")!), two.content[0].text);
	assert.deepEqual(s.sendCalls.map((call) => call.body).sort(), ["answer one", "answer two"]);
});

// ---------------------------------------------------------------------------
// delegation_status and delegation_close

/** One recorded delegation, as 04 writes it. */
type Delegation = { id: string; agent: string; model: string; requestId: string };

/** A reply to `delegation`'s task, shaped like `mailbox`'s envelope. */
function reply(parent: string, delegation: Delegation, status = "done") {
	const replyId = `reply-${delegation.agent}`;
	return {
		envelope: {
			id: replyId,
			from: delegation.id,
			to: parent,
			in_reply_to: [delegation.requestId],
			status,
			ts: "2026-09-29T00:00:00.000Z",
			body: "The answer.",
		},
		path: `/mailbox/${parent}/cur/000000000000002-${replyId}.json`,
		requests: [],
		handled: false,
	};
}

test("delegation_status with no delegations says so", async () => {
	const s = session();
	await s.start();
	const result = await s.toolCall("delegation_status", {});
	assert.equal(result.content[0].text, "No delegations are recorded in this session.");
});

test("delegation_status reports running, done and closed through the window and the records", async () => {
	writeAgent("scout", SCOUT);
	writeAgent("researcher", RESEARCHER);
	const s = session();
	await s.start();
	await s.toolCall("delegate", { agent: "scout", task: "answer one" });
	await s.toolCall("delegate", { agent: "researcher", task: "answer two" });
	const [first, second] = s.entries.map((entry) => entry.data as Delegation);
	const [w1, w2] = s.tmux.opened;

	const running = (await s.toolCall("delegation_status", {})).content[0].text;
	assert.match(running, /^2 delegations:/);
	assert.ok(running.includes(`${first.id} scout (alpha/fast-model, thinking low)`), running);
	assert.ok(running.includes(`name: scout-${first.id.slice(0, 8)}`), running);
	assert.ok(running.includes(`name: researcher-${second.id.slice(0, 8)}`), running);
	assert.ok(running.includes(`window: scout-${first.id.slice(0, 8)} (${w1.windowId})`), running);
	assert.equal(running.match(/state: running — the window is open and no result has arrived/g)?.length, 2);

	s.events.emit("message:inbound", reply(s.parent, first));
	s.tmux.alive.delete(w2.windowId);
	const mixed = (await s.toolCall("delegation_status", {})).content[0].text;
	assert.ok(mixed.includes(`${first.id} scout`), mixed);
	assert.match(mixed, /state: done — result status: done/);
	assert.ok(mixed.includes(`envelope: /mailbox/${s.parent}/cur/000000000000002-reply-scout.json`), mixed);
	assert.ok(mixed.includes(`window: researcher-${second.id.slice(0, 8)} (${w2.windowId})`), mixed);
	assert.match(mixed, /state: closed — the window is gone/);

	const filtered = (await s.toolCall("delegation_status", { id: second.id })).content[0].text;
	assert.match(filtered, /^1 delegation:/);
	assert.ok(filtered.includes(second.id), filtered);
	assert.ok(!filtered.includes(first.id), filtered);
});

test("delegation_status refuses an unknown id with the ones that exist", async () => {
	writeAgent("scout", SCOUT);
	const s = session();
	await s.start();
	await s.toolCall("delegate", { agent: "scout", task: "do it" });
	const id = s.entries[0].data.id as string;
	await assert.rejects(
		s.toolCall("delegation_status", { id: "nope" }),
		new RegExp(`no delegation "nope"; known: ${id}`),
	);
});

test("delegation_close kills the window, records the close, and reports it once", async () => {
	writeAgent("scout", SCOUT);
	const s = session();
	await s.start();
	await s.toolCall("delegate", { agent: "scout", task: "do it" });
	const id = s.entries[0].data.id as string;
	const { windowId } = s.tmux.opened[0];

	const closed = await s.toolCall("delegation_close", { id });
	assert.deepEqual(s.tmux.killed, [windowId]);
	assert.deepEqual(s.entries.at(-1), { customType: "delegate", data: { id, closed: true } });
	assert.match(
		closed.content[0].text,
		new RegExp(`Closed delegation ${id}: killed window scout-${id.slice(0, 8)} \\(${windowId}\\)\\.`),
	);
	assert.deepEqual(s.statuses.at(-1), { key: "delegate", text: undefined });

	const again = await s.toolCall("delegation_close", { id });
	assert.equal(again.content[0].text, `Delegation ${id} is already closed.`);
	assert.deepEqual(s.tmux.killed, [windowId]);

	const status = (await s.toolCall("delegation_status", { id })).content[0].text;
	assert.match(status, /state: closed — delegation_close recorded it/);
});

test("delegation_close kills the window of a delegation whose result already arrived", async () => {
	writeAgent("scout", SCOUT);
	const s = session();
	await s.start();
	await s.toolCall("delegate", { agent: "scout", task: "do it" });
	const delegation = s.entries[0].data as Delegation;
	const { windowId } = s.tmux.opened[0];
	s.events.emit("message:inbound", reply(s.parent, delegation));
	assert.equal(await s.tmux.isAlive(windowId), true);

	await s.toolCall("delegation_close", { id: delegation.id });
	assert.deepEqual(s.tmux.killed, [windowId]);
	assert.equal(await s.tmux.isAlive(windowId), false);
});

test("delegation_close records a close when the window is already gone", async () => {
	writeAgent("scout", SCOUT);
	const s = session();
	await s.start();
	await s.toolCall("delegate", { agent: "scout", task: "do it" });
	const id = s.entries[0].data.id as string;
	s.tmux.alive.delete(s.tmux.opened[0].windowId);

	const result = await s.toolCall("delegation_close", { id });
	assert.match(result.content[0].text, /its window scout-.* was already gone/);
	assert.deepEqual(s.tmux.killed, []);
	assert.deepEqual(s.entries.at(-1), { customType: "delegate", data: { id, closed: true } });
});

test("delegation_close refuses an unknown id and kills nothing", async () => {
	writeAgent("scout", SCOUT);
	const s = session();
	await s.start();
	await s.toolCall("delegate", { agent: "scout", task: "do it" });
	const id = s.entries[0].data.id as string;
	await assert.rejects(
		s.toolCall("delegation_close", { id: "nope" }),
		new RegExp(`no delegation "nope"; known: ${id}`),
	);
	assert.deepEqual(s.tmux.killed, []);
	assert.equal(s.entries.length, 1);
});

test("a resumed parent still reports a recorded close as closed", async () => {
	writeAgent("scout", SCOUT);
	const first = session();
	await first.start();
	await first.toolCall("delegate", { agent: "scout", task: "do it" });
	const id = first.entries[0].data.id as string;
	await first.toolCall("delegation_close", { id });
	const saved = structuredClone(first.entries);

	const resumed = session({ parent: first.parent, entries: saved });
	await resumed.start();
	assert.deepEqual(resumed.statuses, [], "a closed delegation is not counted as running");
	const status = (await resumed.toolCall("delegation_status", { id })).content[0].text;
	assert.match(status, /state: closed — delegation_close recorded it/);
	const again = await resumed.toolCall("delegation_close", { id });
	assert.equal(again.content[0].text, `Delegation ${id} is already closed.`);
});
