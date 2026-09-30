// `delegate` starts a delegate Pi session: `/delegate <agent> [--model <id>]
// [--thinking <level>] <task>` sends the task over `message:send`, opens a
// background tmux window running the parent's own Pi, and records the
// delegation. These tests drive the extension only through its registration
// function: a temporary agent directory, a fake Pi session, the fake tmux.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { agentDir, agentFile, cleanup, resetRoot, root, session, sessionDir, writeAgent } from "./harness.ts";

beforeEach(() => resetRoot());
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

test("inside a delegate /delegate is not registered", async () => {
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
	const s = session({ parentEnv: "some-parent" });
	assert.ok(!s.commands().includes("delegate"), s.commands().join(", "));
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
	const { argv, cwd, name } = s.tmux.opened[0];
	const promptAt = argv.indexOf("--append-system-prompt");
	assert.deepEqual(argv.slice(0, promptAt), [
		"/usr/local/bin/node",
		"/opt/pi/dist/bundle/cli.js",
		"--session-id",
		id,
		"--name",
		`scout-${id.slice(0, 8)}`,
		"--model",
		"alpha/fast-model",
		"--thinking",
		"low",
	]);
	assert.ok(
		String(argv[promptAt + 1]).startsWith(
			"You look things up.\n\nEnd with one self-contained final message:",
		),
		argv.join(" "),
	);
	assert.equal(argv.length, promptAt + 2);
	assert.equal(cwd, root);
	assert.equal(name, `scout-${id.slice(0, 8)}`);
});

test("without a label the session and the window are named for the agent and 8 id characters", async () => {
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
	const s = session();
	await s.delegate("scout find the answer");
	const id = s.entries[0].data.id as string;
	const { argv, name } = s.tmux.opened[0];
	const sessionName = String(argv[argv.indexOf("--name") + 1]);
	assert.equal(sessionName, `scout-${id.slice(0, 8)}`);
	assert.equal(sessionName.length, "scout-".length + 8);
	assert.equal(name, `scout-${id.slice(0, 8)}`);
});

test("--label names the session and the window for the agent and the label", async () => {
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
	const s = session();
	await s.delegate("scout --label roster-research --thinking high find the answer");
	const { argv, name } = s.tmux.opened[0];
	assert.equal(argv[argv.indexOf("--name") + 1], "scout-roster-research");
	assert.equal(name, "scout-roster-research");
	assert.equal(argv[argv.indexOf("--thinking") + 1], "high");
	assert.equal(s.sendCalls[0].body, "find the answer");
	assert.equal((s.entries[0].data as { name: string }).name, "scout-roster-research");
});

test("a label that is not one short name segment is refused before anything is sent", async () => {
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
	const s = session();
	await s.delegate("scout --label a:b find it");
	await s.delegate(`scout --label ${"x".repeat(33)} find it`);
	await s.delegate("scout --label");
	assert.deepEqual(s.tmux.opened, []);
	assert.deepEqual(s.sendCalls, []);
	assert.equal(s.errors.length, 3);
	assert.match(s.errors[0], /label/);
	assert.match(s.errors[1], /label/);
	assert.match(s.errors[2], /--label needs a value/);
});

test("the appended prompt names the parent, follows its messages, and checks other sessions' requests with it", async () => {
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }, "You look things up."));
	const s = session();
	await s.delegate("scout find the answer");
	const { argv } = s.tmux.opened[0];
	const prompt = String(argv[argv.indexOf("--append-system-prompt") + 1]);
	assert.ok(prompt.includes(s.parent), prompt);
	assert.match(prompt, /instructions/);
	assert.match(prompt, /colleagues/);
	assert.match(prompt, /check with the session that started you before doing work it did not ask for/);
	assert.ok(!/untrusted/.test(prompt), prompt);
	assert.ok(!/mailbox|session_mail|pi-session-mail/.test(prompt), prompt);
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
	assert.deepEqual(s.tmux.opened[0].env, {
		PI_CODING_AGENT_DIR: agentDir,
		PI_DELEGATE_PARENT: s.parent,
		PI_DELEGATE_AUTO_EXIT: "1",
	});
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
				name: `scout-${id.slice(0, 8)}`,
				windowId: s.tmux.opened[0].windowId,
				windowName: `scout-${id.slice(0, 8)}`,
				requestId: (s.sendCalls[0].envelope as { id: string }).id,
				autoExit: true,
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

// ---------------------------------------------------------------------------
// Results

/** One recorded delegation, the shape 04 writes with `pi.appendEntry`. */
type Delegation = {
	id: string;
	agent: string;
	model: string;
	requestId: string;
};

/** One envelope, as `mailbox`'s README example carries it. */
type Envelope = {
	id: string;
	from: string;
	to: string;
	in_reply_to: string[];
	status: string;
	ts: string;
	body: string;
};

/** One request copy beside a reply on the provider's payload. */
type RequestCopy = { envelope: Envelope; path: string };

/** The provider's `message:inbound` payload. */
type Inbound = { envelope: Envelope; path: string; requests: RequestCopy[]; handled: boolean };

