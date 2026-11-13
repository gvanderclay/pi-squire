// `auto-exit`: a delegate closes itself after a normal completion unless the
// user took over. The parent resolves the setting (call, then agent, then on)
// and passes it in the launch environment; the delegate's side shuts Pi down
// after the run settles, including a failed run, and stays when the user
// typed or stopped a run. `/auto-exit` inside the delegate turns it back on.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, type TestContext, test } from "node:test";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { readIdentity } from "../src/identity.ts";
import { createPaseoHost } from "../src/paseo.ts";
import { taskStatePath } from "../src/task-store.ts";
import { agentDir, agentFile, cleanup, resetRoot, type SessionOptions, session, writeAgent } from "./harness.ts";
import { HerdrWire } from "./herdr-adapter-fixture.ts";
import { FakePaseo } from "./paseo-fixture.ts";

beforeEach(() => resetRoot());
after(() => cleanup());

const SCOUT = { description: "Looks things up", model: "alpha/fast-model", thinking: "low" };

// ---------------------------------------------------------------------------
// The parent: resolving the setting

test("auto-exit is on by default and reaches the child's env and the record", async () => {
	writeAgent("scout", agentFile(SCOUT));
	const s = session();
	await s.delegate("scout do the thing");
	assert.equal(s.tmux.opened[0].env.PI_DELEGATE_AUTO_EXIT, "1");
	assert.equal((s.entries[0].data as { autoExit?: boolean }).autoExit, true);
});

test("an agent's auto_exit: false is its default, and a call beats it either way", async () => {
	writeAgent("keeper", agentFile({ ...SCOUT, auto_exit: "false" }));
	writeAgent("scout", agentFile(SCOUT));
	const s = session();
	await s.start();
	await s.delegate("keeper do the thing");
	await s.delegate("keeper --auto-exit do the thing");
	await s.delegate("scout --no-auto-exit do the thing");
	await s.toolCall("delegate", { agent: "keeper", task: "t", auto_exit: true });
	await s.toolCall("delegate", { agent: "scout", task: "t", auto_exit: false });
	await s.toolCall("delegate", { agent: "keeper", task: "t" });
	assert.deepEqual(
		s.tmux.opened.map((window) => window.env.PI_DELEGATE_AUTO_EXIT),
		["0", "1", "0", "1", "0", "0"],
	);
	// A window kept open is still unattended until someone types in it.
	assert.ok(s.tmux.opened.every((window) => window.env.PI_UNATTENDED === "1"));
	assert.equal(s.sendCalls[1].body, "do the thing"); // the flag is not part of the task
});

test("auto_exit accepts explicit booleans and takes precedence over ignored auto-exit", async () => {
	writeAgent("on", agentFile({ ...SCOUT, auto_exit: "true", "auto-exit": "false" }));
	writeAgent("off", agentFile({ ...SCOUT, auto_exit: "false", "auto-exit": "invalid" }));
	const s = session();
	await s.start();
	for (const agent of ["on", "off"]) await s.toolCall("delegate", { agent, task: "go" });
	assert.deepEqual(
		s.tmux.opened.map(({ env }) => env.PI_DELEGATE_AUTO_EXIT),
		["1", "0"],
	);
	assert.deepEqual(
		s.entries.map(({ data }) => data.autoExit),
		[true, false],
	);
	assert.deepEqual(s.warnings, []);
	assert.deepEqual(s.errors, []);
	assert.match(JSON.stringify(s.tool("delegate").parameters), /auto_exit/);
	assert.ok(!s.tool("delegate").description.includes("tools, extensions"));
});

test("an auto_exit that is not true or false leaves the agent out with a warning", async () => {
	writeAgent("odd", agentFile({ ...SCOUT, auto_exit: "sometimes" }));
	const s = session();
	await s.delegate("odd do the thing");
	assert.deepEqual(s.tmux.opened, []);
	assert.ok(
		s.warnings.some((warning) => /auto_exit "sometimes"/.test(warning)),
		s.warnings.join("\n"),
	);
});

