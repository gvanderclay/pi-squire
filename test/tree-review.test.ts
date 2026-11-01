import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, beforeEach, type TestContext, test } from "node:test";
import { readChildRecords } from "../src/child-tasks.ts";
import type { Delegation, StartedRecorded } from "../src/results.ts";
import { readTaskState, taskStatePath } from "../src/task-store.ts";
import { WindowOpenError } from "../src/tmux.ts";
import { failedTree, readTree, reserveTree, treeCounts, treePath } from "../src/tree-registry.ts";
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
import { envelopes, mailSession, nextTurn, scan } from "./mail-harness.ts";

type Session = ReturnType<typeof mailSession>;
type Role = "root" | "coordinator";
const active: Session[] = [];
function instance(options: SessionOptions = {}): Session {
	const s = mailSession(options);
	active.push(s);
	return s;
}
async function launch(parent: Session, agent = "worker"): Promise<Delegation> {
	const result = await parent.toolCall("delegate", { agent, task: "work" });
	return parent.entries.findLast(({ data }) => data.id === (result.details as { id: string }).id)!.data as Delegation;
}
async function setup(role: Role): Promise<{ owner: Session; parent: Session }> {
	const owner = instance();
	await owner.start();
	if (role === "root") return { owner, parent: owner };
	const record = await launch(owner, "coordinator");
	const parent = instance({ parent: record.id, tmux: owner.tmux });
	await parent.start();
	scan(parent);
	return { owner, parent };
}
async function child(parent: Session, record: Delegation): Promise<Session> {
	const worker = instance({ parent: record.id, tmux: parent.tmux });
	await worker.start();
	scan(worker);
	return worker;
}
function reply(worker: Session, parent: Session, record: Delegation): void {
	const payload: { to: string; inReplyTo: string[]; status: string; body: string; envelope?: unknown; error?: string } =
		{
			to: parent.parent,
			inReplyTo: [record.requestId],
			status: "done",
			body: "work completed",
		};
	worker.events.emit("message:reply", payload);
	assert.ok(payload.envelope, payload.error ?? "real provider did not write a reply");
	scan(parent);
}
function details(message: unknown): { kind?: string; id?: string } {
	return (message as { details?: { kind?: string; id?: string } }).details ?? {};
}
function local(parent: Session, record: Delegation): StartedRecorded {
	return readChildRecords(parent.parent).find((entry) => entry.id === record.id) as StartedRecorded;
}
function assertPublicationWarning(parent: Session): void {
	assert.ok(
		parent.warnings.some((text) =>
			/could not publish shared accounting.*Local child facts are saved.*next admission/.test(text),
		),
	);
	assert.equal(
		parent.errors.some((text) => /could not persist child tasks/.test(text)),
		false,
	);
}
function reserveReplacement(owner: Session, parent: Session): void {
	const reservation = reserveTree({
		id: "replacement",
		sessionId: "replacement",
		identity: {
			parent: parent.parent,
			root: owner.parent,
			depth: parent === owner ? 1 : 2,
			agent: "worker",
			chain: parent === owner ? ["worker"] : ["coordinator", "worker"],
			autoExit: false,
		},
	});
	failedTree(reservation);
}
async function tick(t: TestContext): Promise<void> {
	t.mock.timers.tick(5000);
	for (let i = 0; i < 3; i++) await nextTurn();
}
beforeEach(() => {
	resetRoot();
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(join(agentDir, "squire", "settings.json"), JSON.stringify({ maxDepth: 2 }));
	writeAgent("worker", agentFile({ model: "alpha/fast-model", auto_exit: "false" }));
	writeAgent(
		"coordinator",
		agentFile({ model: "alpha/fast-model", allow_nested_delegation: "[worker]", auto_exit: "false" }),
	);
});
afterEach(async () => {
	for (const s of active.splice(0)) await s.shutdown();
});
after(cleanup);

