import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { NO_ANSWER, TOOK_OVER, UNSEEN } from "../src/task-settlement.ts";
import { taskStatePath } from "../src/task-store.ts";
import { agentFile, cleanup, root, type SessionOptions, sessionDir, writeAgent } from "./harness.ts";
import { envelopes, mailSession, nextTurn, request, scan } from "./mail-harness.ts";

const active: ReturnType<typeof mailSession>[] = [];
function instance(options: SessionOptions = {}): ReturnType<typeof mailSession> {
	const created = mailSession(options);
	active.push(created);
	return created;
}
afterEach(async () => {
	for (const s of active.splice(0)) await s.shutdown();
});
after(() => cleanup());

async function pair(autoExitEnv = "0", fallbackEnv?: string) {
	const parent = instance();
	await parent.start();
	const child = instance({ parentEnv: parent.parent, autoExitEnv, fallbackEnv });
	await child.start();
	const task = request(parent, child.parent);
	scan(child);
	return { parent, child, task };
}

test("real 0.6.0 provider receives exact explicit correlation and status before leaf exit", async () => {
	const { parent, child, task } = await pair("1");
	assert.equal(child.userMessages.length, 1);
	await child.run();
	scan(parent);
	const reply = envelopes(parent.parent, "cur").find((mail) => mail.in_reply_to.includes(task.id));
	assert.ok(reply);
	assert.deepEqual(reply.in_reply_to, [task.id]);
	assert.equal(reply.body, "answer");
	assert.equal(reply.status, "done");
	assert.equal(child.shutdowns(), 1);
	assert.deepEqual(JSON.parse(readFileSync(taskStatePath(child.parent), "utf8")).requests, []);
});

test("task delivery and reply also work when squire loads before the real provider", async () => {
	const parent = instance();
	await parent.start();
	const child = instance({ parentEnv: parent.parent, autoExitEnv: "1", mailProviderLast: true });
	const task = request(parent, child.parent);
	await child.start();
	await nextTurn();
	assert.equal(child.userMessages.length, 1, "waiting task is taken over after synchronous restoration");
	await child.run();
	scan(parent);
	assert.equal(envelopes(parent.parent, "cur").find((mail) => mail.in_reply_to.includes(task.id))?.body, "answer");
	assert.equal(child.shutdowns(), 1);
});

test("rearming auto-exit cannot discard a task held through a failed run", async () => {
	const { parent, child } = await pair("1");
	await child.run("aborted");
	await child.command("auto-exit");
	await child.run("error", { errorMessage: "failed while held" });
	assert.equal(child.shutdowns(), 0);
	assert.equal(envelopes(parent.parent, "new").length, 0);
	await child.run();
	assert.equal(child.shutdowns(), 1);
});

test("ordinary peer requests, parent messages and asks are not task-owned; asks still answer", async () => {
	const { parent, child, task } = await pair();
	const peer = instance();
	await peer.start();
	const ordinary = request(peer, child.parent);
	scan(child);
	await parent.toolCall("session_mail_send", { to: child.parent, message: "plain note" });
	scan(child);
	const pendingAsk = peer.toolCall("session_mail_ask", { to: child.parent, message: "question" });
	scan(child);
	await child.fire("message_end", { message: { role: "custom", ...child.sent.at(-1)?.message } });
	assert.equal(child.userMessages.length, 1, "only the parent's task is taken over");
	await child.run();
	scan(peer);
	const answer = await pendingAsk;
	assert.equal((answer.details as { outcome: string }).outcome, "answered");
	assert.equal((answer.details as { body: string }).body, "answer");
	scan(parent);
	assert.ok(envelopes(parent.parent, "cur").some((mail) => mail.in_reply_to.includes(task.id)));
	assert.equal(
		envelopes(peer.parent, "cur").some((mail) => mail.in_reply_to.includes(ordinary.id)),
		false,
	);
});

test("asks are still answered stopped immediately while the delegated task stays held", async () => {
	const { parent, child } = await pair("1");
	const asker = instance();
	await asker.start();
	const waiting = asker.toolCall("session_mail_ask", { to: child.parent, message: "a question" });
	scan(child);
	await child.fire("message_end", { message: { role: "custom", ...child.sent.at(-1)?.message } });
	await child.run("aborted");
	scan(asker);
	const result = await waiting;
	assert.equal((result.details as { status: string }).status, "stopped");
	assert.equal(envelopes(parent.parent, "new").length, 0);
	await child.run();
	scan(parent);
	assert.equal(envelopes(parent.parent, "cur")[0]?.body, `${TOOK_OVER}\n\nanswer`);
});