test("the tool describes auto_exit, and completions offer launch flags", async () => {
	writeAgent("scout", agentFile(SCOUT));
	const s = session();
	await s.start();
	assert.match(JSON.stringify(s.tool("delegate").parameters), /auto_exit/);
	assert.deepEqual(
		(await s.completions("scout --"))?.map((item) => item.label),
		[
			"--model",
			"--thinking",
			"--label",
			"--cwd",
			"--worktree",
			"--worktree-base",
			"--worktree-source",
			"--auto-exit",
			"--no-auto-exit",
		],
	);
});

test("delegation_status shows the auto-exit setting", async () => {
	writeAgent("scout", agentFile(SCOUT));
	const s = session();
	await s.start();
	await s.delegate("scout do the thing");
	await s.delegate("scout --no-auto-exit do the thing");
	const status = (await s.toolCall("delegation_status", {})).content[0].text;
	assert.match(status, /auto-exit: on/);
	assert.match(status, /auto-exit: off/);
});

// ---------------------------------------------------------------------------
// The delegate: exiting

test("inside a leaf delegate commands remain registered but delegation tools are inactive", async () => {
	const s = session({ parentEnv: "some-parent", autoExitEnv: "1" });
	await s.start();
	assert.ok(s.commands().includes("auto-exit"));
	assert.ok(!s.pi.getActiveTools().includes("delegate"));
	await assert.rejects(s.toolCall("delegate", { agent: "scout", task: "go" }), /maxDepth/);
});

test("with auto-exit on, a normal completion shuts the delegate down after the settle", async () => {
	const s = session({ parentEnv: "some-parent", autoExitEnv: "1" });
	await s.start();
	await s.run("completed");
	assert.equal(s.shutdowns(), 1);
});

test("an owned task cannot auto-exit when no provider handles message:reply", async () => {
	const s = session({ parentEnv: "some-parent", autoExitEnv: "1" });
	await s.start();
	s.events.emit("message:inbound", {
		envelope: { id: "owed-task", from: "some-parent", kind: "request", body: "do the task" },
		handled: false,
	});
	await s.run();
	assert.equal(s.shutdowns(), 0);
	assert.match(s.errors.join("\n"), /no message:reply provider installed.*answer is retained/);
});

test("with auto-exit off, a normal completion leaves the delegate running", async () => {
	const s = session({ parentEnv: "some-parent", autoExitEnv: "0" });
	await s.start();
	await s.run("completed");
	assert.equal(s.shutdowns(), 0);
});

test("a failed run exits like a completion when auto-exit is on, and only then", async () => {
	const failures = [
		{ errorMessage: '429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}' },
		{ errorMessage: "400: bad request" },
	];
	for (const failure of failures) {
		for (const [autoExitEnv, shutdowns] of [
			["1", 1],
			["0", 0],
		] as const) {
			const s = session({ parentEnv: "some-parent", autoExitEnv });
			await s.start();
			await s.run("error", failure);
			assert.equal(s.shutdowns(), shutdowns, `auto-exit ${autoExitEnv}, ${failure.errorMessage}`);
		}
	}
});

test("the delegate's footer shows auto-exit and follows it off and back on", async () => {
	const on = { key: "delegate-self", text: "<child> delegate \u00b7 auto-exit on" };
	const off = { key: "delegate-self", text: "<child> delegate \u00b7 auto-exit off" };
	const s = session({ parentEnv: "some-parent", autoExitEnv: "1" });
	await s.start();
	assert.deepEqual(s.statuses, [on]);
	await s.type("also check the tests");
	assert.deepEqual(s.statuses.at(-1), off);
	await s.command("auto-exit");
	assert.deepEqual(s.statuses.at(-1), on);
	await s.fire("session_start", { reason: "reload" });
	assert.deepEqual(s.statuses.at(-1), on, "a reload shows it again");

	const closed = session({ parentEnv: "some-parent", autoExitEnv: "0" });
	await closed.start();
	assert.deepEqual(closed.statuses, [off]);
});