for (const role of ["root", "coordinator"] as const) {
	test(`${role}: registry publication failure cannot swallow a durably saved result/steer`, async () => {
		const { owner, parent } = await setup(role);
		const record = await launch(parent);
		const worker = await child(parent, record);
		const path = treePath(owner.parent),
			saved = readFileSync(path, "utf8");
		if (role === "coordinator") {
			await parent.fire("agent_start");
			await parent.fire("context", { messages: [] });
		}
		writeFileSync(path, "null");
		reply(worker, parent, record);
		assert.ok(local(parent, record).result);
		const messages = parent.sent.filter(({ message }) => details(message).kind === "result");
		assert.equal(messages.length, 1);
		assert.deepEqual(messages[0].options, { triggerTurn: true, deliverAs: "steer" });
		assertPublicationWarning(parent);
		if (role === "coordinator") {
			await parent.fire("agent_end", {
				messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "summary" }] }],
			});
			const gate = await parent.fire("agent_before_settle", { entries: [], continue: false });
			assert.ok(
				gate.some((value) => (value as { continue?: boolean })?.continue),
				"publication failure must not poison the processing barrier",
			);
		}
		writeFileSync(path, saved);
		writeFileSync(
			join(agentDir, "squire", "settings.json"),
			JSON.stringify({ maxDepth: 2, maxConcurrentDelegates: role === "root" ? 1 : 2 }),
		);
		reserveReplacement(owner, parent); // admission reconciles the local terminal before checking the cap
		assert.equal(readTree(owner.parent).entries.find((entry) => entry.id === record.id)?.finished, true);
		if (role === "coordinator") {
			await parent.run();
			scan(owner);
			assert.equal(envelopes(owner.parent, "cur").filter((mail) => mail.in_reply_to.length).length, 1);
		}
	});

	test(`${role}: gone notification/wake survives failed shared publication`, async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const { owner, parent } = await setup(role);
		const record = await launch(parent);
		const path = treePath(owner.parent),
			saved = readFileSync(path, "utf8");
		writeFileSync(path, "null");
		parent.tmux.windows.delete(record.windowId);
		await tick(t);
		assert.equal(local(parent, record).gone, true);
		const messages = parent.sent.filter(({ message }) => details(message).kind === "gone");
		assert.equal(messages.length, 1);
		assert.deepEqual(messages[0].options, { triggerTurn: true, deliverAs: role === "root" ? "followUp" : "steer" });
		assertPublicationWarning(parent);
		writeFileSync(path, saved);
		reserveReplacement(owner, parent);
		assert.equal(readTree(owner.parent).entries.find((entry) => entry.id === record.id)?.gone, true);
	});

	test(`${role}: explicit subtree close requires readable structural fencing before any kill`, async () => {
		const { owner, parent } = await setup(role);
		const record = await launch(parent);
		const path = treePath(owner.parent),
			saved = readFileSync(path, "utf8");
		writeFileSync(path, "null");
		await assert.rejects(parent.toolCall("delegation_close", { id: record.id }), /invalid tree registry/);
		assert.equal(local(parent, record).closed, undefined);
		assert.equal(parent.tmux.killed.length, 0);
		writeFileSync(path, saved);
		const closed = await parent.toolCall("delegation_close", { id: record.id });
		assert.equal((closed.details as { complete: boolean }).complete, true);
		assert.equal(local(parent, record).closed, true);
		assert.equal(readTree(owner.parent).entries.find((entry) => entry.id === record.id)?.closed, true);
	});

	test(`${role}: confirmed open stays successful and enters the local barrier despite accounting failure`, async () => {
		const { owner, parent } = await setup(role);
		const open = parent.tmux.openWindow.bind(parent.tmux);
		let saved = "";
		parent.tmux.openWindow = async (...args) => {
			const window = await open(...args);
			saved = readFileSync(treePath(owner.parent), "utf8");
			writeFileSync(treePath(owner.parent), "null");
			return window;
		};
		const record = await launch(parent);
		assert.equal(local(parent, record).windowId, record.windowId);
		assert.equal(parent.tmux.windows.has(record.windowId), true);
		assert.ok(parent.warnings.some((text) => /window .* opened, but shared accounting publication failed/.test(text)));
		if (role === "coordinator") {
			await parent.run();
			assert.equal(
				envelopes(owner.parent, "new").filter((mail) => mail.in_reply_to.length).length,
				0,
				"untracked child must not let the coordinator finish",
			);
		}
		writeFileSync(treePath(owner.parent), saved);
		// Use a cap at the current known count; the next admission recovers the locally tracked open.
		writeFileSync(
			join(agentDir, "squire", "settings.json"),
			JSON.stringify({ maxDepth: 2, maxConcurrentDelegates: role === "root" ? 1 : 2 }),
		);
		await assert.rejects(parent.toolCall("delegate", { agent: "worker", task: "over cap" }), /maxConcurrentDelegates/);
		assert.equal(readTree(owner.parent).entries.find((entry) => entry.id === record.id)?.phase, "started");
		const worker = await child(parent, record);
		reply(worker, parent, record);
		assert.ok(parent.sent.some(({ message }) => details(message).id === record.id));
	});
}