test("an explicit early ask answer is not repeated when squire settles its separate task", async () => {
	const { parent, child } = await pair();
	const waiting = parent.toolCall("session_mail_ask", { to: child.parent, message: "question for early answer" });
	scan(child);
	const ask = envelopes(child.parent, "cur").find((mail) => mail.body === "question for early answer");
	assert.ok(ask);
	await child.toolCall("session_mail_reply", { ask: ask.id, message: "early answer" });
	scan(parent);
	assert.equal(((await waiting).details as { body: string }).body, "early answer");
	await child.run();
	scan(parent);
	assert.equal(envelopes(parent.parent, "cur").filter((reply) => reply.in_reply_to.includes(ask.id)).length, 1);
});

for (const stop of ["aborted", "stopped"] as const) {
	test(`user ${stop} holds through failed runs and answers after success with takeover wording`, async () => {
		const { parent, child, task } = await pair("1");
		await child.run(stop);
		await child.run("error", { errorMessage: "bad request" });
		assert.equal(envelopes(parent.parent, "new").length, 0);
		assert.equal(child.shutdowns(), 0);
		await child.run();
		scan(parent);
		assert.equal(
			envelopes(parent.parent, "cur").find((mail) => mail.in_reply_to.includes(task.id))?.body,
			`${TOOK_OVER}\n\nanswer`,
		);
	});
}

test("failure preserves partial text and old error punctuation; a no-text success uses old wording", async () => {
	const { parent, child } = await pair();
	await child.fire("agent_end", {
		messages: [
			{ role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "toolUse" },
			{ role: "assistant", content: [], stopReason: "error", errorMessage: " broken... " },
		],
	});
	await child.fire("agent_settled");
	scan(parent);
	assert.equal(
		envelopes(parent.parent, "cur")[0]?.body,
		"(The run ended on an error before it finished: broken. The text that follows, if any, is partial.)\n\npartial",
	);
	request(parent, child.parent);
	scan(child);
	await child.fire("agent_end", { messages: [{ role: "assistant", content: [], stopReason: "stop" }] });
	await child.fire("agent_settled");
	scan(parent);
	assert.ok(envelopes(parent.parent, "cur").some((mail) => mail.body === NO_ANSWER));
});

test("fallback continues before a final reply, then successful recovery answers once", async () => {
	const { parent, child } = await pair("1", "beta/other-model");
	await child.run("error", { errorMessage: "service unavailable", provider: "alpha", model: "fast-model" });
	assert.equal(child.continuations.length, 1);
	assert.equal(envelopes(parent.parent, "new").length, 0);
	assert.equal(child.shutdowns(), 0);
	await child.run();
	scan(parent);
	assert.equal(envelopes(parent.parent, "cur").length, 1);
	assert.equal(envelopes(parent.parent, "cur")[0]?.status, "done");
	assert.equal(child.shutdowns(), 1);
});

test("fallback exhaustion reports the final failure, not the earlier error", async () => {
	const { parent, child } = await pair("1", "beta/other-model");
	await child.run("error", { errorMessage: "service unavailable", provider: "alpha", model: "fast-model" });
	await child.run("error", { errorMessage: "final failure", provider: "beta", model: "other-model" });
	scan(parent);
	assert.equal(envelopes(parent.parent, "cur")[0]?.status, "failed");
	assert.match(envelopes(parent.parent, "cur")[0]?.body ?? "", /final failure/);
	assert.equal(child.shutdowns(), 1);
});

test("pending ownership survives ordinary restart and same-session manual reopen without launch env", async () => {
	const { parent, child, task } = await pair("1");
	await child.run("aborted");
	await child.shutdown();
	const reopened = instance({ parent: child.parent });
	await reopened.start();
	await reopened.run("error", { errorMessage: "still broken" });
	assert.equal(envelopes(parent.parent, "new").length, 0);
	await reopened.run();
	scan(parent);
	assert.equal(
		envelopes(parent.parent, "cur").find((mail) => mail.in_reply_to.includes(task.id))?.body,
		`${TOOK_OVER}\n\nanswer`,
	);
	assert.equal(reopened.shutdowns(), 0, "manual reopen only restores owed-answer handling here");
});

test("provider write error blocks auto-exit; reload retries the frozen answer without another run", async () => {
	const { parent, child, task } = await pair("1");
	// A real transport error: replacing the recipient's inbox directory with a file.
	const path = envelopesPath(parent.parent);
	renameSync(path, `${path}.saved`);
	writeFileSync(path, "blocked");
	await child.run();
	assert.equal(child.shutdowns(), 0);
	assert.match(child.errors.join("\n"), /answer is retained.*reload\/reopen/);
	rmSync(path);
	renameSync(`${path}.saved`, path);
	await child.fire("session_start", { reason: "reload" });
	await nextTurn();
	scan(parent);
	assert.equal(envelopes(parent.parent, "cur").find((mail) => mail.in_reply_to.includes(task.id))?.body, "answer");
});

function envelopesPath(address: string): string {
	return `${process.env.XDG_STATE_HOME}/pi-session-mail/${address}/new`;
}

