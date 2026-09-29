// `delegate` starts a delegate Pi session: `/delegate <agent> [--model <id>]
// [--thinking <level>] <task>` sends the task over `message:send`, opens a
// background tmux window running the parent's own Pi, and records the
// delegation. These tests drive the extension only through its registration
// function: a temporary agent directory, a fake Pi session, the fake tmux.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import { agentDir, agentFile, cleanup, resetAgents, root, session, writeAgent } from "./harness.ts";

beforeEach(() => resetAgents());
after(() => cleanup());

// ---------------------------------------------------------------------------
// The roster

test("a valid AGENT.md is an agent in the roster and a bad one is left out", async () => {
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
	writeAgent("incomplete", "---\ndescription: no model here\nthinking: low\n---\n\nDo it.\n");
	writeAgent("garbage", "no frontmatter at all\n");
	writeAgent("nonsense", agentFile({ description: "Bad level", model: "alpha/fast-model", thinking: "very" }));
	const s = session();
	assert.deepEqual(
		(await s.completions(""))?.map((item) => item.label),
		["scout"],
	);
	assert.deepEqual(
		(await s.completions("sc"))?.map((item) => item.value),
		["scout"],
	);
});

test("a root with no agents explains how to add one", async () => {
	const s = session();
	await s.delegate("scout do the thing");
	assert.deepEqual(s.tmux.opened, []);
	assert.deepEqual(s.sendCalls, []);
	assert.equal(s.errors.length, 1);
	assert.match(s.errors[0], /AGENT\.md/);
	assert.ok(s.errors[0].includes(`${agentDir}/agents/`), s.errors[0]);
});

test("an unknown agent is refused with the roster's names", async () => {
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
	writeAgent("researcher", agentFile({ description: "Digs deeper", model: "alpha/deep-model", thinking: "high" }));
	const s = session();
	await s.delegate("nobody do the thing");
	assert.deepEqual(s.tmux.opened, []);
	assert.equal(s.errors.length, 1);
	assert.match(s.errors[0], /nobody/);
	assert.match(s.errors[0], /researcher/);
	assert.match(s.errors[0], /scout/);
});

test("inside a delegate nothing is registered", async () => {
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
	const s = session({ parentEnv: "some-parent" });
	assert.deepEqual(s.commands(), []);
});

// ---------------------------------------------------------------------------
// Completions

test("completions offer the flags, the model ids and the thinking levels", async () => {
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
	const s = session();
	await s.start();
	assert.deepEqual(await s.completions("scout --thi"), [{ value: "scout --thinking", label: "--thinking" }]);
	assert.deepEqual(await s.completions("scout --thinking h"), [{ value: "scout --thinking high", label: "high" }]);
	assert.deepEqual(await s.completions("scout --model alpha/"), [
		{ value: "scout --model alpha/fast-model", label: "alpha/fast-model" },
		{ value: "scout --model alpha/deep-model", label: "alpha/deep-model" },
	]);
});

// ---------------------------------------------------------------------------
// Refusals

test("outside tmux nothing is sent and no window opens", async () => {
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
	const s = session();
	s.tmux.inside = false;
	await s.delegate("scout do the thing");
	assert.deepEqual(s.sendCalls, []);
	assert.deepEqual(s.tmux.opened, []);
	assert.deepEqual(s.entries, []);
	assert.equal(s.errors.length, 1);
	assert.match(s.errors[0], /tmux/);
});

test("with no message:* provider the command refuses and opens no window", async () => {
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
	const s = session({ send: "none" });
	await s.delegate("scout do the thing");
	assert.equal(s.sendCalls.length, 1);
	assert.deepEqual(s.tmux.opened, []);
	assert.deepEqual(s.entries, []);
	assert.equal(s.errors.length, 1);
	assert.match(s.errors[0], /message:\*/);
});

test("a provider error is reported and opens no window", async () => {
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
	const s = session({ send: "error" });
	await s.delegate("scout do the thing");
	assert.deepEqual(s.tmux.opened, []);
	assert.deepEqual(s.entries, []);
	assert.equal(s.errors.length, 1);
	assert.match(s.errors[0], /no active session has a mailbox address/);
});

// ---------------------------------------------------------------------------
// Parsing and validation

test("flags override the agent's defaults, and the task arrives verbatim", async () => {
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
	const s = session();
	await s.delegate("scout --model alpha/deep-model --thinking high  run   the --model thing ");
	const { argv } = s.tmux.opened[0];
	assert.deepEqual(argv.slice(argv.indexOf("--model"), argv.indexOf("--append-system-prompt")), [
		"--model",
		"alpha/deep-model",
		"--thinking",
		"high",
	]);
	assert.equal(s.sendCalls[0].body, "run   the --model thing");
});

test("the agent's model and thinking are the defaults", async () => {
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/deep-model", thinking: "xhigh" }));
	const s = session();
	await s.delegate("scout do the thing");
	const { argv } = s.tmux.opened[0];
	assert.ok(argv.includes("alpha/deep-model"), argv.join(" "));
	assert.equal(argv[argv.indexOf("--thinking") + 1], "xhigh");
});

test("an unknown flag and a missing task are usage errors", async () => {
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
	const s = session();
	await s.delegate("scout --verbose do the thing");
	await s.delegate("scout");
	assert.deepEqual(s.tmux.opened, []);
	assert.equal(s.errors.length, 2);
	assert.match(s.errors[0], /unknown flag --verbose/);
	assert.match(s.errors[1], /task is required/);
});

