import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { after, afterEach, beforeEach, test } from "node:test";
import { writeState } from "../src/local-state.ts";
import type { Delegation } from "../src/results.ts";
import { NOTICE_MS, treeNotice } from "../src/tree-notice.ts";
import { treePath, treeTransaction } from "../src/tree-registry.ts";
import { requestRootTrust, trustEndpointPath } from "../src/trust-wire.ts";
import { FakeTmux } from "./fake-tmux.ts";
import { agentDir, agentFile, cleanup, resetRoot, root, sessionDir, writeAgent } from "./harness.ts";
import { envelopes, mailSession, nextTurn, scan } from "./mail-harness.ts";

type Session = ReturnType<typeof mailSession>;
const active: Session[] = [];
function instance(options: Parameters<typeof mailSession>[0] = {}): Session {
	const value = mailSession(options);
	active.push(value);
	return value;
}
beforeEach(() => {
	resetRoot();
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(join(agentDir, "squire", "settings.json"), JSON.stringify({ maxDepth: 3, maxConcurrentDelegates: 8 }));
	writeAgent(
		"coordinator",
		agentFile({ model: "alpha/fast-model", allow_nested_delegation: "[worker]", auto_exit: "false" }),
	);
	writeAgent("worker", agentFile({ model: "alpha/fast-model", auto_exit: "false" }));
});
afterEach(async () => {
	for (const value of active.splice(0).reverse()) await value.shutdown();
});
after(cleanup);
async function launch(parent: Session, agent: string): Promise<Delegation> {
	const result = await parent.toolCall("delegate", { agent, task: "do work" });
	return parent.entries.find((entry) => entry.data.id === (result.structuredContent as { id: string }).id)!
		.data as Delegation;
}
async function tree(
	options: Parameters<typeof mailSession>[0] = {},
): Promise<{ owner: Session; coordinator: Session; worker: Session; c: Delegation; w: Delegation }> {
	const tmux = new FakeTmux();
	const owner = instance({ tmux, ...options });
	await owner.start();
	const c = await launch(owner, "coordinator");
	const coordinator = instance({ parent: c.id, tmux });
	await coordinator.start();
	scan(coordinator);
	const w = await launch(coordinator, "worker");
	const worker = instance({ parent: w.id, tmux });
	await worker.start();
	scan(worker);
	return { owner, coordinator, worker, c, w };
}
for (const source of ["local", "transcript"] as const)
	for (const corruption of ["invalid", "conflict"] as const)
		test(`incomplete ${source} child restore (${corruption}) blocks admission, incidental save and premature upstream final`, async () => {
			const { owner, coordinator, c, w } = await tree();
			await coordinator.shutdown();
			const path = join(agentDir, "squire", "child-tasks", `${c.id}.json`);
			const saved = readFileSync(path, "utf8");
			if (source === "transcript") rmSync(path);
			const childIdentity = join(agentDir, "squire", "identity", `${w.id}.json`);
			const identity = readFileSync(childIdentity, "utf8");
			writeFileSync(
				childIdentity,
				corruption === "invalid" ? "{}" : JSON.stringify({ ...JSON.parse(identity), parent: "foreign" }),
			);
			const reopened = instance({
				parent: c.id,
				tmux: owner.tmux,
				entries: source === "transcript" ? coordinator.entries : [],
			});
			await reopened.start();
			await reopened.run();
			assert.equal(envelopes(owner.parent, "new").filter((mail) => mail.in_reply_to.length).length, 0);
			const status = await reopened.toolCall("delegation_status", {});
			assert.ok(
				(status.structuredContent as { delegations: { id: string }[] }).delegations.some(
					(record) => record.id === w.id,
				),
				"known pending child remains tracked",
			);
			await assert.rejects(reopened.toolCall("delegate", { agent: "worker", task: "new" }), /restoration failed/);
			await reopened.fire("agent_settled");
			if (source === "local") assert.equal(readFileSync(path, "utf8"), saved, "no partial overwrite");
			else assert.equal(existsSync(path), false, "no incomplete replacement store");
			writeFileSync(childIdentity, identity);
			await assert.rejects(
				reopened.toolCall("delegate", { agent: "worker", task: "new" }),
				/restoration failed/,
				"repair alone cannot clear latch",
			);
			await reopened.shutdown();
			const repaired = instance({ parent: c.id, tmux: owner.tmux, entries: coordinator.entries });
			await repaired.start();
			await repaired.run();
			assert.equal(envelopes(owner.parent, "new").filter((mail) => mail.in_reply_to.length).length, 0);
		});
