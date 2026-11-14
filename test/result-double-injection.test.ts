// Spike 12: can one parent model request carry a delegate result twice?
//
// `takeReply` (src/results.ts:406-459) records the outcome in the durable
// processing inbox, calls `pi.sendMessage` and then marks it delivered. The
// inbox's `context` handler (src/child-tasks.ts:168-190) appends every outcome
// that is not already among `event.messages`. The question is whether one
// request can carry the result from both places.
//
// Each test delivers one reply at one moment of a parent run and counts the
// copies of the result body in the messages the next request would carry.
//
// Pi places a delivered custom message in `context.messages` before
// `transformContext` runs, at every moment. Paths below are inside
// `@earendil-works/pi-coding-agent/dist/core/` and
// `@earendil-works/pi-agent-core/dist/`:
// - idle: the send starts a run whose starting message it is
//   (agent-session.js:1888 `_startRun`, agent-loop.js:44-52);
// - streaming: it is queued on the agent's steering queue and drained into the
//   next request (agent-session.js:1875-1881, agent-loop.js:89-90 and 120-125);
// - `agent_before_settle`: `isStreaming` is still true, so it steers, and
//   `hasQueuedMessages()` continues the run (agent-session.js:1081, 1596);
// - `agent_settled`: the send is deferred until the emit ends and then starts a
//   run (agent-session.js:696-716, 1883-1887).
// `transformContext` is `emitContext` (sdk.js:277-281), which hands the handlers
// `context.messages` (runner.js:1006-1014), so the delivered message is in
// `event.messages` and the inbox's presence check suppresses the copy.

import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { agentFile, cleanup, resetRoot, session, writeAgent } from "./harness.ts";

beforeEach(() => resetRoot());
after(() => cleanup());

type Session = ReturnType<typeof session>;

/** A distinctive prefix, so a capped body is still recognisable in a request. */
const MARK = "spike-12-result-marker";
/** About 33 KB, the size the dynamic report named; `resultDetails` caps a body at 32 KiB. */
const BODY = `${MARK} ${"x".repeat(33_000)}`;

/** One message as `context.messages` carries it; `details` rides along untyped. */
type Carried = { role: string; customType?: string; content?: unknown; details?: unknown };

/** The text a custom message sends the model; `convertToLlm` drops `details` (messages.js:89-95). */
const text = (message: Carried): string =>
	typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");

/** How many messages in one request carry the result body, and how many content bytes they add. */
function copies(messages: Carried[]): { count: number; bytes: number } {
	const found = messages.filter((message) => text(message).includes(MARK));
	return { count: found.length, bytes: found.reduce((sum, message) => sum + text(message).length, 0) };
}

/**
 * The parent's request pipeline as Pi drives it. The transcript holds every
 * delivered custom message and every committed `agent_before_settle` entry;
 * one request adds whatever the `context` handler appends for it.
 */
function pipeline(s: Session) {
	const committed: Carried[] = [];
	const carried = (): Carried[] => [...s.sent.map((item) => ({ role: "custom", ...item.message })), ...committed];
	return {
		/** Pi commits each `agent_before_settle` entry to the transcript (agent-session.js:1591). */
		commit(results: unknown[]): void {
			for (const value of results) {
				for (const entry of (value as { entries?: Record<string, unknown>[] } | undefined)?.entries ?? [])
					committed.push({ ...entry, role: "custom", customType: "delegate" });
			}
		},
		committed: () => committed.length,
		/** One model request: what the `context` handler makes of the carried messages. */
		request: async (): Promise<Carried[]> => {
			const before = carried();
			const results = await s.fire("context", { messages: before });
			const added = results.find((value) => value !== undefined) as { messages: Carried[] } | undefined;
			return added?.messages ?? before;
		},
	};
}

/** The delegation this session started, and the reply envelope that answers it. */
async function delegation(s: Session): Promise<{ id: string; reply: () => object }> {
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model" }));
	await s.start();
	await s.delegate("scout look into it");
	const record = s.entries[0].data as { id: string; requestId: string };
	return {
		id: record.id,
		reply: () => ({
			envelope: {
				id: `reply-${record.id}`,
				from: record.id,
				to: s.parent,
				in_reply_to: [record.requestId],
				status: "done",
				ts: "",
				body: BODY,
			},
			path: "/mail/cur/reply.json",
			requests: [],
			handled: false,
		}),
	};
}

