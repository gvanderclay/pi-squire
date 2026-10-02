// The parent's poll: while a delegation runs, a tick asks the mailbox to claim
// waiting replies (`message:scan`), then checks each window, and declares a
// delegation closed without a result only when its window is gone and the
// same tick's scan found no reply. Timers are node:test mock timers; tmux and
// the mailbox are the harness's fakes.

import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { after, beforeEach, test } from "node:test";

import { agentFile, cleanup, resetRoot, session, writeAgent } from "./harness.ts";

beforeEach(() => resetRoot());
after(() => cleanup());

const INTERVAL = 5000;
type Session = ReturnType<typeof session>;

/** A session with one delegation started under mock timers. */
async function started(t: TestContext, options: Parameters<typeof session>[0] = {}) {
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
	t.mock.timers.enable({ apis: ["setInterval"] });
	const s = session(options);
	await s.start();
	await s.delegate("scout look into it");
	return s;
}

/** One poll interval, then the event-loop turns the tick's tmux checks need. */
async function tick(t: TestContext, times = 1) {
	for (let i = 0; i < times; i++) {
		t.mock.timers.tick(INTERVAL);
		for (let j = 0; j < 3; j++) await new Promise((resolve) => setImmediate(resolve));
	}
}

/** A reply envelope, as the mailbox emits it on `message:inbound`, to the first request this session sent. */
function reply(s: Session, status = "done") {
	const requestId = (s.sendCalls[0].envelope as { id: string }).id;
	const delegationId = (s.entries[0].data as { id: string }).id;
	return {
		envelope: {
			id: `reply-${status}`,
			from: delegationId,
			to: s.parent,
			in_reply_to: [requestId],
			status,
			ts: "",
			body: "the answer",
		},
		path: "/mail/cur/reply.json",
		requests: [],
		handled: false,
	};
}

const closedMessages = (s: Session) => s.sent.filter((m) => /closed without a result/.test(String(m.message.content)));
const resultMessages = (s: Session) =>
	s.sent.filter((m) => /^\[delegate\] Result from/.test(String(m.message.content)));
const statusText = async (s: Session) => (await s.toolCall("delegation_status", {})).content[0].text;

test("a gone window whose reply the scan delivers is done, with no closed message", async (t) => {
	const s = await started(t);
	s.tmux.windows.clear();
	s.scan.queue.push(reply(s));
	await tick(t);
	assert.equal(closedMessages(s).length, 0);
	assert.equal(resultMessages(s).length, 1);
	assert.match(await statusText(s), /state: done — result status: done/);
});

test("a gone window with no reply gives exactly one closed message that starts a turn, and the status reports it", async (t) => {
	const s = await started(t);
	s.tmux.windows.clear();
	await tick(t, 4);
	const closed = closedMessages(s);
	assert.equal(closed.length, 1);
	assert.deepEqual(closed[0].options, { triggerTurn: true, deliverAs: "followUp" });
	const id = (s.entries[0].data as { id: string }).id;
	assert.ok(String(closed[0].message.content).includes(id), "names the delegation");
	assert.match(await statusText(s), /state: closed without a result/);
});

test("a live window produces no message across several ticks", async (t) => {
	const s = await started(t);
	await tick(t, 5);
	assert.equal(s.sent.length, 0);
	assert.equal(s.scan.calls, 5);
	assert.match(await statusText(s), /state: running/);
});

test("no tick does any tmux work once no delegation is running", async (t) => {
	const s = await started(t);
	s.scan.queue.push(reply(s));
	await tick(t);
	assert.equal(resultMessages(s).length, 1);
	const calls = s.scan.calls;
	const listed = s.tmux.listCalls;
	await tick(t, 3);
	assert.equal(s.tmux.listCalls, listed);
	assert.equal(s.scan.calls, calls, "the timer stopped");
});

test("a restored session with a running delegation polls and detects its gone window", async (t) => {
	const first = await started(t);
	const resumed = session({ entries: first.entries });
	resumed.tmux.windows.clear();
	await resumed.start();
	await tick(t);
	assert.equal(closedMessages(resumed).length, 1);
});

