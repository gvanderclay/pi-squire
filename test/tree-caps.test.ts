import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import type { Delegation } from "../src/results.ts";
import { readTaskState, taskStatePath } from "../src/task-store.ts";
import type { TmuxClient } from "../src/tmux.ts";
import { failedTree, readTree, reserveTree, treeCounts, treePath } from "../src/tree-registry.ts";
import { treeCaps } from "../src/tree-settings.ts";
import {
	agentDir,
	agentFile,
	cleanup,
	resetRoot,
	root,
	type SessionOptions,
	sessionDir,
	writeAgent,
} from "./harness.ts";
import { envelopes, mailSession, scan } from "./mail-harness.ts";

type Session = ReturnType<typeof mailSession>;
const sessions: Session[] = [];
function instance(options: SessionOptions = {}): Session {
	const s = mailSession(options);
	sessions.push(s);
	return s;
}
function settings(value: Record<string, unknown>): void {
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(join(agentDir, "squire", "settings.json"), JSON.stringify(value));
}
function counts(s: Session) {
	return treeCounts(readTree(s.parent));
}
async function launch(s: Session, agent = "worker"): Promise<Delegation> {
	const result = await s.toolCall("delegate", { agent, task: "work" });
	return s.entries.findLast(({ data }) => data.id === (result.details as { id: string }).id)!.data as Delegation;
}
beforeEach(() => {
	resetRoot();
	writeAgent("worker", agentFile({ model: "alpha/fast-model", auto_exit: "false" }));
	writeAgent(
		"coordinator",
		agentFile({ model: "alpha/fast-model", allow_nested_delegation: "[worker]", auto_exit: "false" }),
	);
});
afterEach(async () => {
	for (const s of sessions.splice(0)) await s.shutdown();
});
after(cleanup);

test("call-time defaults, zero/unlimited, invalid caps and lowering without killing", async () => {
	assert.deepEqual(treeCaps(), { maxConcurrentDelegates: 0, maxDelegatesPerRoot: 0 });
	settings({ maxDepth: 2 });
	assert.deepEqual(treeCaps(), { maxConcurrentDelegates: 16, maxDelegatesPerRoot: 64 });
	settings({ maxDepth: 2, maxConcurrentDelegates: 0, maxDelegatesPerRoot: 0 });
	const s = instance();
	await launch(s);
	await launch(s);
	settings({ maxConcurrentDelegates: 1 });
	await assert.rejects(launch(s), /maxConcurrentDelegates.*count 2, limit 1/);
	assert.equal(s.tmux.killed.length, 0);
	assert.equal(s.sendCalls.length, 0, "real provider bypasses send stub");
	assert.deepEqual(counts(s), { concurrent: 2, lifetime: 2 });
	for (const key of ["maxConcurrentDelegates", "maxDelegatesPerRoot"])
		for (const value of [-1, 1.5, "2", null, true]) {
			settings({ [key]: value });
			await assert.rejects(launch(s), new RegExp(`invalid ${key}`));
		}
	settings({ maxDelegatesPerRoot: 2 });
	await assert.rejects(launch(s), /maxDelegatesPerRoot.*count 2, limit 2/);
	settings({ maxConcurrentDelegates: 0, maxDelegatesPerRoot: 0 });
	await launch(s);
	assert.deepEqual(counts(s), { concurrent: 3, lifetime: 3 });
});

test("slow startup window lookup does not precede task ownership restoration", async () => {
	const parent = instance();
	const record = await launch(parent);
	(parent.tmux as TmuxClient).currentWindow = () =>
		new Promise((resolve) => setImmediate(() => resolve({ id: record.windowId, name: record.windowName })));
	const worker = instance({ parent: record.id, tmux: parent.tmux });
	await worker.start();
	scan(worker);
	assert.equal(worker.userMessages.length, 1);
	await worker.run();
	assert.deepEqual(counts(parent), { concurrent: 0, lifetime: 1 });
});

test("a finished open worker releases concurrency while its parent is shut down, not lifetime", async () => {
	settings({ maxConcurrentDelegates: 1, maxDelegatesPerRoot: 1 });
	const parent = instance();
	const record = await launch(parent);
	const worker = instance({ parent: record.id, tmux: parent.tmux });
	await worker.start();
	scan(worker);
	await parent.shutdown();
	await worker.run();
	assert.equal(worker.shutdowns(), 0);
	assert.equal(parent.tmux.windows.has(record.windowId), true);
	assert.deepEqual(counts(parent), { concurrent: 0, lifetime: 1 });
	assert.equal(envelopes(parent.parent, "new").filter((reply) => reply.in_reply_to.length).length, 1);
	const reopened = instance({ parent: parent.parent, tmux: parent.tmux });
	await reopened.start();
	scan(reopened);
	await assert.rejects(launch(reopened), /maxDelegatesPerRoot.*count 1, limit 1/);
});

test("waiting coordinator remains charged; stopped/failed intermediate runs do not free it", async () => {
	settings({ maxDepth: 2, maxConcurrentDelegates: 3 });
	const parent = instance();
	const c = await launch(parent, "coordinator");
	const coordinator = instance({ parent: c.id, tmux: parent.tmux });
	await coordinator.start();
	scan(coordinator);
	const w = await launch(coordinator);
	const worker = instance({ parent: w.id, tmux: parent.tmux });
	await worker.start();
	scan(worker);
	await coordinator.run("error");
	await worker.run("aborted");
	assert.deepEqual(counts(parent), { concurrent: 2, lifetime: 2 });
	await worker.run();
	assert.deepEqual(counts(parent), { concurrent: 1, lifetime: 2 });
	scan(coordinator);
	await coordinator.run();
	assert.deepEqual(counts(parent), { concurrent: 0, lifetime: 2 });
});