test("a failed transcript enumeration keeps local obligations and a sticky completion failure", async () => {
	const { owner, coordinator, c, w } = await tree();
	await coordinator.shutdown();
	const reopened = instance({ parent: c.id, tmux: owner.tmux });
	reopened.context.sessionManager.getEntries = () => {
		throw new Error("broken transcript read");
	};
	await reopened.start();
	await reopened.run();
	assert.ok(reopened.errors.some((error) => error.includes("broken transcript read")));
	assert.equal(envelopes(owner.parent, "new").filter((mail) => mail.in_reply_to.length).length, 0);
	await assert.rejects(reopened.toolCall("delegate", { agent: "worker", task: "new" }), /restoration failed/);
	assert.ok(
		JSON.parse(readFileSync(join(agentDir, "squire", "child-tasks", `${c.id}.json`), "utf8")).records.some(
			(record: Delegation) => record.id === w.id,
		),
	);
});
test("corrupt identities in genuinely foreign fork history do not become local obligations or block a fresh tree", async () => {
	const { coordinator, w } = await tree();
	writeFileSync(join(agentDir, "squire", "identity", `${w.id}.json`), "{}");
	const copy = instance({ entries: coordinator.entries, sessionHeader: { parentSession: "original.jsonl" } });
	await copy.start();
	assert.equal(
		(await copy.toolCall("delegation_status", {})).content[0].text,
		"No delegations are recorded in this session.",
	);
	await copy.toolCall("delegate", { agent: "worker", task: "new independent tree" });
	assert.equal(
		copy.errors.some((error) => error.includes("restoration failed")),
		false,
	);
});

test("failed drain shutdown closes root trust control and old cleanup cannot remove a replacement endpoint", async () => {
	const { owner, coordinator, w } = await tree({ mode: "tui", hasUI: true });
	const endpoint = trustEndpointPath(agentDir, owner.parent);
	const old = JSON.parse(readFileSync(endpoint, "utf8")) as { token: string; port: number };
	owner.pi.sendMessage = () => {
		throw new Error("injected display failure");
	};
	const direct = await launch(owner, "worker");
	const sender = instance({ parent: direct.id, hasUI: false });
	await sender.start();
	scan(sender);
	await sender.run();
	scan(owner);
	assert.ok(owner.errors.some((message) => message.includes("input retained")));
	await owner.shutdown();
	await nextTurn();
	assert.equal(existsSync(endpoint), false);
	await closedPort(old.port);
	const replacement = instance({ parent: owner.parent, mode: "tui", hasUI: true, ui: { select: ["Do not trust"] } });
	await replacement.start();
	await nextTurn();
	const current = readFileSync(endpoint, "utf8");
	assert.notEqual(JSON.parse(current).token, old.token);
	await owner.shutdown();
	assert.equal(readFileSync(endpoint, "utf8"), current);
	const decision = await requestRootTrust(agentDir, owner.parent, {
		directory: root,
		key: root,
		requester: coordinator.parent,
		chain: ["coordinator", "worker"],
	});
	decision.release();
	assert.equal(owner.selects.length, 0);
	assert.equal(replacement.selects.length, 1);
	assert.equal(w.identity?.root, owner.parent);
});
async function closedPort(port: number): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const socket = connect({ host: "127.0.0.1", port });
		socket.once("connect", () => {
			socket.destroy();
			reject(new Error("old trust server still listening"));
		});
		socket.once("error", () => resolve());
		socket.setTimeout(1000, () => {
			socket.destroy();
			reject(new Error("socket check timed out"));
		});
	});
}