test("typing in the delegate turns auto-exit off with a notice", async () => {
	const s = session({ parentEnv: "some-parent", autoExitEnv: "1" });
	await s.start();
	await s.type("also check the tests");
	await s.run("completed");
	assert.equal(s.shutdowns(), 0);
	assert.equal(s.notes.length, 1);
	assert.match(s.notes[0], /auto-exit is off/);
	assert.match(s.notes[0], /\/auto-exit/);
	await s.type("and more");
	assert.equal(s.notes.length, 1); // one notice, not one per input
});

for (const end of ["aborted", "stopped"] as const) {
	test(`a run the user stopped (${end}) turns auto-exit off for later runs too`, async () => {
		const s = session({ parentEnv: "some-parent", autoExitEnv: "1" });
		await s.start();
		await s.run(end);
		await s.run("completed");
		assert.equal(s.shutdowns(), 0);
		assert.match(s.notes.join("\n"), /auto-exit is off/);
	});
}

test("the delegate's footer names its agent when the launch gives one", async () => {
	const s = session({ parentEnv: "some-parent", autoExitEnv: "1", agentEnv: "reviewer" });
	await s.start();
	assert.deepEqual(s.statuses, [{ key: "delegate-self", text: "<child> reviewer delegate \u00b7 auto-exit on" }]);
});

test("/auto-exit turns it back on for the next normal completion", async () => {
	const s = session({ parentEnv: "some-parent", autoExitEnv: "1" });
	await s.start();
	await s.type("wait");
	await s.command("auto-exit");
	assert.match(s.notes.at(-1) ?? "", /next.*completion/i);
	await s.run("completed");
	assert.equal(s.shutdowns(), 1);
});

test("/auto-exit works in a delegate started with auto-exit off", async () => {
	const s = session({ parentEnv: "some-parent", autoExitEnv: "0" });
	await s.start();
	await s.command("auto-exit");
	await s.run("completed");
	assert.equal(s.shutdowns(), 1);
});

// ---------------------------------------------------------------------------
// Paseo uses the same completion gate but archives instead of shutting Pi down.

const PASEO_AGENT = "42c2a464-e9de-45fd-961a-ef84ea1bf589";

/** A real SDK client with only its daemon transport mocked, scoped to this test. */
function paseo(t: TestContext, options: SessionOptions = {}) {
	mkdirSync(".scratch/tmp", { recursive: true });
	const home = mkdtempSync(join(process.cwd(), ".scratch/tmp/paseo-exit-"));
	writeFileSync(join(home, "paseo.pid"), JSON.stringify({ listen: "127.0.0.1:1" }));
	writeFileSync(join(home, "local-credential"), "not-a-real-credential");
	const oldHome = process.env.PASEO_HOME;
	process.env.PASEO_HOME = home;
	process.env.PASEO_AGENT_ID = PASEO_AGENT;
	const s = session({ parentEnv: "some-parent", autoExitEnv: "1", ...options });
	const calls: string[] = [];
	const replies: unknown[] = [];
	s.events.on("message:reply", (data) => {
		const payload = data as { envelope?: unknown };
		replies.push(data);
		payload.envelope = { id: "delivered-reply" };
	});
	t.mock.method(DaemonClient.prototype, "connect", async () => {
		calls.push("connect");
	});
	t.mock.method(DaemonClient.prototype, "close", async () => {
		calls.push("close");
	});
	t.mock.method(DaemonClient.prototype, "fetchAgent", async () => ({
		agent: { id: PASEO_AGENT, labels: { "pi-squire": "1" }, runtimeInfo: { sessionId: s.parent } },
	}));
	t.mock.method(DaemonClient.prototype, "fetchAgents", async () => ({
		entries: [],
		pageInfo: { hasMore: false },
	}));
	t.mock.method(DaemonClient.prototype, "archiveAgent", async (id: string) => {
		assert.equal(id, PASEO_AGENT);
		assert.equal(replies.length, 1, "the final reply is durable before archive");
		assert.deepEqual(JSON.parse(readFileSync(taskStatePath(s.parent), "utf8")).requests, []);
		calls.push("archive");
		return { archivedAt: "2026-01-01T00:00:00Z" };
	});
	t.after(async () => {
		await s.shutdown();
		delete process.env.PASEO_AGENT_ID;
		if (oldHome === undefined) delete process.env.PASEO_HOME;
		else process.env.PASEO_HOME = oldHome;
		rmSync(home, { recursive: true, force: true });
	});
	const task = (id = "paseo-task"): void => {
		s.events.emit("message:inbound", {
			envelope: { id, from: "some-parent", kind: "request", body: "do the task" },
			handled: false,
		});
	};
	return { s, calls, replies, task };
}