test("known pre-start failure refunds both caps; uncertain open does not", async () => {
	settings({ maxConcurrentDelegates: 1, maxDelegatesPerRoot: 1 });
	const s = instance();
	s.tmux.failOpen = "before dispatch";
	await assert.rejects(launch(s), /before dispatch/);
	assert.deepEqual(counts(s), { concurrent: 0, lifetime: 0 });
	s.tmux.failOpenCertainty = "unknown";
	await assert.rejects(launch(s), /before dispatch/);
	assert.deepEqual(counts(s), { concurrent: 1, lifetime: 1 });
	s.tmux.failOpen = undefined;
	await assert.rejects(launch(s), /count 1, limit 1/);
});

test("successful window followed by local record failure retains accounting and never rolls back the window", async () => {
	const s = instance();
	await s.start();
	s.events.on("session:launch", () => {
		const path = join(agentDir, "squire", "child-tasks", `${encodeURIComponent(s.parent)}.json`);
		rmSync(path);
		mkdirSync(path);
	});
	await assert.rejects(launch(s), /EISDIR/);
	assert.equal(s.tmux.opened.length, 1);
	assert.deepEqual(counts(s), { concurrent: 1, lifetime: 1 });
	assert.equal(readTree(s.parent).entries[0].phase, "started");
});

test("frozen-answer publication failure retains outbox, blocks exit and is recoverable without foreign mail", async () => {
	const parent = instance();
	const record = await launch(parent);
	const worker = instance({ parent: record.id, tmux: parent.tmux });
	await worker.start();
	scan(worker);
	const path = treePath(parent.parent),
		saved = readFileSync(path, "utf8");
	rmSync(path);
	mkdirSync(path);
	await worker.run();
	assert.equal(worker.shutdowns(), 0);
	assert.equal(readTaskState(taskStatePath(record.id))?.outbox.length, 1);
	assert.equal(envelopes(parent.parent, "new").filter((mail) => mail.in_reply_to.length).length, 0);
	rmSync(path, { recursive: true });
	writeFileSync(path, saved);
	await worker.run();
	scan(parent);
	assert.deepEqual(counts(parent), { concurrent: 0, lifetime: 1 });
	assert.equal(readTaskState(taskStatePath(record.id))?.outbox.length, 0);
});

test("resume cap refusal precedes exited-window kill; each successful resume spends a launch", async () => {
	settings({ maxDelegatesPerRoot: 1 });
	const s = instance();
	const record = await launch(s);
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(
		join(sessionDir, `date_${record.id}.jsonl`),
		`${JSON.stringify({ type: "session", id: record.id, cwd: root })}\n`,
	);
	s.tmux.exit(record.windowId);
	await assert.rejects(
		s.toolCall("delegation_resume", { id: record.id, task: "again" }),
		/maxDelegatesPerRoot.*count 1, limit 1/,
	);
	assert.equal(s.tmux.killed.length, 0);
	settings({ maxDelegatesPerRoot: 2 });
	const resumed = await s.toolCall("delegation_resume", { id: record.id, task: "again" });
	const resumedId = (resumed.details as { id: string }).id;
	assert.equal(readTree(s.parent).entries.find((entry) => entry.id === resumedId)?.sessionId, record.id);
	assert.deepEqual(counts(s), { concurrent: 1, lifetime: 2 });
});

test("unknown resume open and send/kill failure remain charged, not pre-start refunds", async () => {
	for (const failure of ["unknown-open", "send-kill"]) {
		resetRoot();
		writeAgent("worker", agentFile({ model: "alpha/fast-model", auto_exit: "false" }));
		const s = instance();
		const record = await launch(s);
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(
			join(sessionDir, `date_${record.id}.jsonl`),
			`${JSON.stringify({ type: "session", id: record.id, cwd: root })}\n`,
		);
		s.tmux.windows.delete(record.windowId);
		if (failure === "unknown-open") {
			s.tmux.failOpen = "uncertain";
			s.tmux.failOpenCertainty = "unknown";
		} else {
			s.events.on("message:send", (payload: unknown) => {
				(payload as { error: string }).error = "failed mail";
			});
			s.tmux.kill = () => Promise.reject(new Error("failed kill"));
		}
		await assert.rejects(s.toolCall("delegation_resume", { id: record.id, task: "again" }), /uncertain|failed mail/);
		assert.deepEqual(counts(s), { concurrent: 1, lifetime: 2 });
	}
});

test("corrupt registry cannot become a fresh empty budget; explicit release is idempotent", () => {
	const own = { parent: "p", root: "root", depth: 1, chain: ["worker"], agent: "worker", autoExit: false };
	const token = reserveTree({ id: "one", sessionId: "one", identity: own });
	failedTree(token);
	failedTree(token);
	assert.deepEqual(treeCounts(readTree("root")), { concurrent: 0, lifetime: 0 });
	writeFileSync(treePath("root"), "null");
	assert.throws(() => reserveTree({ id: "two", sessionId: "two", identity: own }), /invalid tree registry/);
});
