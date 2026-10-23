// The model a delegation finished on, read from the delegate's session file when
// its result arrives, and the structured details the result and gone messages
// carry for the renderer. Driven through the harness: a fake delegate session
// file in the session directory and a reply on `message:inbound`.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { after, beforeEach, test } from "node:test";

import { agentFile, cleanup, resetRoot, session, sessionDir, writeAgent } from "./harness.ts";

beforeEach(() => resetRoot());
after(() => cleanup());

type Session = ReturnType<typeof session>;

async function started(entries?: Session["entries"]) {
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
	const s = session(entries === undefined ? {} : { entries });
	await s.start();
	if (entries === undefined) await s.delegate("scout look into it");
	return s;
}

const delegationId = (s: Session) => (s.entries[0].data as { id: string }).id;
const requestId = (s: Session) => (s.sendCalls[0].envelope as { id: string }).id;

/** A delegate session file whose lines are `lines`, as JSON. */
function writeDelegateSession(s: Session, lines: unknown[]): string {
	mkdirSync(sessionDir, { recursive: true });
	const file = join(sessionDir, `20260929T000000_${delegationId(s)}.jsonl`);
	writeFileSync(file, lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n"));
	return file;
}

const assistant = (provider: string, model: string) => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text: "hi" }], provider, model },
});

function deliver(s: Session, status = "done", body = "the answer") {
	s.events.emit("message:inbound", {
		envelope: {
			id: `reply-${status}`,
			from: delegationId(s),
			to: s.parent,
			in_reply_to: [requestId(s)],
			status,
			ts: "",
			body,
		},
		path: "/mail/cur/reply.json",
		requests: [],
		handled: false,
	});
}

const resultMessage = (s: Session) => {
	const found = s.sent.find((m) => /^\[delegate\] Result from/.test(String(m.message.content)));
	assert.ok(found, "a result message was sent");
	return found.message as { content: string; details?: Record<string, unknown> };
};
const firstLine = (s: Session) => resultMessage(s).content.split("\n")[0];
const statusTool = (s: Session) => s.toolCall("delegation_status", {});

test("a delegate that finished on another model is named launched → finished in the text, details and status", async () => {
	const s = await started();
	writeDelegateSession(s, [
		{ type: "session", id: delegationId(s) },
		assistant("alpha", "fast-model"),
		{ type: "model_change", provider: "beta", modelId: "slow-model" },
		assistant("beta", "slow-model"),
		{ type: "message", message: { role: "user", content: "later" } },
	]);
	deliver(s);
	assert.equal(
		firstLine(s),
		`[delegate] Result from scout (alpha/fast-model → beta/slow-model), delegation ${delegationId(s)}, request ${requestId(s)}.`,
	);
	const details = resultMessage(s).details;
	assert.equal(details?.model, "alpha/fast-model");
	assert.equal(details?.finishedModel, "beta/slow-model");
	const status = await statusTool(s);
	assert.match(status.content[0].text, /scout \(alpha\/fast-model → beta\/slow-model, thinking low\)/);
	const delegation = (status.details as { delegations: Record<string, unknown>[] }).delegations[0];
	assert.equal(delegation.model, "alpha/fast-model");
	assert.equal(delegation.finishedModel, "beta/slow-model");
});

test("the finishing model survives a resume", async () => {
	const s = await started();
	writeDelegateSession(s, [assistant("beta", "slow-model")]);
	deliver(s);
	const resumed = await started(s.entries);
	assert.match((await statusTool(resumed)).content[0].text, /alpha\/fast-model → beta\/slow-model/);
});

test("a delegate that finished on its launch model shows the launch model alone", async () => {
	const s = await started();
	writeDelegateSession(s, [assistant("alpha", "fast-model")]);
	deliver(s);
	assert.match(firstLine(s), /^\[delegate\] Result from scout \(alpha\/fast-model\), delegation/);
	assert.match((await statusTool(s)).content[0].text, /scout \(alpha\/fast-model, thinking low\)/);
});

test("with no session file, or one with no assistant message or bad lines, the launch model shows alone", async (t: TestContext) => {
	await t.test("no file", async () => {
		const s = await started();
		deliver(s);
		assert.match(firstLine(s), /\(alpha\/fast-model\), delegation/);
		assert.equal(resultMessage(s).details?.finishedModel, undefined);
	});
	await t.test("no assistant message, one unparseable line", async () => {
		resetRoot();
		const s = await started();
		writeDelegateSession(s, ["{not json", { type: "message", message: { role: "user", content: "x" } }]);
		deliver(s);
		assert.match(firstLine(s), /\(alpha\/fast-model\), delegation/);
	});
});

test("a bad line after the last assistant message does not hide it", async () => {
	const s = await started();
	writeDelegateSession(s, [assistant("beta", "slow-model"), "{truncated"]);
	deliver(s);
	assert.match(firstLine(s), /\(alpha\/fast-model → beta\/slow-model\)/);
});

test("a result message carries the details its view is drawn from", async () => {
	const s = await started();
	const file = writeDelegateSession(s, [assistant("alpha", "fast-model")]);
	deliver(s, "failed", "line one\nline two");
	assert.deepEqual(resultMessage(s).details, {
		kind: "result",
		status: "failed",
		name: `scout-${delegationId(s).slice(0, 8)}`,
		agent: "scout",
		model: "alpha/fast-model",
		finishedModel: "alpha/fast-model",
		id: delegationId(s),
		requestId: requestId(s),
		envelopePath: "/mail/cur/reply.json",
		sessionPath: file,
		task: { note: `[delegate] The task ${requestId(s)} has no copy in sent/; only its id is known.` },
		body: "line one\nline two",
	});
});

test("a gone message carries details of kind gone with the finishing model", async (t: TestContext) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const s = await started();
	writeDelegateSession(s, [assistant("beta", "slow-model")]);
	s.tmux.windows.clear();
	for (let i = 0; i < 4; i++) {
		t.mock.timers.tick(5000);
		for (let j = 0; j < 3; j++) await new Promise((resolve) => setImmediate(resolve));
	}
	const gone = s.sent.find((m) => /closed without a result/.test(String(m.message.content)));
	assert.ok(gone);
	const message = gone.message as { content: string; details?: Record<string, unknown> };
	assert.match(message.content, /\(scout, alpha\/fast-model → beta\/slow-model\)/);
	assert.equal(message.details?.kind, "gone");
	assert.equal(message.details?.finishedModel, "beta/slow-model");
	assert.equal(message.details?.name, `scout-${delegationId(s).slice(0, 8)}`);
});