test("a reply arriving after a closed record is delivered and the status then shows done", async (t) => {
	const s = await started(t);
	s.tmux.windows.clear();
	await tick(t);
	assert.equal(closedMessages(s).length, 1);
	s.events.emit("message:inbound", reply(s));
	assert.equal(resultMessages(s).length, 1);
	assert.match(await statusText(s), /state: done — result status: done/);
});

test("a reply that lands while the window is being checked is claimed, not reported closed", async (t) => {
	const s = await started(t);
	s.tmux.windows.clear();
	const listWindows = s.tmux.listWindows.bind(s.tmux);
	s.tmux.listWindows = async () => {
		s.scan.queue.push(reply(s));
		return listWindows();
	};
	await tick(t);
	assert.equal(closedMessages(s).length, 0);
	assert.equal(resultMessages(s).length, 1);
	assert.match(await statusText(s), /state: done/);
});

test("a closed-without-a-result record survives a resume and is not polled again", async (t) => {
	const s = await started(t);
	s.tmux.windows.clear();
	await tick(t);
	const resumed = session({ entries: s.entries });
	await resumed.start();
	assert.match(await statusText(resumed), /state: closed without a result/);
	const before = resumed.scan.calls;
	await tick(t, 2);
	assert.equal(resumed.scan.calls, before, "a closed delegation is not polled");
});

test("a delegation closed with delegation_close keeps reporting closed", async (t) => {
	const s = await started(t);
	const id = (s.entries[0].data as { id: string }).id;
	await s.toolCall("delegation_close", { id });
	await tick(t, 2);
	assert.equal(closedMessages(s).length, 0);
	assert.match(await statusText(s), /state: closed — delegation_close recorded it/);
	s.events.emit("message:inbound", reply(s));
	assert.match(await statusText(s), /state: closed — delegation_close recorded it/);
});

test("a bus where nobody answers message:scan never declares a delegation closed", async (t) => {
	const s = await started(t);
	s.scan.answering = false;
	s.tmux.windows.clear();
	await tick(t, 3);
	assert.equal(s.scan.calls, 3);
	assert.equal(closedMessages(s).length, 0);
	assert.equal(s.entries.length, 1, "nothing recorded");
});

test("a tmux error declares nothing for that tick", async (t) => {
	const s = await started(t);
	s.tmux.failList = "tmux: server exited";
	await tick(t, 2);
	assert.equal(closedMessages(s).length, 0);
	assert.match(await statusText(s), /state: unknown/);
});

test("a window id that now belongs to a differently named window is closed without a result and never killed", async (t) => {
	const first = await started(t);
	const resumed = session({ entries: first.entries });
	resumed.tmux.addWindow(first.tmux.opened[0].windowId, "vim");
	await resumed.start();
	await tick(t);
	assert.equal(closedMessages(resumed).length, 1);
	assert.equal(resultMessages(resumed).length, 0);
	await tick(t, 2);
	assert.equal(closedMessages(resumed).length, 1, "told once");
	const id = (first.entries[0].data as { id: string }).id;
	const closed = await resumed.toolCall("delegation_close", { id });
	assert.match(closed.content[0].text, /was already gone/);
	assert.deepEqual(resumed.tmux.killed, []);
});

test("a matching window whose program exited is recorded gone", async (t) => {
	const s = await started(t);
	s.tmux.exit(s.tmux.opened[0].windowId);
	await tick(t);
	assert.equal(closedMessages(s).length, 1);
	assert.match(await statusText(s), /state: closed without a result/);
});

test("each tick lists the windows once, however many delegations run", async (t) => {
	const s = await started(t);
	await s.delegate("scout second");
	await s.delegate("scout third");
	assert.equal(s.tmux.opened.length, 3);
	const before = s.tmux.listCalls;
	await tick(t, 2);
	assert.equal(s.tmux.listCalls - before, 2);
});

test("session_shutdown stops the poll", async (t) => {
	const s = await started(t);
	await s.shutdown();
	await tick(t, 2);
	assert.equal(s.scan.calls, 0);
});