for (const end of ["completed", "error"] as const) {
	test(`Paseo archives once after its delivered ${end} result without calling ctx.shutdown`, async (t) => {
		const { s, calls, replies, task } = paseo(t);
		await s.start();
		task();
		await s.run(end);
		await s.fire("agent_settled");
		assert.deepEqual(calls, ["connect", "archive", "close"]);
		assert.equal(replies.length, 1);
		assert.equal((replies[0] as { status: string }).status, end === "completed" ? "done" : "failed");
		assert.equal(s.shutdowns(), 0);
	});
}

for (const control of ["off", "typed", "aborted", "stopped", "reply-failed"] as const) {
	test(`Paseo stays open for ${control} even after another settle`, async (t) => {
		const { s, calls, task } = paseo(t, { autoExitEnv: control === "off" ? "0" : "1" });
		await s.start();
		task();
		if (control === "typed") await s.type("keep working");
		if (control === "reply-failed")
			s.events.on("message:reply", (data) => {
				(data as { error?: string }).error = "delivery failed";
			});
		await s.run(control === "aborted" || control === "stopped" ? control : "completed");
		await s.fire("agent_settled");
		assert.deepEqual(calls, []);
		assert.equal(s.shutdowns(), 0);
	});
}

test("a Paseo root never archives and an invalid self id never connects or shuts down", async (t) => {
	const root = paseo(t, { parentEnv: undefined });
	await root.s.start();
	await root.s.run();
	assert.deepEqual(root.calls, []);
	await root.s.shutdown();
	const child = paseo(t);
	await child.s.start();
	child.task();
	process.env.PASEO_AGENT_ID = "inherited-but-not-an-agent";
	await child.s.run();
	assert.deepEqual(child.calls, []);
	assert.match(child.s.errors.join("\n"), /could not auto-archive.*not a UUID/);
	assert.equal(child.s.shutdowns(), 0);
});

test("Paseo rearming cannot discard a held task after a failed run", async (t) => {
	const { s, calls, replies, task } = paseo(t);
	await s.start();
	task();
	await s.run("aborted");
	await s.command("auto-exit");
	await s.run("error");
	assert.deepEqual(calls, []);
	assert.equal(replies.length, 0);
	await s.run();
	assert.deepEqual(calls, ["connect", "archive", "close"]);
});

test("tmux and Herdr keep ctx.shutdown and never connect to the Paseo SDK", async (t) => {
	let connects = 0;
	t.mock.method(DaemonClient.prototype, "connect", async () => {
		connects++;
	});
	const wire = new HerdrWire();
	try {
		for (const multiplexer of [undefined, wire.client]) {
			const s = session({ parentEnv: "some-parent", autoExitEnv: "1", multiplexer });
			await s.start();
			await s.run();
			assert.equal(s.shutdowns(), 1);
			await s.shutdown();
		}
		assert.equal(connects, 0);
	} finally {
		wire.dispose();
	}
});

