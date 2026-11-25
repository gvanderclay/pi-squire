// How a delegate outcome reaches the parent's next model request.
//
// Pi rebuilds every request from the saved projection (agent-session.js:492-505)
// and never writes a `context` handler's messages back (runner.js:1019-1077),
// so a message added per request has no place in the transcript and moves as
// the transcript grows. Squire therefore writes each outcome into the session
// once and adds nothing at request time: the `context` handler only records
// which outcomes a request carried. A provider that binds signed reasoning to
// the exact earlier prefix then keeps it.
//
// Each test delivers one reply at one moment of a parent run and counts the
// copies of the result body in the messages the next request would carry.
//
// Paths below are inside `@earendil-works/pi-coding-agent/dist/core/`:
// - idle: the send is appended to the session at once (agent-session.js:1991);
// - streaming: it is appended after the turn's tool results (agent-session.js:838-861);
// - `agent_before_settle`: `isStreaming` is still true, so it is appended at
//   the boundary (agent-session.js:1631-1649);
// - `agent_settled`: the send is deferred until the emit ends and then starts a
//   run (agent-session.js:744, 1975-1979);
// - `before_agent_start`: a send made while the run starts is placed before the
//   run's starting messages (agent-session.js:1499-1505).
// `turn_end` and `agent_before_settle` also commit a handler's `entries`
// drafts (agent-session.js:568, 1636), which is where an outcome the transcript
// lacks is written.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { Type } from "typebox";
import type { ChildOutcome } from "../src/child-tasks.ts";

import { FakeTmux } from "./fake-tmux.ts";
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
type Carried = {
	role: string;
	customType?: string;
	content?: unknown;
	details?: unknown;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
};

/** The text a custom message sends the model; `convertToLlm` drops `details` (messages.js:89-95). */
const text = (message: Carried): string =>
	typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");

/** How many messages in one request carry the result body, and how many content bytes they add. */
function copies(messages: Carried[]): { count: number; bytes: number } {
	const found = messages.filter((message) => text(message).includes(MARK));
	return { count: found.length, bytes: found.reduce((sum, message) => sum + text(message).length, 0) };
}

/**
 * The parent's request pipeline as Pi drives it. `restored` is what the session
 * already held, `s.sent` what this process wrote, and `committed` the boundary
 * drafts Pi saved. A request is exactly those messages: the `context` handler
 * adds none of its own.
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
		/** One model request: what Pi would send, and what the `context` handlers add to it. */
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

/** The tool result Pi saves after one `delegation_close` call. */
function closeReceipt(
	closed: { content: { type: string; text: string }[]; details?: unknown },
	toolCallId: string,
	isError = false,
): Carried {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "delegation_close",
		content: closed.content,
		details: closed.details,
		isError,
	};
}

/** What the provider sees of a carried message; request-only fields stay out of the comparison. */
const shape = ({ role, customType, content, details }: Carried) => ({ role, customType, content, details });

/** The durable processing inbox this parent session keeps. */
function inbox(s: Session): () => ChildOutcome[] {
	const path = join(agentDir, "squire", "child-tasks", `${encodeURIComponent(s.parent)}.json`);
	return () => (JSON.parse(readFileSync(path, "utf8")) as { state: { outcomes: ChildOutcome[] } }).state.outcomes;
}

const CLOSE_CALL: Carried = {
	role: "assistant",
	content: [{ type: "toolCall", id: "call-close", name: "delegation_close", arguments: {} }],
};