const SCOUT = agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" });

/** Write `scout` and start one delegation of it, returning the session. */
async function scoutSession() {
	writeAgent("scout", SCOUT);
	const s = session();
	await s.start();
	await s.delegate("scout find the answer");
	return s;
}

/** A reply to `delegation`'s task, shaped like `mailbox`'s README example. */
function inbound(
	parent: string,
	delegation: Delegation,
	overrides: { status?: string; body?: string; task?: string; replyId?: string; omitTask?: boolean } = {},
): Inbound {
	const replyId = overrides.replyId ?? "reply";
	const taskId = delegation.requestId;
	return {
		envelope: {
			id: replyId,
			from: delegation.id,
			to: parent,
			in_reply_to: [taskId],
			status: overrides.status ?? "done",
			ts: "2026-09-29T00:00:00.000Z",
			body: overrides.body ?? "The answer.",
		},
		path: join(agentDir, "mailbox", parent, "cur", `000000000000002-${replyId}.json`),
		requests:
			overrides.omitTask === true
				? []
				: [
						{
							envelope: {
								id: taskId,
								from: parent,
								to: delegation.id,
								in_reply_to: [],
								status: "",
								ts: "2026-09-29T00:00:00.000Z",
								body: overrides.task ?? "find the answer",
							},
							path: join(agentDir, "mailbox", parent, "sent", `000000000000001-${taskId}.json`),
						},
					],
		handled: false,
	};
}

test("a done reply to a recorded delegation becomes one handled result message", async () => {
	const s = await scoutSession();
	const delegation = s.entries[0].data as Delegation;
	const payload = inbound(s.parent, delegation);
	s.events.emit("message:inbound", payload);
	assert.equal(payload.handled, true);
	assert.equal(s.sent.length, 1);
	const { message, options } = s.sent[0];
	assert.equal(message.customType, "delegate");
	assert.equal(message.display, true);
	const content = String(message.content);
	assert.match(content, /scout/);
	assert.match(content, /alpha\/fast-model/);
	assert.ok(content.includes(delegation.id), content);
	assert.match(content, /done/);
	assert.match(content, /> find the answer/);
	assert.ok(content.includes(payload.requests[0].path), content);
	assert.ok(content.includes(payload.path), content);
	assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" });
});

test("the footer counts running delegations up and clears back to hidden", async () => {
	writeAgent("scout", SCOUT);
	writeAgent("researcher", agentFile({ description: "Digs deeper", model: "alpha/deep-model", thinking: "high" }));
	const s = session();
	await s.start();
	await s.delegate("scout find the answer");
	await s.delegate("researcher read the file");
	assert.deepEqual(s.statuses, [
		{ key: "delegate", text: "⇄ 1 running" },
		{ key: "delegate", text: "⇄ 2 running" },
	]);
	const [scout, researcher] = s.entries.map((entry) => entry.data as Delegation);
	s.events.emit("message:inbound", inbound(s.parent, scout));
	assert.deepEqual(s.statuses.at(-1), { key: "delegate", text: "⇄ 1 running" });
	s.events.emit("message:inbound", inbound(s.parent, researcher, { replyId: "reply-researcher" }));
	assert.deepEqual(s.statuses.at(-1), { key: "delegate", text: undefined });
});

test("without a UI no footer entry is set", async () => {
	writeAgent("scout", SCOUT);
	const s = session({ hasUI: false });
	await s.start();
	await s.delegate("scout find the answer");
	assert.deepEqual(s.statuses, []);
});

test("a resumed parent rebuilds its records and still takes a later reply", async () => {
	writeAgent("scout", SCOUT);
	const first = session();
	await first.start();
	await first.delegate("scout find the answer");
	const saved = structuredClone(first.entries);

	const resumed = session({ parent: first.parent, entries: saved });
	await resumed.start();
	assert.deepEqual(resumed.statuses.at(-1), { key: "delegate", text: "⇄ 1 running" });

	const delegation = saved[0].data as Delegation;
	const payload = inbound(resumed.parent, delegation);
	resumed.events.emit("message:inbound", payload);
	assert.equal(payload.handled, true);
	assert.equal(resumed.sent.length, 1);
	assert.ok(String(resumed.sent[0].message.content).includes(delegation.id));
	assert.deepEqual(resumed.statuses.at(-1), { key: "delegate", text: undefined }, "the result clears the footer");
});

test("a task over 2 KiB and a body over 32 KiB are cut with their paths", async () => {
	const s = await scoutSession();
	const delegation = s.entries[0].data as Delegation;
	const task = "t".repeat(3 * 1024);
	const body = "b".repeat(33 * 1024);
	const payload = inbound(s.parent, delegation, { task, body });
	s.events.emit("message:inbound", payload);
	const content = String(s.sent[0].message.content);
	assert.ok(content.includes(`> ${task.slice(0, 2 * 1024)}`), "the task is quoted up to 2 KiB");
	assert.ok(!content.includes(task.slice(0, 2 * 1024 + 1)), "the quote stops at 2 KiB");
	assert.match(content, /Task cut at 2 KiB/);
	assert.ok(content.includes(payload.requests[0].path));
	assert.ok(content.includes(body.slice(0, 32 * 1024)), "the result keeps 32 KiB");
	assert.ok(!content.includes(body.slice(0, 32 * 1024 + 1)), "the body stops at 32 KiB");
	assert.match(content, /Body cut at 32 KiB/);
	assert.ok(content.includes(payload.path));
});