test("a Paseo archive failure preserves the delivered result and never retries on duplicate settle", async (t) => {
	const { s, calls, replies, task } = paseo(t);
	t.mock.method(DaemonClient.prototype, "archiveAgent", async () => {
		throw new Error("archive refused");
	});
	await s.start();
	task();
	await s.run();
	await s.fire("agent_settled");
	assert.deepEqual(calls, ["connect", "close"]);
	assert.equal(replies.length, 1);
	assert.match(s.errors.join("\n"), /could not auto-archive.*archive refused.*no automatic cleanup retry/);
	assert.equal(s.shutdowns(), 0);
});

for (const race of [
	"typed",
	"extension-input",
	"new-run",
	"pending",
	"busy",
	"owner",
	"reload",
	"new-task",
	"self-id",
] as const) {
	test(`Paseo revalidates ${race} after asynchronous connection`, async (t) => {
		const { s, calls, task } = paseo(t);
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		t.mock.method(DaemonClient.prototype, "connect", async () => {
			calls.push("connect");
			entered.resolve();
			await gate.promise;
		});
		await s.start();
		task();
		await s.run();
		await entered.promise;
		await s.fire("agent_settled"); // A replay while archive is pending must not start another one.
		switch (race) {
			case "typed":
				await s.type("new work");
				break;
			case "extension-input":
				await s.fire("input", { source: "extension", text: "new work" });
				break;
			case "new-run":
				await s.fire("agent_start");
				break;
			case "pending":
				s.context.hasPendingMessages = () => true;
				break;
			case "busy":
				s.context.isIdle = () => false;
				break;
			case "owner":
				await s.shutdown();
				break;
			case "reload":
				await s.fire("session_start", { reason: "reload" });
				break;
			case "new-task":
				task("next-task");
				break;
			case "self-id":
				process.env.PASEO_AGENT_ID = "48284603-8618-4094-b198-70f57b65108d";
				break;
		}
		gate.resolve();
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(calls, ["connect", "close"]);
		assert.equal(s.shutdowns(), 0);
	});
}

for (const invalidate of [false, true]) {
	test(`Paseo retains the newest completed generation during slow cleanup, canceled afterward=${invalidate}`, async (t) => {
		const { s, calls, replies, task } = paseo(t);
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		let connections = 0;
		t.mock.method(DaemonClient.prototype, "connect", async () => {
			calls.push("connect");
			if (++connections === 1) {
				entered.resolve();
				await gate.promise;
			}
		});
		t.mock.method(DaemonClient.prototype, "archiveAgent", async () => {
			assert.equal(replies.length, 3, "all three task results were delivered before cleanup");
			calls.push("archive");
			return { archivedAt: "2026-01-01T00:00:00Z" };
		});
		await s.start();
		task();
		await s.run();
		await entered.promise;
		for (const id of ["second", "newest"]) {
			await s.fire("input", { source: "extension", text: "next task" });
			task(id);
			await s.run();
		}
		if (invalidate) await s.type("keep it open");
		gate.resolve();
		await new Promise<void>((resolve) => setImmediate(resolve));
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(calls.filter((call) => call === "archive").length, invalidate ? 0 : 1);
		assert.equal(connections, invalidate ? 1 : 2, "only the newest intent can open another connection");
		assert.equal(s.shutdowns(), 0);
	});
}

test("queued input before deferred Paseo cleanup prevents even a connection", async (t) => {
	const { s, calls, task } = paseo(t);
	await s.start();
	task();
	await s.fire("agent_end", {
		messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "answer" }] }],
	});
	await s.fire("agent_settled");
	await s.type("keep it open");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(calls, []);
});