test("an unknown model or thinking level is refused with close matches", async () => {
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
	const s = session();
	await s.delegate("scout --model alpha/fast-modle do it");
	await s.delegate("scout --thinking hihg do it");
	await s.delegate("scout --model alpha do it");
	assert.deepEqual(s.tmux.opened, []);
	assert.deepEqual(s.sendCalls, []);
	assert.equal(s.errors.length, 3);
	assert.match(s.errors[0], /unknown model "alpha\/fast-modle"; close matches: alpha\/fast-model/);
	assert.match(s.errors[1], /unknown thinking level "hihg".*close matches: high/);
	assert.match(s.errors[2], /provider\/id/);
});

test("a malformed AGENT.md is warned about at call time and left out of the roster", async () => {
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
	writeAgent("broken", "---\ndescription: no thinking\nmodel: alpha/fast-model\n---\n\nDo it.\n");
	writeAgent("unreadable", "---\ndescription: [unclosed\nmodel: alpha/fast-model\nthinking: low\n---\n\nDo it.\n");
	const s = session();
	await s.delegate("scout do the thing");
	assert.equal(s.warnings.length, 2);
	assert.match(s.warnings[0], /broken/);
	assert.match(s.warnings[1], /unreadable/);
	assert.equal(s.tmux.opened.length, 1);
	assert.equal(s.tmux.opened[0].name.startsWith("scout-"), true);
});

// ---------------------------------------------------------------------------
// Launch order, argv, env and record

test("the task is written before the window opens, and the delegate id fits both patterns", async () => {
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
	const s = session();
	// A second listener runs after the provider stub and sees the order.
	let openedWhenSent = -1;
	s.events.on("message:send", () => {
		openedWhenSent = s.tmux.opened.length;
	});
	await s.delegate("scout do the thing");
	assert.equal(openedWhenSent, 0);
	const id = s.entries[0].data.id as string;
	assert.equal(s.sendCalls[0].to, id);
	assert.equal(s.sendCalls[0].body, "do the thing");
	assert.match(id, /^[A-Za-z0-9_-]+$/); // a mailbox address
	assert.match(id, /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/); // a Pi session id
});

test("the argv runs the parent's own script pi with the task's flags", async () => {
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }, "You look things up."));
	const s = session();
	const savedExec = process.execPath;
	const savedArgv = process.argv;
	process.execPath = "/usr/local/bin/node";
	process.argv = ["/usr/local/bin/node", "/opt/pi/dist/bundle/cli.js"];
	try {
		await s.delegate("scout find the answer");
	} finally {
		process.execPath = savedExec;
		process.argv = savedArgv;
	}
	const id = s.entries[0].data.id as string;
	assert.deepEqual(s.tmux.opened[0].argv, [
		"/usr/local/bin/node",
		"/opt/pi/dist/bundle/cli.js",
		"--session-id",
		id,
		"--model",
		"alpha/fast-model",
		"--thinking",
		"low",
		"--append-system-prompt",
		"You look things up.\n\nEnd with one self-contained final message: the parent session sees only that message, never this conversation.",
	]);
	assert.equal(s.tmux.opened[0].cwd, root);
	assert.equal(s.tmux.opened[0].name, `scout-${id}`);
});

test("a compiled Pi binary is launched alone, with no script argument", async () => {
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
	const s = session();
	const savedExec = process.execPath;
	const savedArgv = process.argv;
	process.execPath = "/opt/pi/pi";
	process.argv = ["/opt/pi/pi"];
	try {
		await s.delegate("scout find the answer");
	} finally {
		process.execPath = savedExec;
		process.argv = savedArgv;
	}
	assert.deepEqual(s.tmux.opened[0].argv.slice(0, 2), ["/opt/pi/pi", "--session-id"]);
});

test("the child's env names the parent's root and address, and the session dir when set", async () => {
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
	const s = session();
	await s.delegate("scout do the thing");
	assert.deepEqual(s.tmux.opened[0].env, { PI_CODING_AGENT_DIR: agentDir, PI_DELEGATE_PARENT: s.parent });
	process.env.PI_CODING_AGENT_SESSION_DIR = "/tmp/other-sessions";
	const second = session();
	await second.delegate("scout do the thing");
	assert.equal(second.tmux.opened[0].env.PI_CODING_AGENT_SESSION_DIR, "/tmp/other-sessions");
});

test("the delegation is recorded with no task text, and the parent gets a notice", async () => {
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
	const s = session();
	await s.delegate("scout a secret task nobody should record");
	const id = s.entries[0].data.id as string;
	assert.deepEqual(s.entries, [
		{
			customType: "delegate",
			data: {
				id,
				agent: "scout",
				model: "alpha/fast-model",
				thinking: "low",
				windowId: s.tmux.opened[0].windowId,
				windowName: `scout-${id}`,
				requestId: (s.sendCalls[0].envelope as { id: string }).id,
			},
		},
	]);
	assert.ok(!JSON.stringify(s.entries).includes("secret task"), JSON.stringify(s.entries));
	assert.deepEqual(s.sent, []); // nothing entered the model's context
	assert.equal(s.notes.length, 1);
	assert.match(s.notes[0], /scout/);
	assert.match(s.notes[0], new RegExp(id));
});

test("a window that fails to open is reported with the delegation id and recorded nowhere", async () => {
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
	const s = session();
	s.tmux.failOpen = "no server running on /tmp/tmux-501/default";
	await s.delegate("scout do the thing");
	const id = s.sendCalls[0].to as string;
	assert.match(id, /^[0-9a-f-]{36}$/);
	assert.deepEqual(s.entries, []);
	assert.equal(s.sendCalls.length, 1);
	assert.equal(s.errors.length, 1);
	assert.match(s.errors[0], /scout-/);
	assert.match(s.errors[0], /no server running/);
	assert.ok(s.errors[0].includes(id), s.errors[0]);
});