test("staging write failure safely delivers at an active ready owner, but a nonowner reports its unpersistable input explicitly", async () => {
	const { owner, coordinator, c } = await tree();
	const stage = join(agentDir, "squire", "owners", owner.parent, "inbound");
	mkdirSync(join(stage, ".."), { recursive: true });
	writeFileSync(stage, "not a directory");
	const payload = { to: owner.parent, inReplyTo: [c.requestId], body: "coordinator summary", status: "done" };
	coordinator.events.emit("message:reply", payload);
	scan(owner);
	assert.equal(owner.sent.filter((item) => item.message.customType === "delegate").length, 1);
	assert.equal(
		owner.sent.some((item) => item.message.customType === "mailbox"),
		false,
	);
	assert.ok(owner.errors.some((message) => message.includes("could not stage")));
	const duplicate = instance({ parent: owner.parent });
	await duplicate.start();
	const reply = {
		envelope: {
			id: randomUUID(),
			kind: "reply",
			from: c.id,
			to: owner.parent,
			in_reply_to: [c.requestId],
			ts: new Date().toISOString(),
			body: "retry",
			status: "done",
		},
		path: "/supplied/cur/reply.json",
		requests: [],
		handled: false,
	};
	duplicate.events.emit("message:inbound", reply);
	assert.equal(reply.handled, true);
	assert.ok(duplicate.errors.some((message) => message.includes("NOT lossless") && message.includes("resend")));
	assert.equal(duplicate.sent.length, 0);
	rmSync(stage);
});
test("timestamp and supplied path metadata order staged requests, not UUID order", async () => {
	const { owner, coordinator, c } = await tree();
	await coordinator.shutdown();
	let release = () => {};
	let waiting = () => {};
	const gated = new Promise<void>((resolve) => {
		waiting = resolve;
	});
	const reopened = instance({
		parent: c.id,
		beforeSquire: (pi) =>
			pi.on(
				"session_start",
				() =>
					new Promise<void>((resolve) => {
						release = resolve;
						waiting();
					}),
			),
	});
	const boot = reopened.start();
	await gated;
	const input = (id: string, ts: string, path: string, body: string) => ({
		envelope: { id, from: owner.parent, to: c.id, kind: "request", in_reply_to: [], ts, body, status: "" },
		path,
		requests: [],
		handled: false,
	});
	reopened.events.emit(
		"message:inbound",
		input("z-original", "2026-10-01T00:00:00.000Z", "/cur/0001-original.json", "original"),
	);
	reopened.events.emit(
		"message:inbound",
		input("a-follow-up", "2026-10-01T00:00:01.000Z", "/cur/0002-follow-up.json", "follow-up"),
	);
	reopened.events.emit(
		"message:inbound",
		input("m-middle", "2026-10-01T00:00:01.000Z", "/cur/0001-middle.json", "middle"),
	);
	release();
	await boot;
	assert.match(reopened.userMessages[0].text, /original/);
	assert.match(reopened.userMessages[1].text, /middle/);
	assert.match(reopened.userMessages[2].text, /follow-up/);
});
test("idle owner drain has no lock-file churn and owner-read failures warn only once", async () => {
	const owner = instance({ hasUI: false });
	await owner.start();
	const lock = join(agentDir, "squire", "owners", `${owner.parent}.lock`);
	const before = statSync(lock).mtimeMs;
	await new Promise((resolve) => setTimeout(resolve, 550));
	assert.equal(statSync(lock).mtimeMs, before);
	assert.equal(readdirSync(lock).length, 0);
	const path = join(agentDir, "squire", "owners", `${owner.parent}.json`);
	const saved = readFileSync(path, "utf8");
	writeFileSync(path, "{");
	await owner.fire("context", { messages: [] });
	await owner.fire("context", { messages: [] });
	assert.equal(owner.errors.filter((message) => message.includes("could not read Squire owner")).length, 1);
	writeFileSync(path, saved);
});
test("a fresh live result after a root abort still steers and starts a turn", async () => {
	const { owner } = await tree();
	const record = await launch(owner, "worker");
	const child = instance({ parent: record.id, tmux: owner.tmux });
	await child.start();
	scan(child);
	await owner.run("aborted");
	await child.run();
	scan(owner);
	await nextTurn();
	const result = owner.sent.filter((item) => item.message.customType === "delegate").at(-1)!;
	assert.deepEqual(result.options, { triggerTurn: true, deliverAs: "steer" });
	assert.equal(
		JSON.parse(readFileSync(join(agentDir, "squire", "child-tasks", `${owner.parent}.json`), "utf8")).paused,
		false,
	);
});
test("a fresh live gone outcome after a root abort keeps its original wake delivery", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const { owner } = await tree();
	const record = await launch(owner, "worker");
	await owner.run("aborted");
	owner.tmux.windows.delete(record.windowId);
	t.mock.timers.tick(5000);
	for (let i = 0; i < 3; i++) await nextTurn();
	const gone = owner.sent.find((item) => String(item.message.content).includes("closed without a result"))!;
	assert.ok(gone);
	assert.deepEqual(
		gone.options,
		{ triggerTurn: true, deliverAs: "followUp" },
		"preserve pre06 root gone contract; coordinators use steer",
	);
	assert.equal(
		JSON.parse(readFileSync(join(agentDir, "squire", "child-tasks", `${owner.parent}.json`), "utf8")).paused,
		false,
	);
});
test("root user stop survives reopen without automatic work; a later request receives retained outcomes", async () => {
	const { owner, coordinator } = await tree();
	const worker = await launch(owner, "worker");
	const child = instance({ parent: worker.id, tmux: owner.tmux });
	await child.start();
	scan(child);
	await child.run();
	scan(owner);
	await owner.run("aborted");
	await owner.shutdown();
	const reopened = instance({ parent: owner.parent, tmux: owner.tmux });
	await reopened.start();
	await nextTurn();
	assert.equal(reopened.sent.length, 0);
	assert.equal(reopened.userMessages.length, 0);
	assert.equal(
		(await reopened.fire("agent_before_settle")).some((value) => (value as { continue?: boolean })?.continue),
		false,
	);
	const context = await reopened.fire("context", { messages: [] });
	assert.match(JSON.stringify(context), /answer/);
	await reopened.fire("agent_settled");
	assert.doesNotMatch(JSON.stringify(await reopened.fire("context", { messages: [] })), /answer/);
	assert.equal(coordinator.shutdowns(), 0);
});
test("root late-outcome continuation uses root wording, not coordinator final-task-report instructions", async () => {
	const owner = instance();
	await owner.start();
	const worker = await launch(owner, "worker");
	const child = instance({ parent: worker.id, tmux: owner.tmux });
	await child.start();
	scan(child);
	await owner.fire("context", { messages: [] });
	await child.run();
	scan(owner);
	const results = await owner.fire("agent_before_settle");
	assert.match(JSON.stringify(results), /finishing this response/);
	assert.doesNotMatch(JSON.stringify(results), /final task report/);
});
test("discovery reports unavailable tmux/owners, and contended registries share one total time budget", async () => {
	const tmux = new FakeTmux();
	for (let i = 0; i < 20; i++) {
		const tree = `busy-${i}`;
		treeTransaction(tree, () => {});
		const lock = `${treePath(tree)}.lock`;
		writeFileSync(join(lock, "held.json"), JSON.stringify({ pid: process.pid, choosing: false, number: 1 }));
	}
	const fresh = instance({ tmux });
	const start = performance.now();
	await fresh.start();
	assert.ok(performance.now() - start < NOTICE_MS + 1000, "no 64x50ms startup stall");
	assert.equal(fresh.warnings.filter((message) => message.includes("discovery")).length, 1);
	assert.match(fresh.warnings.join("\n"), /200 ms total budget/);
	// Remove only our controlled held tickets before fixture shutdown.
	for (let i = 0; i < 20; i++) rmSync(join(`${treePath(`busy-${i}`)}.lock`, "held.json"));
	const unavailable = instance({ tmux });
	tmux.failList = "not available";
	await unavailable.start();
	assert.ok(unavailable.warnings.some((message) => message.includes("tmux could not be asked")));
	tmux.failList = undefined;
	const badOwner = "unreadable-owner",
		tree = "visible-tree";
	tmux.addWindow("@visible", "visible");
	treeTransaction(tree, (state) =>
		state.entries.push({
			id: "visible",
			sessionId: "visible",
			phase: "started",
			ownerPid: process.pid,
			identity: {
				root: tree,
				rootPlacement: "project-delegate-session",
				parent: badOwner,
				depth: 1,
				agent: "worker",
				chain: ["worker"],
				autoExit: false,
			},
			sessionDir,
			windowId: "@visible",
			windowName: "visible",
		}),
	);
	writeState(join(agentDir, "squire", "owners", `${badOwner}.json`), { invalid: true });
	await treeNotice(fresh.context as never, tmux);
	assert.ok(fresh.notes.some((message) => message.includes("Owner status is unavailable")));
	assert.ok(fresh.warnings.some((message) => message.includes("owner records unreadable")));
});