test("a tool close is its own receipt: the next request extends the first, with no notice and no wake", async () => {
	const s = session();
	const { id } = await delegation(s);
	const closed = await s.toolCall("delegation_close", { id });
	assert.equal((closed.structuredContent as { closed?: boolean }).closed, true, "the close completed");
	assert.deepEqual(s.sent, [], "the tool result is the only close message");
	const queued = inbox(s);
	assert.equal(queued()[0]?.key, `closed:${id}`, "the close keeps one durable processing obligation");
	assert.equal(queued()[0]?.delivered, undefined, "the tool result carries it, not a custom message");

	const user: Carried = { role: "user", content: "q" };
	const call: Carried = {
		...CLOSE_CALL,
		content: [{ type: "toolCall", id: "call-close", name: "delegation_close", arguments: { id } }],
	};
	const receipt = closeReceipt(closed, "call-close");
	const first = await pipeline(s, [user, call, receipt]).request();
	assert.deepEqual(
		first.map(shape),
		[user, call, receipt].map(shape),
		"the request adds nothing to the saved transcript",
	);

	const reply: Carried = { role: "assistant", content: [{ type: "text", text: "closed it" }] };
	const file: Carried = {
		role: "toolResult",
		toolCallId: "call-read",
		toolName: "read",
		content: [{ type: "text", text: "file" }],
		isError: false,
	};
	const second = await pipeline(s, [user, call, receipt, reply, file]).request();
	assert.deepEqual(
		second.slice(0, first.length).map(shape),
		first.map(shape),
		"the second request begins with every message of the first, in order",
	);
	assert.deepEqual(second.map(shape).slice(2, 3), first.map(shape).slice(2, 3), "the close report keeps its index");
	assert.equal(second.length, first.length + 2, "the request adds no copy of its own");
	assert.equal(
		second.some((message) => message.customType === "delegate"),
		false,
		"no custom cancellation copy",
	);

	// The model read the receipt in the second request, so settlement acknowledges it.
	await s.fire("agent_start");
	await pipeline(s, second).request();
	await s.fire("agent_end", TURN);
	await s.fire("agent_before_settle", { entries: [], continue: false });
	await s.fire("agent_settled");
	assert.deepEqual(queued(), [], "the receipt acknowledges the obligation");
	assert.deepEqual(s.sent, [], "still no notice and no wake");
	const third = await pipeline(s, second).request();
	assert.deepEqual(third.slice(0, second.length).map(shape), second.map(shape), "a later request extends it again");
	assert.deepEqual(third.map(shape).slice(2, 3), first.map(shape).slice(2, 3), "the original tool result is unchanged");
});

test("an outcome its projection lost is written again, hidden, and the retries are bounded", async () => {
	const s = session();
	const { id } = await delegation(s);
	await s.toolCall("delegation_close", { id });
	const queued = inbox(s);
	const settle = async (contextMessages: Carried[]) => {
		const results = await s.fire("agent_before_settle", {
			entries: [],
			continue: false,
			context: { contextMessages, canContinue: true },
		});
		return results.find((value) => value !== undefined) as
			| {
					continue?: boolean;
					entries?: { customType: string; content: unknown; details?: unknown; display?: boolean }[];
			  }
			| undefined;
	};

	// Pi compaction dropped the tool result before any request carried it: write
	// the cancellation into what is left of the transcript.
	const first = await settle([]);
	assert.equal(first?.continue, true);
	assert.equal(first?.entries?.length, 1);
	assert.equal(first?.entries?.[0]?.display, true, "the first write is shown");
	assert.equal((first?.entries?.[0]?.details as { id?: string } | undefined)?.id, id);

	// The same projection again: the model has still not read it, and the copy
	// it was shown once is not shown twice.
	const second = await settle([]);
	assert.equal(second?.entries?.[0]?.display, false, "a rewrite stays hidden");

	// A projection that carries it needs no copy, only the request.
	const carried = { role: "custom" as const, customType: "delegate", content: "", details: queued()[0]?.details };
	const third = await settle([carried]);
	assert.deepEqual(third, { continue: true, entries: [] }, "the transcript carries it; no copy is written");

	// Bounded: an outcome no carrier ever delivers cannot hold the run forever.
	await settle([]);
	await settle([]);
	assert.equal(await settle([]), undefined, "the settle boundary stops asking after bounded attempts");
});

