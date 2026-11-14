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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import type { ChildOutcome } from "../src/child-tasks.ts";

import { agentDir, agentFile, cleanup, resetRoot, session, writeAgent } from "./harness.ts";
import { envelopes, mailSession, nextTurn, scan } from "./mail-harness.ts";

beforeEach(() => resetRoot());
after(() => cleanup());

type Session = ReturnType<typeof session>;

/** A distinctive prefix, so a capped body is still recognisable in a request. */
const MARK = "spike-12-result-marker";
/** About 33 KB, the size the dynamic report named; `resultDetails` cuts a body to the 32 KiB default budget. */
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
function pipeline(s: Session, restored: Carried[] = []) {
	const committed: Carried[] = [];
	const carried = (): Carried[] => [
		...restored,
		...s.sent.map((item) => ({ role: "custom", ...item.message })),
		...committed,
	];
	return {
		/** Pi commits each `agent_before_settle` entry to the transcript (agent-session.js:1591). */
		commit(results: unknown[]): void {
			for (const value of results) {
				for (const entry of (value as { entries?: Record<string, unknown>[] } | undefined)?.entries ?? [])
					committed.push({ ...entry, role: "custom", customType: "delegate" });
			}
		},
		committed: () => committed.length,
		transcript: carried,
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
	assert.ok(
		carriedCopy.bytes > 32 * 1024,
		`the one copy is the result body cut to the 32 KiB budget: ${carriedCopy.bytes} bytes`,
	);
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

for (const transcriptPresent of [true, false]) {
	test(
		transcriptPresent
			? "an aborted coordinator reopens with one transcript result across startup replay and the next steering turn"
			: "a coordinator recovers a queued delivered outcome missing from its restored transcript",
		async (t) => {
			const active: Session[] = [];
			const instance = (parent?: string): Session => {
				const created = mailSession(parent ? { parent } : {});
				active.push(created);
				return created;
			};
			t.after(async () => {
				for (const s of active) await s.shutdown();
			});
			mkdirSync(join(agentDir, "squire"), { recursive: true });
			writeFileSync(join(agentDir, "squire", "settings.json"), JSON.stringify({ maxDepth: 2 }));
			writeAgent(
				"coordinator",
				agentFile({ allow_nested_delegation: "[worker]", model: "alpha/fast-model", auto_exit: "false" }),
			);
			writeAgent("worker", agentFile({ model: "alpha/fast-model", auto_exit: "false" }));
			const root = instance();
			await root.start();
			await root.toolCall("delegate", { agent: "coordinator", task: "coordinate" });
			const coordinator = instance(root.entries[0].data.id as string);
			await coordinator.start();
			scan(coordinator);
			assert.ok(coordinator.pi.getActiveTools().includes("delegate"));
			await coordinator.toolCall("delegate", { agent: "worker", task: "look into it" });
			const worker = instance(coordinator.entries[0].data.id as string);
			await worker.start();
			scan(worker);

			const inboxPath = join(agentDir, "squire", "child-tasks", `${encodeURIComponent(coordinator.parent)}.json`);
			const outcomes = (): ChildOutcome[] =>
				(JSON.parse(readFileSync(inboxPath, "utf8")) as { state: { outcomes: ChildOutcome[] } }).state.outcomes;
			const finals = () =>
				[...envelopes(root.parent, "new"), ...envelopes(root.parent, "cur")].filter(
					(envelope) => envelope.in_reply_to.length > 0,
				);

			await coordinator.fire("agent_start");
			const original = pipeline(coordinator);
			await worker.fire("agent_start");
			await worker.fire("context", { messages: [] });
			await worker.fire("agent_end", {
				messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: BODY }] }],
			});
			await worker.fire("agent_settled");
			scan(coordinator);
			const [saved] = outcomes();
			assert.equal(saved.delivered, true);
			assert.equal(outcomes().length, 1);
			const fullCopies = (messages: Carried[]) =>
				messages.reduce((count, message) => count + text(message).split(saved.content).length - 1, 0);
			assert.ok(saved.content.includes(MARK));
			if (transcriptPresent) {
				assert.equal(fullCopies(await original.request()), 1, "the model saw the original result before abort");
				await coordinator.fire("agent_end", {
					messages: [{ role: "assistant", stopReason: "aborted", content: [] }],
				});
				await coordinator.fire("agent_settled", { aborted: true });
			}
			// Otherwise simulate death after sendMessage queued the result but before
			// Pi persisted it: delivered is true, but no result made the transcript.
			assert.equal(outcomes()[0].delivered, true, "abort/death does not acknowledge processing");
			assert.equal(finals().length, 0, "the coordinator has not completed its parent task");
			const transcript = transcriptPresent ? original.transcript() : [];
			await coordinator.shutdown();

			const reopened = instance(coordinator.parent);
			const resumed = pipeline(reopened, transcript);
			await reopened.start();
			scan(reopened);
			await reopened.fire("agent_start");
			// Startup replay uses setImmediate. A resumed task can make its first
			// request before that callback; do not stop measuring at this request.
			assert.equal(fullCopies(await resumed.request()), 1, "first resumed request");
			await nextTurn();
			const replay = reopened.sent[0];
			assert.ok(replay, "startup recovery must wake even an idle coordinator");
			assert.deepEqual(replay.options, { triggerTurn: true, deliverAs: "steer" });
			// Drain replay/steering and any committed settle-boundary entries.
			await reopened.fire("agent_end", TURN);
			resumed.commit(await reopened.fire("agent_before_settle", { entries: [], continue: false }));
			assert.equal(fullCopies(await resumed.request()), 1, "the following steering request");
			assert.equal(
				fullCopies(resumed.transcript()),
				transcriptPresent ? 1 : 0,
				"recovery does not persist another full result; missing context is supplied per request",
			);
			assert.equal(
				resumed
					.transcript()
					.filter((message) => (message.details as ChildOutcome["details"] | undefined)?.id === saved.details.id)
					.length,
				transcriptPresent ? 1 : 0,
				"only the original result-bearing transcript entry survives",
			);
			assert.equal(replay.message.customType, "delegate-recovery");
			assert.equal(replay.message.display, false);
			assert.equal(fullCopies([{ role: "custom", ...replay.message }]), 0, "wake carries no full result");
			await reopened.fire("agent_end", TURN);
			resumed.commit(await reopened.fire("agent_before_settle", { entries: [], continue: false }));
			await reopened.fire("agent_settled", { aborted: false });
			assert.deepEqual(outcomes(), [], "normal processing acknowledges the saved outcome");
			assert.equal(finals().length, 1, "recovery unblocks completion");
			assert.equal(finals()[0].status, "done");
			await reopened.shutdown();

			const again = instance(coordinator.parent);
			const settled = pipeline(again, resumed.transcript());
			await again.start();
			scan(again);
			await nextTurn();
			assert.equal(again.sent.length, 0, "a second reopen resends and wakes nothing");
			assert.equal(fullCopies(await settled.request()), transcriptPresent ? 1 : 0);
			assert.equal(finals().length, 1, "the parent task is answered only once");
		},
	);
}
