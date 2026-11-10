// Feature tests on the in-memory host: start and lifecycle behaviour that is
// not about tmux, asserted through host-neutral state instead of tmux argv.
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import type { StartedRecorded } from "../src/results.ts";
import { agentFile, cleanup, memorySession, resetRoot, writeAgent } from "./harness.ts";
import { MemoryHost } from "./memory-host.ts";

beforeEach(() => {
	resetRoot();
	writeAgent("scout", agentFile({ model: "alpha/fast-model", thinking: "low", auto_exit: "false" }));
});
after(cleanup);

function lastRecord(s: ReturnType<typeof memorySession>): StartedRecorded | undefined {
	return s.entries.findLast((entry) => entry.customType === "delegate-start-v2")?.data as StartedRecorded | undefined;
}

test("a launch starts one delegate the host reports running, in the parent's directory", async () => {
	const s = memorySession();
	try {
		await s.toolCall("delegate", { agent: "scout", task: "look" });
		assert.equal(s.host.started.length, 1);
		const record = lastRecord(s);
		assert.ok(record);
		assert.equal((await s.host.states()).state(record), "running");
		assert.equal(s.host.started[0].cwd, record.cwd);
		assert.equal(s.host.started[0].env.PI_DELEGATE_MULTIPLEXER, "memory");
	} finally {
		await s.shutdown();
	}
});

test("delegation_close closes the delegate through the host, and a second close is a no-op", async () => {
	const s = memorySession();
	try {
		await s.toolCall("delegate", { agent: "scout", task: "look" });
		const record = lastRecord(s);
		assert.ok(record);
		await s.toolCall("delegation_close", { id: record.id });
		assert.deepEqual(s.host.closed, [s.host.started[0].id]);
		assert.equal((await s.host.states()).state(record), "gone");
		await s.toolCall("delegation_close", { id: record.id });
		assert.deepEqual(s.host.closed, [s.host.started[0].id]);
	} finally {
		await s.shutdown();
	}
});

test("a pane-free host's configure failure leaves nothing open and records no start", async () => {
	const host = new MemoryHost("pane-free");
	host.failConfigure = "configuration refused";
	const s = memorySession({ host });
	try {
		await assert.rejects(s.toolCall("delegate", { agent: "scout", task: "look" }), /configuration refused/);
		assert.equal(host.started.length, 1, "the host opened before configuring");
		assert.equal(host.terminals.size, 0, "rollback closed it");
		assert.equal(lastRecord(s), undefined);
		assert.equal(s.sent.length, 0, "no task was mailed to an unconfigured delegate");
	} finally {
		await s.shutdown();
	}
});

test("a pane-free host's refused rollback after failed mail is reported with the host's advice", async () => {
	const host = new MemoryHost("pane-free");
	host.failClose = true;
	const s = memorySession({ host, send: "error" });
	try {
		await assert.rejects(
			s.toolCall("delegate", { agent: "scout", task: "look" }),
			/could not send the task.*memory window @1 could not be closed/,
		);
		assert.equal(host.terminals.size, 1, "the refused close left it running, and said so");
		assert.equal(lastRecord(s), undefined);
	} finally {
		await s.shutdown();
	}
});