test("a crash before Pi saved the close tool result writes one cancellation on reopen", async () => {
	const s = session();
	const { id } = await delegation(s);
	await s.toolCall("delegation_close", { id });
	assert.deepEqual(s.sent, [], "the live close stayed silent");
	const queued = inbox(s);
	assert.equal(queued()[0]?.key, `closed:${id}`, "the obligation is durable before anything is written");
	assert.equal(queued()[0]?.delivered, undefined);
	// Pi died before it saved the tool result: the branch has the call but no result.
	await s.shutdown();
	const reopened = session({ parent: s.parent, entries: s.entries });
	await reopened.start();
	await nextTurn();
	const written = reopened.sent.filter(({ message }) => message.customType === "delegate");
	assert.equal(written.length, 1, "one cancellation copy, written once");
	assert.match(String(written[0].message.content), /canceled by explicit close/);
	assert.equal((written[0].message as { details?: { id?: string } }).details?.id, id);
	assert.deepEqual(written[0].options, { triggerTurn: false }, "the copy is saved, not steered into a run");
	const wake = reopened.sent.filter(({ message }) => message.customType === "delegate-recovery");
	assert.equal(wake.length, 1, "one wake asks for the processing run");
	assert.deepEqual(wake[0].options, { triggerTurn: true, deliverAs: "steer" });
	const transcript = reopened.sent.map(({ message }) => ({ role: "custom", ...message }));
	assert.equal(copies(transcript).count, 0, "the cancellation body is not the result marker");

	await reopened.fire("agent_start");
	const request = await pipeline(reopened).request();
	assert.deepEqual(request.map(shape), transcript.map(shape), "the request carries the saved copy and adds nothing");
	await reopened.fire("agent_end", TURN);
	await reopened.fire("agent_before_settle", { entries: [], continue: false });
	await reopened.fire("agent_settled");
	assert.deepEqual(inbox(reopened)(), [], "processing acknowledges the recovered cancellation");
	await reopened.shutdown();

	const again = session({ parent: s.parent, entries: reopened.entries, messages: transcript });
	await again.start();
	await nextTurn();
	assert.deepEqual(again.sent, [], "a second reopen writes and wakes nothing");
	assert.deepEqual(
		(await pipeline(again, transcript).request()).map(shape),
		transcript.map(shape),
		"and its request still carries the one saved copy",
	);
});