/** The assistant turn `agent_end` reports; `stop` keeps the run from counting as stopped. */
const TURN = {
	messages: [
		{ role: "user", content: "q" },
		{ role: "assistant", content: [{ type: "text", text: "answer" }], stopReason: "stop" },
	],
};

test("a reply that arrives while the parent is idle reaches the next request once", async () => {
	const s = session();
	const { reply } = await delegation(s);
	const parent = pipeline(s);
	await s.run();
	s.events.emit("message:inbound", reply());

	const next = await parent.request();
	const carriedCopy = copies(next);
	assert.equal(carriedCopy.count, 1);
	assert.ok(carriedCopy.bytes > 32 * 1024, `the one copy is the capped ~33 KB result body: ${carriedCopy.bytes} bytes`);
	assert.equal(s.sent.length, 1, "the result was sent once");
});

test("a reply that arrives while the parent streams reaches the next request once", async () => {
	const s = session();
	const { reply } = await delegation(s);
	const parent = pipeline(s);
	await s.fire("agent_start");
	assert.deepEqual(copies(await parent.request()), { count: 0, bytes: 0 }, "the request in flight cannot carry it");
	s.events.emit("message:inbound", reply());
	assert.equal(s.sent.length, 1, "the result was steered into the run");
	await s.fire("agent_end", TURN);
	parent.commit(await s.fire("agent_before_settle", { entries: [], continue: false }));

	assert.equal(copies(await parent.request()).count, 1);
	assert.equal(s.sent.length, 1, "the inbox did not send a second copy");
});

test("a reply that arrives during agent_before_settle reaches the next request once", async () => {
	let deliver: (() => void) | undefined;
	const s = session({
		beforeSquire: (pi) => {
			pi.on("agent_before_settle", () => deliver?.());
		},
	});
	const { reply } = await delegation(s);
	const parent = pipeline(s);
	await s.fire("agent_start");
	assert.equal(copies(await parent.request()).count, 0);
	await s.fire("agent_end", TURN);
	deliver = () => s.events.emit("message:inbound", reply());
	const settle = await s.fire("agent_before_settle", { entries: [], continue: false });
	assert.equal(s.sent.length, 1, "the result was steered into the run");
	assert.ok(
		settle.some((value) => (value as { continue?: boolean } | undefined)?.continue === true),
		"the queued result continues the run instead of settling",
	);
	parent.commit(settle);
	assert.equal(parent.committed(), 1, "Pi committed the boundary entry");

	const next = await parent.request();
	assert.equal(copies(next).count, 1, "the boundary entry and the delivered message are one copy");
	assert.equal(s.sent.length, 1);
});

test("a reply that arrives during agent_settled reaches the next request once", async () => {
	// Pi holds a send made while `agent_settled` is emitted and runs it after the
	// emit (agent-session.js:699, 706-716, 1884-1886). Model that hold here: the
	// harness records sends at once, so without it the deferral is unobservable.
	const held: { message: { customType: string; content: unknown; display?: boolean }; options: unknown }[] = [];
	let deferring = false;
	let deliver: (() => void) | undefined;
	const s = session({
		beforeSquire: (pi) => {
			pi.on("agent_settled", () => deliver?.());
		},
	});
	const send = s.pi.sendMessage;
	s.pi.sendMessage = (message, options) => {
		if (deferring) {
			held.push({ message, options });
			return 0;
		}
		return send(message, options);
	};
	const { reply } = await delegation(s);
	const parent = pipeline(s);
	await s.fire("agent_start");
	assert.equal(copies(await parent.request()).count, 0);
	await s.fire("agent_end", TURN);
	deliver = () => s.events.emit("message:inbound", reply());

	deferring = true;
	await s.fire("agent_settled");
	deferring = false;
	assert.equal(held.length, 1, "Pi deferred the send made during the emit");
	assert.equal(s.sent.length, 0, "nothing reached the transcript while the emit ran");
	for (const item of held.splice(0)) send(item.message, item.options);

	assert.equal(copies(await parent.request()).count, 1);
	assert.equal(s.sent.length, 1, "the deferred send is the only copy");
	// The next settle observes the outcome at that request and drops it, so a
	// later request still carries the one delivered message.
	await s.fire("agent_settled");
	assert.equal(copies(await parent.request()).count, 1);
});