test("startup outbox recovery retries actual replies across an async handler before provider initialization", async () => {
	const { parent, child, task } = await pair("1");
	const path = envelopesPath(parent.parent);
	renameSync(path, `${path}.saved`);
	writeFileSync(path, "blocked");
	await child.run();
	await child.shutdown();
	rmSync(path);
	renameSync(`${path}.saved`, path);
	const gate = Promise.withResolvers<void>();
	const reopened = instance({
		parent: child.parent,
		parentEnv: parent.parent,
		mailProviderLast: true,
		beforeMailProvider: (pi) => {
			pi.on("session_start", () => gate.promise);
		},
	});
	let attempts = 0;
	reopened.events.on("message:reply", () => {
		attempts++;
	});
	const starting = reopened.start();
	await nextTurn();
	assert.equal(attempts, 1, "first real reply precedes the delayed provider's session_start");
	assert.equal(JSON.parse(readFileSync(taskStatePath(child.parent), "utf8")).outbox.length, 1);
	gate.resolve();
	await starting;
	await new Promise((resolve) => setTimeout(resolve, 150));
	scan(parent);
	assert.equal(attempts, 2, "one bounded retry succeeds after provider initialization");
	assert.equal(envelopes(parent.parent, "cur").find((mail) => mail.in_reply_to.includes(task.id))?.body, "answer");
	assert.equal(reopened.errors.length, 0, "transient startup ordering does not leave a false failure notice");
});

test("startup retry is bounded and leaves a visible error and saved answer if initialization stays delayed", async () => {
	const { parent, child } = await pair("1");
	const path = envelopesPath(parent.parent);
	renameSync(path, `${path}.saved`);
	writeFileSync(path, "blocked");
	await child.run();
	await child.shutdown();
	rmSync(path);
	renameSync(`${path}.saved`, path);
	const gate = Promise.withResolvers<void>();
	const reopened = instance({
		parent: child.parent,
		parentEnv: parent.parent,
		mailProviderLast: true,
		beforeMailProvider: (pi) => {
			pi.on("session_start", () => gate.promise);
		},
	});
	let attempts = 0;
	reopened.events.on("message:reply", () => {
		attempts++;
	});
	const starting = reopened.start();
	await nextTurn();
	await new Promise((resolve) => setTimeout(resolve, 350));
	assert.equal(attempts, 3);
	assert.equal(reopened.errors.length, 1);
	assert.match(reopened.errors[0] ?? "", /answer is retained.*Auto-exit is blocked/);
	assert.equal(JSON.parse(readFileSync(taskStatePath(child.parent), "utf8")).outbox.length, 1);
	gate.resolve();
	await starting;
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(attempts, 3, "no unbounded timer remains");
	await reopened.fire("session_start", { reason: "reload" });
	await nextTurn();
	assert.equal(attempts, 4, "reload provides another explicit recovery trigger");
});

test("initial takeover persistence failure does not claim an answer was retained", async () => {
	const parent = instance();
	await parent.start();
	const child = instance({ parentEnv: parent.parent, autoExitEnv: "1" });
	await child.start();
	const blocked = `${taskStatePath(child.parent)}.${process.pid}.tmp`;
	mkdirSync(blocked, { recursive: true });
	try {
		request(parent, child.parent);
		scan(child);
		assert.equal(child.userMessages.length, 0);
		assert.match(child.errors.join("\n"), /Task ownership was not recorded.*send it again/);
		assert.doesNotMatch(child.errors.join("\n"), /answer is retained/);
		await child.run();
		assert.equal(child.shutdowns(), 0);
	} finally {
		rmSync(blocked, { recursive: true });
	}
});

test("a later settled run retries the original frozen answer, rather than replacing it", async () => {
	const { parent, child, task } = await pair("1");
	const path = envelopesPath(parent.parent);
	renameSync(path, `${path}.saved`);
	writeFileSync(path, "blocked");
	await child.run();
	rmSync(path);
	renameSync(`${path}.saved`, path);
	await child.fire("agent_end", {
		messages: [
			{ role: "assistant", content: [{ type: "text", text: "a different later answer" }], stopReason: "stop" },
		],
	});
	await child.fire("agent_settled");
	await nextTurn();
	scan(parent);
	assert.equal(envelopes(parent.parent, "cur").find((mail) => mail.in_reply_to.includes(task.id))?.body, "answer");
	assert.equal(child.shutdowns(), 1);
});

test("a frozen answer retries after same-session manual reopen with no launch variables", async () => {
	const { parent, child, task } = await pair("1");
	const path = envelopesPath(parent.parent);
	renameSync(path, `${path}.saved`);
	writeFileSync(path, "blocked");
	await child.run();
	await child.shutdown();
	rmSync(path);
	renameSync(`${path}.saved`, path);
	const reopened = instance({ parent: child.parent });
	await reopened.start();
	await nextTurn();
	scan(parent);
	assert.equal(envelopes(parent.parent, "cur").find((mail) => mail.in_reply_to.includes(task.id))?.body, "answer");
	assert.equal(reopened.userMessages.length, 0, "recovery needs no replacement model run");
});