test("a partial close whose direct child is confirmed still covers that child's outcome", async (t) => {
	const active: Session[] = [];
	const instance = (options: Parameters<typeof mailSession>[0] = {}): Session => {
		const created = mailSession(options);
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
	const tmux = new FakeTmux();
	const owner = instance({ tmux });
	await owner.start();
	const child = (await owner.toolCall("delegate", { agent: "coordinator", task: "coordinate" })).structuredContent as {
		id: string;
		windowId: string;
	};
	const coordinator = instance({ parent: child.id, tmux });
	await coordinator.start();
	scan(coordinator);
	const worker = (await coordinator.toolCall("delegate", { agent: "worker", task: "look into it" }))
		.structuredContent as {
		id: string;
		windowId: string;
	};
	const kill = tmux.kill.bind(tmux);
	tmux.kill = async (id) => {
		if (id === worker.windowId) throw new Error("injected worker failure");
		await kill(id);
	};
	const closed = await owner.toolCall("delegation_close", { id: child.id });
	assert.deepEqual((closed as { isError?: boolean }).isError, true, "the operation is partial");
	const details = closed.structuredContent as { closed: boolean; complete: boolean };
	assert.equal(details.closed, false);
	assert.equal(details.complete, false);
	assert.deepEqual(owner.sent, [], "the tool result is the only close message");
	const queued = inbox(owner);
	assert.equal(queued()[0]?.key, `closed:${child.id}`, "the confirmed direct child keeps its obligation");

	const reply: Carried = { role: "assistant", content: [{ type: "text", text: "partial" }] };
	const second = await pipeline(owner, [CLOSE_CALL, closeReceipt(closed, "call-close", true), reply]).request();
	assert.equal(
		second.some((message) => message.customType === "delegate"),
		false,
		"the confirmed row is the receipt",
	);
	await owner.fire("agent_start");
	await pipeline(owner, second).request();
	await owner.fire("agent_end", TURN);
	await owner.fire("agent_before_settle", { entries: [], continue: false });
	await owner.fire("agent_settled");
	assert.deepEqual(queued(), [], "the confirmed row acknowledges the obligation");
});

/**
 * A tool shaped like codemode: one script call whose model-visible result is
 * only what the script returned. `delegation_close` runs through
 * `ctx.executeTool`, so its own result never enters the transcript.
 */
function scriptTool() {
	return {
		name: "script",
		label: "Run a script",
		description: "Runs one script that may close a delegation.",
		parameters: Type.Object({ id: Type.String(), fail: Type.Optional(Type.Boolean()) }),
		outputSchema: Type.Object({
			calls: Type.Array(Type.Object({ name: Type.String(), status: Type.String() })),
		}),
		async execute(
			_toolCallId: string,
			params: { id: string; fail?: boolean },
			_signal: unknown,
			_onUpdate: unknown,
			ctx: { executeTool: (name: string, input: unknown) => Promise<{ isError: boolean }> },
		) {
			const closed = await ctx.executeTool("delegation_close", { id: params.id });
			const calls = [{ name: "delegation_close", status: closed.isError ? "error" : "ok" }];
			return {
				content: [{ type: "text" as const, text: `script output: ${JSON.stringify(calls)}` }],
				details: { calls },
				structuredContent: { calls },
				...(params.fail ? { isError: true } : {}),
			};
		},
	};
}

/** A parent that can run such a script, with `delegation_close` callable inside it. */
function scripted(options: Parameters<typeof session>[0] = {}): Session {
	const tool = scriptTool();
	return session({
		...options,
		nestedTools: ["delegation_close"],
		beforeSquire: (pi) => pi.registerTool(tool as never),
	});
}

/** The text one tool result showed the model. */
const body = (result: { content: { type: string; text: string }[] }): string =>
	result.content.map((item) => item.text).join("\n");

/** The namespaced receipt a nested close leaves on the result of the call that made it. */
type Receipt = { text: string; closed: string[] };
const receipts = (result: { details: unknown }): Receipt[] =>
	((result.details as { squireClose?: Receipt[] } | undefined)?.squireClose ?? []).slice();

/** The messages a tool result and its call add to the transcript. */
function scriptedClose(id: string, result: { content: { type: string; text: string }[]; details: unknown }) {
	const call: Carried = {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-script", name: "script", arguments: { id } }],
	};
	const reply: Carried = {
		role: "toolResult",
		toolCallId: "call-script",
		toolName: "script",
		content: result.content,
		details: result.details,
		isError: false,
	};
	return { call, reply };
}

test("a close a script made is reported in that script's tool result, with no notice and no wake", async () => {
	const s = scripted();
	const { id } = await delegation(s);
	const outer = await s.toolCall("script", { id });
	const shown = body(outer);
	assert.ok(shown.startsWith("script output:"), "the script's own output is preserved");
	assert.ok(shown.includes("Close report for the delegation_close this tool called:"));
	assert.ok(shown.includes(`- ${id}: killed`), "the report names the member it confirmed");
	assert.deepEqual(s.sent, [], "the enclosing result is the only close message");
	const queued = inbox(s);
	assert.equal(queued()[0]?.key, `closed:${id}`, "the close keeps one durable processing obligation");
	assert.equal(queued()[0]?.delivered, undefined, "the enclosing result carries it, not a custom message");
	const [receipt, ...more] = receipts(outer);
	assert.ok(receipt, "the result carries the namespaced receipt");
	assert.deepEqual(more, [], "one receipt per nested close");
	assert.deepEqual(receipt.closed, [id], "the receipt names the confirmed member");
	assert.ok(shown.includes(receipt.text), "the receipt matches the report the model can read");

	const user: Carried = { role: "user", content: "q" };
	const { call, reply } = scriptedClose(id, outer);
	const first = await pipeline(s, [user, call, reply]).request();
	assert.deepEqual(
		first.map(shape),
		[user, call, reply].map(shape),
		"the request adds nothing to the saved transcript",
	);
	assert.equal(
		first.some((message) => message.customType === "delegate"),
		false,
		"no custom cancellation copy",
	);

	// The model read the receipt in that request, so settlement acknowledges it.
	await s.fire("agent_start");
	await pipeline(s, [user, call, reply]).request();
	await s.fire("agent_end", TURN);
	const settle = await s.fire("agent_before_settle", { entries: [], continue: false });
	assert.ok(
		settle.every((value) => value === undefined),
		"the receipt needs no continuation and no rewrite",
	);
	await s.fire("agent_settled");
	assert.deepEqual(queued(), [], "the receipt acknowledges the obligation");
	assert.deepEqual(s.sent, [], "still no notice and no wake");

	const answer: Carried = { role: "assistant", content: [{ type: "text", text: "closed it" }] };
	const second = await pipeline(s, [user, call, reply, answer]).request();
	assert.deepEqual(
		second.slice(0, first.length).map(shape),
		first.map(shape),
		"the next request begins with every message of the first, in order",
	);
	assert.deepEqual(second.map(shape).slice(2, 3), first.map(shape).slice(2, 3), "the report keeps its index");
});

test("a script that fails after the close still reports it in its tool result", async () => {
	const s = scripted();
	const { id } = await delegation(s);
	const outer = await s.toolCall("script", { id, fail: true });
	assert.equal(outer.isError, true, "the script failed");
	assert.ok(body(outer).includes(`- ${id}: killed`), "the report survives the script failure");
	assert.equal(receipts(outer).length, 1);
	assert.deepEqual(s.sent, [], "the enclosing result is the only close message");
	const queued = inbox(s);
	assert.equal(queued()[0]?.key, `closed:${id}`, "the confirmed close keeps its obligation");

	const user: Carried = { role: "user", content: "q" };
	const { call, reply } = scriptedClose(id, outer);
	await s.fire("agent_start");
	const request = await pipeline(s, [user, call, reply]).request();
	assert.ok(request.some((message) => text(message).includes("Close report for the delegation_close")));
	await s.fire("agent_end", TURN);
	await s.fire("agent_before_settle", { entries: [], continue: false });
	await s.fire("agent_settled");
	assert.deepEqual(queued(), [], "the failed script's result still acknowledges the obligation");
	assert.deepEqual(s.sent, [], "no notice and no wake");
});

test("a reopened session carries a nested close from its saved outer result, without a second body", async () => {
	const s = scripted();
	const { id } = await delegation(s);
	const outer = await s.toolCall("script", { id });
	assert.deepEqual(s.sent, [], "the live close stayed silent");
	const user: Carried = { role: "user", content: "q" };
	const { call, reply } = scriptedClose(id, outer);
	await s.shutdown();

	// Pi saved the enriched result: the branch already shows the report.
	const reopened = session({ parent: s.parent, entries: s.entries, messages: [user, call, reply] });
	await reopened.start();
	await nextTurn();
	assert.deepEqual(
		reopened.sent.filter(({ message }) => message.customType === "delegate"),
		[],
		"the saved receipt is the one report",
	);
	const wakes = reopened.sent.filter(({ message }) => message.customType === "delegate-recovery");
	assert.equal(wakes.length, 1, "reopening still asks for the processing run");
	assert.equal(wakes[0].message.display, false);

	const carried: Carried[] = [
		user,
		call,
		reply,
		...reopened.sent.map(({ message }) => ({ role: "custom", ...message })),
	];
	const request = await pipeline(reopened, [user, call, reply]).request();
	assert.deepEqual(request.map(shape), carried.map(shape), "the request carries the saved receipt and adds nothing");
	await reopened.fire("agent_start");
	await pipeline(reopened, [user, call, reply]).request();
	await reopened.fire("agent_end", TURN);
	await reopened.fire("agent_before_settle", { entries: [], continue: false });
	await reopened.fire("agent_settled");
	assert.deepEqual(inbox(reopened)(), [], "processing acknowledges the restored receipt");
	await reopened.shutdown();
});

test("a nested close whose enclosing result Pi never saved is written once on reopen", async () => {
	const s = scripted();
	const { id } = await delegation(s);
	await s.toolCall("script", { id });
	assert.deepEqual(s.sent, [], "the live close stayed silent");
	assert.equal(inbox(s)()[0]?.key, `closed:${id}`, "the obligation is durable before anything is written");
	// Pi died before it saved the script's result: the branch has the call but no result.
	await s.shutdown();
	const reopened = session({ parent: s.parent, entries: s.entries });
	await reopened.start();
	await nextTurn();
	const written = reopened.sent.filter(({ message }) => message.customType === "delegate");
	assert.equal(written.length, 1, "one cancellation copy, written once");
	assert.match(String(written[0].message.content), /canceled by explicit close/);
	assert.deepEqual(written[0].options, { triggerTurn: false }, "the copy is saved, not steered into a run");
	const wakes = reopened.sent.filter(({ message }) => message.customType === "delegate-recovery");
	assert.equal(wakes.length, 1, "one wake asks for the processing run");

	await reopened.fire("agent_start");
	const request = await pipeline(reopened).request();
	assert.ok(request.some((message) => text(message).includes("canceled by explicit close")));
	await reopened.fire("agent_end", TURN);
	await reopened.fire("agent_before_settle", { entries: [], continue: false });
	await reopened.fire("agent_settled");
	assert.deepEqual(inbox(reopened)(), [], "processing acknowledges the recovered cancellation");
	await reopened.shutdown();

	const again = session({ parent: s.parent, entries: reopened.entries, messages: request });
	await again.start();
	await nextTurn();
	assert.deepEqual(again.sent, [], "a second reopen writes and wakes nothing");
});

for (const transcriptPresent of [true, false]) {
	test(
		transcriptPresent
			? "an aborted coordinator reopens with one transcript result across startup replay and the next steering turn"
			: "a coordinator recovers a queued delivered outcome missing from its restored transcript",
		async (t) => {
			const active: Session[] = [];
			const instance = (options: Parameters<typeof mailSession>[0] = {}): Session => {
				const created = mailSession(options);
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
			const coordinator = instance({ parent: root.entries[0].data.id as string });
			await coordinator.start();
			scan(coordinator);
			assert.ok(coordinator.pi.getActiveTools().includes("delegate"));
			await coordinator.toolCall("delegate", { agent: "worker", task: "look into it" });
			const worker = instance({ parent: coordinator.entries[0].data.id as string });
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

			const reopened = instance({ parent: coordinator.parent, messages: transcript });
			const resumed = pipeline(reopened, transcript);
			await reopened.start();
			scan(reopened);
			// Startup replay runs on setImmediate: one saved copy or one new copy,
			// then one wake. Nothing is appended to a request.
			await nextTurn();
			const written = reopened.sent.filter(({ message }) => message.customType === "delegate");
			const replay = reopened.sent.find(({ message }) => message.customType === "delegate-recovery");
			assert.ok(replay, "startup recovery must wake even an idle coordinator");
			assert.deepEqual(replay.options, { triggerTurn: true, deliverAs: "steer" });
			assert.equal(replay.message.display, false);
			assert.equal(fullCopies([{ role: "custom", ...replay.message }]), 0, "wake carries no full result");
			assert.equal(written.length, transcriptPresent ? 0 : 1, "the missing result is written once");
			if (!transcriptPresent) assert.deepEqual(written[0].options, { triggerTurn: false });
			await reopened.fire("agent_start");
			assert.equal(fullCopies(await resumed.request()), 1, "first resumed request");
			const steady = await resumed.request();
			assert.deepEqual(steady, await resumed.request(), "a repeated request adds nothing");
			await reopened.fire("agent_end", TURN);
			resumed.commit(await reopened.fire("agent_before_settle", { entries: [], continue: false }));
			assert.equal(fullCopies(await resumed.request()), 1, "the following request carries the same one copy");
			assert.equal(fullCopies(resumed.transcript()), 1, "exactly one full result is persisted");
			assert.equal(
				resumed
					.transcript()
					.filter((message) => (message.details as ChildOutcome["details"] | undefined)?.id === saved.details.id)
					.length,
				1,
				"one result-bearing transcript entry",
			);
			await reopened.fire("agent_end", TURN);
			resumed.commit(await reopened.fire("agent_before_settle", { entries: [], continue: false }));
			await reopened.fire("agent_settled", { aborted: false });
			assert.deepEqual(outcomes(), [], "normal processing acknowledges the saved outcome");
			assert.equal(finals().length, 1, "recovery unblocks completion");
			assert.equal(finals()[0].status, "done");
			await reopened.shutdown();

			const again = instance({ parent: coordinator.parent, messages: resumed.transcript() });
			const settled = pipeline(again, resumed.transcript());
			await again.start();
			scan(again);
			await nextTurn();
			assert.equal(again.sent.length, 0, "a second reopen resends and wakes nothing");
			assert.equal(fullCopies(await settled.request()), 1, "the one saved copy is still the whole delivery");
			assert.equal(finals().length, 1, "the parent task is answered only once");
		},
	);
}