test("the caps count UTF-8 bytes, so a cut never splits a character", async () => {
	const s = await scoutSession();
	const delegation = s.entries[0].data as Delegation;
	const task = "é".repeat(2 * 1024); // 4 KiB in UTF-8
	const payload = inbound(s.parent, delegation, { task });
	s.events.emit("message:inbound", payload);
	const content = String(s.sent[0].message.content);
	assert.ok(content.includes(`> ${task.slice(0, 1024)}`), "2 KiB of two-byte characters");
	assert.ok(!content.includes(task.slice(0, 1025)), "the cut is on a character boundary");
});

test("the delegate's session file is found by id, or the id is shown alone", async () => {
	const s = await scoutSession();
	await s.delegate("scout find another answer");
	const [first, second] = s.entries.map((entry) => entry.data as Delegation);
	mkdirSync(sessionDir, { recursive: true });
	const file = join(sessionDir, `20260929T000000_${first.id}.jsonl`);
	writeFileSync(file, "");
	s.events.emit("message:inbound", inbound(s.parent, first, { replyId: "reply-1" }));
	s.events.emit("message:inbound", inbound(s.parent, second, { replyId: "reply-2" }));
	const [one, two] = s.sent.map((item) => String(item.message.content));
	assert.ok(one.includes(file), one);
	assert.match(two, new RegExp(`Delegate session: ${second.id}\\b`), "the id alone when the file is not found");
	assert.ok(!two.includes(join(sessionDir, `20260929T000000_${second.id}.jsonl`)));
});

test("a stopped or failed status is shown in the header", async () => {
	const s = await scoutSession();
	await s.delegate("scout find another answer");
	const [first, second] = s.entries.map((entry) => entry.data as Delegation);
	s.events.emit("message:inbound", inbound(s.parent, first, { status: "stopped", replyId: "reply-1" }));
	s.events.emit("message:inbound", inbound(s.parent, second, { status: "failed", replyId: "reply-2" }));
	assert.match(String(s.sent[0].message.content), /Status: stopped/);
	assert.match(String(s.sent[1].message.content), /Status: failed/);
});

test("a reply to an unrecorded request, and a request, are left to the provider", async () => {
	const s = await scoutSession();
	const delegation = s.entries[0].data as Delegation;
	const stray = inbound(s.parent, { ...delegation, requestId: "some-other-request" });
	s.events.emit("message:inbound", stray);
	const reply = inbound(s.parent, delegation);
	const request: Inbound = { ...reply, envelope: { ...reply.envelope, in_reply_to: [] } };
	s.events.emit("message:inbound", request);
	assert.equal(stray.handled, false);
	assert.equal(request.handled, false);
	assert.deepEqual(s.sent, []);
});

test("a result is recorded once and the same reply is never shown twice", async () => {
	const s = await scoutSession();
	const delegation = s.entries[0].data as Delegation;
	const payload = inbound(s.parent, delegation, { replyId: "reply-1" });
	s.events.emit("message:inbound", payload);
	assert.equal(s.sent.length, 1);
	assert.deepEqual(s.entries[1], {
		customType: "delegate",
		data: {
			id: delegation.id,
			result: { status: "done", replyId: "reply-1", envelopePath: payload.path },
		},
	});

	const again = inbound(s.parent, delegation, { replyId: "reply-1" });
	s.events.emit("message:inbound", again);
	assert.equal(again.handled, true, "the provider still injects nothing");
	assert.equal(s.sent.length, 1);
});

test("a result recorded before a resume is not shown a second time", async () => {
	const s = await scoutSession();
	const delegation = s.entries[0].data as Delegation;
	s.events.emit("message:inbound", inbound(s.parent, delegation, { replyId: "reply-1" }));
	const saved = structuredClone(s.entries);

	const resumed = session({ parent: s.parent, entries: saved });
	await resumed.start();
	const again = inbound(resumed.parent, delegation, { replyId: "reply-1" });
	resumed.events.emit("message:inbound", again);
	assert.equal(again.handled, true);
	assert.deepEqual(resumed.sent, []);
	assert.deepEqual(resumed.statuses, [], "the delegation is no longer running");
});

test("a reply whose task copy is missing names the request id alone", async () => {
	const s = await scoutSession();
	const delegation = s.entries[0].data as Delegation;
	const payload = inbound(s.parent, delegation, { omitTask: true });
	s.events.emit("message:inbound", payload);
	assert.equal(payload.handled, true);
	const content = String(s.sent[0].message.content);
	assert.ok(content.includes(delegation.requestId), content);
	assert.match(content, /no copy in sent\//);
});