test("Paseo waits for nested task completion and a result-processing run, even for a kept-open child", async (t) => {
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(join(agentDir, "squire", "settings.json"), JSON.stringify({ maxDepth: 2 }));
	writeAgent("manager", agentFile({ ...SCOUT, allow_nested_delegation: "[keeper]" }));
	writeAgent("keeper", agentFile({ ...SCOUT, auto_exit: "false" }));
	const api = new FakePaseo();
	const { s, calls, replies, task } = paseo(t, {
		agentEnv: "manager",
		multiplexer: createPaseoHost(api, { PASEO_AGENT_ID: PASEO_AGENT }),
	});
	await s.start();
	task();
	await s.toolCall("delegate", { agent: "keeper", task: "nested work" });
	const record = s.entries.find((entry) => entry.customType === "delegate-start-v2")?.data;
	assert.ok(record);
	await s.run("error");
	assert.deepEqual(calls, [], "an intermediate failure is not a final task result");
	assert.equal(replies.length, 0);
	s.events.emit("message:inbound", {
		envelope: {
			id: "nested-reply",
			from: record.sessionId,
			to: s.parent,
			in_reply_to: [record.requestId],
			status: "done",
			ts: "2026-11-11T00:00:00.000Z",
			body: "nested work finished",
		},
		path: join(agentDir, "nested-reply.json"),
		requests: [],
		handled: false,
	});
	await s.fire("agent_settled");
	assert.deepEqual(calls, [], "arrival and another settle do not process a result");
	await s.run();
	assert.deepEqual(calls, ["connect", "archive", "close"]);
	assert.equal(api.running.size, 1, "the keeper stays open after its task result");
	assert.equal(readIdentity(String(record.sessionId))?.autoExit, false);
});

test("Paseo honors roster defaults and explicit auto_exit in launch env, identity, record and status", async () => {
	writeAgent("keeper", agentFile({ ...SCOUT, auto_exit: "false" }));
	writeAgent("scout", agentFile(SCOUT));
	const api = new FakePaseo();
	const s = session({ multiplexer: createPaseoHost(api, { PASEO_AGENT_ID: PASEO_AGENT }) });
	await s.start();
	try {
		for (const [agent, auto_exit] of [
			["scout", undefined],
			["scout", false],
			["keeper", true],
			["keeper", undefined],
		] as const)
			await s.toolCall("delegate", { agent, task: "go", auto_exit });
		assert.deepEqual(
			api.created.map(({ env }) => env.PI_DELEGATE_AUTO_EXIT),
			["1", "0", "1", "0"],
		);
		const records = s.entries.filter((entry) => entry.customType === "delegate-start-v2");
		assert.deepEqual(
			records.map(({ data }) => data.autoExit),
			[true, false, true, false],
		);
		assert.deepEqual(
			api.created.map(({ agentId }) => readIdentity(agentId)?.autoExit),
			[true, false, true, false],
		);
		assert.deepEqual(
			api.created.map(({ agentId }) => readIdentity(`paseo-session-${agentId}`)?.autoExit),
			[true, false, true, false],
		);
		const status = (await s.toolCall("delegation_status", {})).content[0].text;
		assert.match(status, /auto-exit: on — the Paseo agent is archived/);
		assert.match(status, /auto-exit: off — the Paseo agent stays open/);
	} finally {
		await s.shutdown();
	}
});

// ---------------------------------------------------------------------------
// The delegate: its task

test("the parent's request reaches the delegate as a user prompt; other mail is left to the provider", async () => {
	const s = session({ parentEnv: "some-parent", autoExitEnv: "1" });
	await s.start();
	const task = {
		envelope: { id: "task-id", from: "some-parent", kind: "request", body: "do the thing" },
		handled: false,
	};
	const peer = { envelope: { from: "someone-else", kind: "request", body: "x" }, handled: false };
	const note = { envelope: { from: "some-parent", kind: "message", body: "y" }, handled: false };
	for (const payload of [task, peer, note]) s.events.emit("message:inbound", payload);
	assert.deepEqual([task.handled, peer.handled, note.handled], [true, false, false]);
	assert.equal(s.userMessages.length, 1);
	assert.match(s.userMessages[0].text, /^\[delegate\] Your task, from the session that started you \(some-parent\)/);
	assert.match(s.userMessages[0].text, /\n\ndo the thing$/);
	assert.deepEqual(s.userMessages[0].options, { deliverAs: "steer" });
});
