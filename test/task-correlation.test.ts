import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, test } from "node:test";
import { cleanup, type Entry } from "./harness.ts";
import { envelopes, mailSession, request, scan } from "./mail-harness.ts";

const active: ReturnType<typeof mailSession>[] = [];
afterEach(async () => {
	for (const s of active.splice(0)) await s.shutdown();
});
after(() => cleanup());

test("every correlation id is completed, including when an earlier id already has a result; fresh-envelope duplicates stay silent", async () => {
	const parentId = randomUUID();
	const childId = randomUUID();
	const parent = mailSession({ parent: parentId });
	const child = mailSession({ parent: childId, parentEnv: parentId, autoExitEnv: "0" });
	active.push(parent, child);
	await parent.start();
	await child.start();
	const tasks = Array.from({ length: 4 }, () => request(parent, childId));
	const starts: Entry[] = tasks.map((task, index) => ({
		customType: "delegate",
		data: {
			id: `delegation-${index}`,
			agent: "scout",
			model: "alpha/fast-model",
			thinking: "low",
			windowId: `@${index}`,
			windowName: "scout",
			requestId: task.id,
			sessionId: childId,
		},
	}));
	const historical = { status: "done", replyId: "first-reply", envelopePath: "somewhere" };
	parent.entries.push(...starts, { customType: "delegate", data: { id: "delegation-0", result: historical } });
	// Rebuild the parent's persisted records before the real transport reply.
	await parent.fire("session_start", { reason: "reload" });
	scan(child);
	await child.run();
	scan(parent);
	const results = parent.entries.filter((entry) => entry.data.result !== undefined);
	assert.equal(results.length, 4, "one old result plus all three newly correlated records");
	assert.equal(parent.sent.filter((sent) => sent.message.customType === "delegate").length, 1);
	const duplicate = {
		to: parentId,
		inReplyTo: tasks.map((task) => task.id),
		body: "answer",
		status: "done",
		envelope: undefined,
	};
	child.events.emit("message:reply", duplicate);
	assert.ok(duplicate.envelope);
	scan(parent);
	assert.equal(envelopes(parentId, "cur").length, 2);
	assert.equal(parent.sent.filter((sent) => sent.message.customType === "delegate").length, 1);
	await parent.shutdown();
	const reopened = mailSession({ parent: parentId, entries: parent.entries });
	active.push(reopened);
	await reopened.start();
	child.events.emit("message:reply", { ...duplicate, envelope: undefined });
	scan(reopened);
	assert.equal(reopened.sent.length, 0, "all ids restored as answered, not only the first");
});