test("successful resume retains local tracking and request correlation when opened/request publications fail", async () => {
	const { owner, parent } = await setup("root");
	const record = await launch(parent);
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(
		join(sessionDir, `date_${record.id}.jsonl`),
		`${JSON.stringify({ type: "session", id: record.id, cwd: root })}\n`,
	);
	parent.tmux.windows.delete(record.windowId);
	const open = parent.tmux.openWindow.bind(parent.tmux);
	parent.tmux.openWindow = async (...args) => {
		const window = await open(...args);
		writeFileSync(treePath(owner.parent), "null");
		return window;
	};
	const resumed = await parent.toolCall("delegation_resume", { id: record.id, task: "more" });
	const latest = readChildRecords(parent.parent).find(
		(entry) => entry.id === (resumed.details as { id: string }).id,
	) as StartedRecorded;
	assert.ok(latest.requestId);
	assert.equal(latest.resumedFrom, record.id);
	assert.equal(latest.sessionId, record.id);
	assert.equal(parent.tmux.windows.has(latest.windowId), true);
	assert.ok(parent.warnings.some((text) => /shared request publication failed/.test(text)));
	assert.equal(
		parent.errors.some((text) => /reservation remains charged/.test(text)),
		false,
		"successful resumes must not try failure cleanup",
	);
});

for (const certainty of ["not-opened", "unknown"] as const)
	test(`accounting failure preserves original tmux ${certainty} error`, async () => {
		const { owner, parent } = await setup("root");
		let saved = "";
		parent.tmux.openWindow = async () => {
			saved = readFileSync(treePath(owner.parent), "utf8");
			writeFileSync(treePath(owner.parent), "null");
			throw new WindowOpenError("original tmux failure", certainty);
		};
		await assert.rejects(
			launch(parent),
			(error: unknown) =>
				error instanceof WindowOpenError &&
				error.certainty === certainty &&
				/original tmux failure/.test(error.message),
		);
		writeFileSync(treePath(owner.parent), saved);
		assert.deepEqual(treeCounts(readTree(owner.parent)), { concurrent: 1, lifetime: 1 });
	});

test("stale settlement after shutdown cannot freeze or emit an answer; reopen retains the owed task", async () => {
	const { parent } = await setup("root");
	const record = await launch(parent);
	const worker = await child(parent, record);
	await worker.fire("agent_end", {
		messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "finished" }] }],
	});
	await worker.shutdown();
	await worker.fire("agent_settled");
	assert.equal(readTaskState(taskStatePath(record.id))?.outbox.length, 0);
	assert.equal(readTaskState(taskStatePath(record.id))?.requests.length, 1);
	assert.equal(envelopes(parent.parent, "new").filter((mail) => mail.in_reply_to.length).length, 0);
	assert.equal(treeCounts(readTree(parent.parent)).concurrent, 1);
	const reopened = instance({ parent: record.id, tmux: parent.tmux });
	await reopened.start();
	await reopened.run();
	await nextTurn();
	scan(parent);
	assert.equal(readTaskState(taskStatePath(record.id))?.outbox.length, 0);
	assert.equal(treeCounts(readTree(parent.parent)).concurrent, 0);
});