test("crash after envelope write before completion persistence resends, but parent shows one final across restart", async () => {
	writeAgent("scout", agentFile({ description: "test", model: "alpha/fast-model" }));
	const parent = instance();
	await parent.start();
	await parent.delegate("scout do it");
	const record = parent.entries.find((entry) => typeof entry.data.requestId === "string");
	assert.ok(record);
	const childId = record.data.id as string;
	const child = instance({ parent: childId, parentEnv: parent.parent, autoExitEnv: "0" });
	await child.start();
	scan(child);
	let crashState: string | undefined;
	child.events.on("message:reply", () => {
		// Hook runs after the real provider writes the envelope but before squire records success.
		crashState = readFileSync(taskStatePath(childId), "utf8");
	});
	await child.run();
	assert.ok(crashState);
	scan(parent);
	assert.equal(parent.sent.filter((sent) => sent.message.customType === "delegate").length, 1);
	await parent.shutdown();
	await child.shutdown();
	writeFileSync(taskStatePath(childId), crashState);
	const restoredParent = instance({ parent: parent.parent, entries: parent.entries });
	await restoredParent.start();
	const restoredChild = instance({ parent: childId, parentEnv: parent.parent });
	await restoredChild.start();
	await nextTurn();
	scan(restoredParent);
	assert.equal(envelopes(parent.parent, "cur").length, 2, "mail transport is at-least-once, not deduplicating");
	assert.equal(restoredParent.sent.length, 0, "correlated task already has its final result");
});

test("resume's new task and all held task ids are answered in batches no larger than 50", async () => {
	const { parent, child, task } = await pair();
	await child.run("aborted");
	await child.shutdown();
	const resumed = instance({ parent: child.parent, parentEnv: parent.parent });
	await resumed.start();
	const ids = [task.id];
	for (let i = 0; i < 51; i++) ids.push(request(parent, child.parent, `follow-up ${i}`).id);
	scan(resumed);
	await resumed.run();
	scan(parent);
	const replies = envelopes(parent.parent, "cur");
	assert.deepEqual(new Set(replies.flatMap((reply) => reply.in_reply_to)), new Set(ids));
	assert.ok(replies.every((reply) => reply.in_reply_to.length <= 50));
	assert.ok(replies.some((reply) => reply.body === `${TOOK_OVER}\n\nanswer`));
});

test("squire resume restores the old owed task alongside its new request through real mail", async () => {
	writeAgent("scout", agentFile({ description: "test", model: "alpha/fast-model" }));
	const parent = instance();
	await parent.start();
	await parent.delegate("scout original task");
	const first = parent.entries.find((entry) => typeof entry.data.requestId === "string")?.data;
	assert.ok(first);
	const childId = first.id as string;
	const child = instance({ parent: childId, parentEnv: parent.parent, autoExitEnv: "0" });
	await child.start();
	scan(child);
	await child.run("aborted");
	await child.shutdown();
	parent.tmux.windows.delete(first.windowId as string);
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(
		join(sessionDir, `session_${childId}.jsonl`),
		`${JSON.stringify({ type: "session", version: 3, id: childId, cwd: root, timestamp: new Date().toISOString() })}\n`,
	);
	const resumed = await parent.toolCall("delegation_resume", {
		id: childId,
		task: "finish the work",
		auto_exit: false,
	});
	assert.equal((resumed.details as { outcome: string }).outcome, "started");
	const reopened = instance({ parent: childId, parentEnv: parent.parent, autoExitEnv: "0" });
	await reopened.start();
	scan(reopened);
	await reopened.run();
	scan(parent);
	const starts = parent.entries.filter((entry) => typeof entry.data.requestId === "string");
	const answered = parent.entries.filter((entry) => entry.data.result !== undefined);
	assert.equal(starts.length, 2);
	assert.equal(answered.length, 2, "old held and new resume records both finish");
	const ids = envelopes(parent.parent, "cur").flatMap((reply) => reply.in_reply_to);
	assert.deepEqual(new Set(ids), new Set(starts.map((entry) => entry.data.requestId)));
});

test("unseen delivery failure retains v0.5.0 failure wording", async () => {
	const { parent, child } = await pair();
	child.pi.sendUserMessage = () => {
		throw new Error("cannot queue");
	};
	request(parent, child.parent);
	scan(child);
	await child.run();
	scan(parent);
	assert.ok(envelopes(parent.parent, "cur").some((reply) => reply.body === UNSEEN && reply.status === "failed"));
});
