// A host may assign the delegate's Pi session id itself, as Paseo does with
// its agent's own session. Everything the start publishes afterwards must use
// that id: the task mail, the recorded delegation and the identity record. A
// host that keeps its delegates open also turns auto-exit off for them.
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { readIdentity } from "../src/identity.ts";
import type { StartedRecorded } from "../src/results.ts";
import { agentFile, cleanup, memorySession, resetRoot, writeAgent } from "./harness.ts";
import { MemoryHost } from "./memory-host.ts";

/** A fixed UUID that no delegation id can collide with. */
const ASSIGNED = "0f6d2c1e-8a4b-4c3d-9e2f-7a5b1c0d3e46";

beforeEach(() => {
	resetRoot();
	writeAgent("scout", agentFile({ model: "alpha/fast-model", thinking: "low", auto_exit: "true" }));
});
after(cleanup);

function lastRecord(s: ReturnType<typeof memorySession>): StartedRecorded | undefined {
	return s.entries.findLast((entry) => entry.customType === "delegate-start-v2")?.data as StartedRecorded | undefined;
}

/** One launch on a pane-free host, with the assigned id and open policy the case needs. */
async function launch(options: { assign?: string; keepsOpen?: boolean } = {}) {
	const host = new MemoryHost("pane-free");
	host.assignSessionId = options.assign;
	host.keepsDelegatesOpen = options.keepsOpen;
	const s = memorySession({ host });
	await s.toolCall("delegate", { agent: "scout", task: "look" });
	const record = lastRecord(s);
	assert.ok(record, "the delegation was recorded");
	return { s, host, record };
}

test("the task mail goes to the session id the host assigned", async () => {
	const { s, record } = await launch({ assign: ASSIGNED });
	try {
		assert.notEqual(record.id, ASSIGNED, "the delegation id is not the assigned session id");
		assert.equal(s.sendCalls.length, 1, "one task mail was sent");
		assert.equal(s.sendCalls[0].to, ASSIGNED);
	} finally {
		await s.shutdown();
	}
});

test("the recorded delegation carries the assigned session id", async () => {
	const { s, record } = await launch({ assign: ASSIGNED });
	try {
		assert.equal(record.sessionId, ASSIGNED);
	} finally {
		await s.shutdown();
	}
});

test("identity is filed under the delegation id and under the assigned session id", async () => {
	const { s, record } = await launch({ assign: ASSIGNED });
	try {
		assert.ok(readIdentity(record.id), "the requested id keeps its identity record");
		assert.ok(readIdentity(ASSIGNED), "the assigned id gets an identity record");
	} finally {
		await s.shutdown();
	}
});

test("a host that keeps its delegates open turns auto-exit off", async () => {
	const { s, host } = await launch({ assign: ASSIGNED, keepsOpen: true });
	try {
		assert.equal(host.started.length, 1);
		assert.equal(host.started[0].env.PI_DELEGATE_AUTO_EXIT, "0");
	} finally {
		await s.shutdown();
	}
});

test("without an assigned session id the delegation id is used, as today", async () => {
	const { s, record } = await launch();
	try {
		assert.equal(s.sendCalls.length, 1, "one task mail was sent");
		assert.equal(s.sendCalls[0].to, record.id);
		assert.equal("sessionId" in record, false, "the record names no separate session id");
	} finally {
		await s.shutdown();
	}
});
