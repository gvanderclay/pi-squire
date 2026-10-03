// `auto-exit`: a delegate closes itself after a normal completion unless the
// user took over. The parent resolves the setting (call, then agent, then on)
// and passes it in the launch environment; the delegate's side shuts Pi down
// after the run settles, and stays when the user typed, stopped a run, or the
// run failed. `/auto-exit` inside the delegate turns it back on.

import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { agentFile, cleanup, resetRoot, session, writeAgent } from "./harness.ts";

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

test("an agent's auto-exit: false is its default, and a call beats it either way", async () => {
	writeAgent("keeper", agentFile({ ...SCOUT, "auto-exit": "false" }));
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
	assert.equal(s.sendCalls[1].body, "do the thing"); // the flag is not part of the task
});

test("an auto-exit that is not true or false leaves the agent out with a warning", async () => {
	writeAgent("odd", agentFile({ ...SCOUT, "auto-exit": "sometimes" }));
	const s = session();
	await s.delegate("odd do the thing");
	assert.deepEqual(s.tmux.opened, []);
	assert.ok(
		s.warnings.some((warning) => /auto-exit "sometimes"/.test(warning)),
		s.warnings.join("\n"),
	);
});

test("the tool describes auto_exit, and completions offer both flags", async () => {
	writeAgent("scout", agentFile(SCOUT));
	const s = session();
	await s.start();
	assert.match(JSON.stringify(s.tool("delegate").parameters), /auto_exit/);
	assert.match(s.tool("delegate").description, /auto_exit/);
	assert.deepEqual(
		(await s.completions("scout --"))?.map((item) => item.label),
		["--model", "--thinking", "--label", "--auto-exit", "--no-auto-exit"],
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

test("inside a delegate only /auto-exit is registered, never /delegate or the tools", async () => {
	const s = session({ parentEnv: "some-parent", autoExitEnv: "1" });
	assert.deepEqual(s.commands(), ["auto-exit"]);
	assert.deepEqual(s.tools(), []);
});

test("with auto-exit on, a normal completion shuts the delegate down after the settle", async () => {
	const s = session({ parentEnv: "some-parent", autoExitEnv: "1" });
	await s.start();
	await s.run("completed");
	assert.equal(s.shutdowns(), 1);
});

test("with auto-exit off, a normal completion leaves the delegate running", async () => {
	const s = session({ parentEnv: "some-parent", autoExitEnv: "0" });
	await s.start();
	await s.run("completed");
	assert.equal(s.shutdowns(), 0);
});

test("a failed run does not exit, and the next normal completion does", async () => {
	const s = session({ parentEnv: "some-parent", autoExitEnv: "1" });
	await s.start();
	await s.run("error");
	assert.equal(s.shutdowns(), 0);
	await s.run("completed");
	assert.equal(s.shutdowns(), 1);
});

test("a usage-limit failure exits like a completion when auto-exit is on, and only then", async () => {
	const limit = { errorMessage: '429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}' };
	for (const [autoExitEnv, shutdowns] of [
		["1", 1],
		["0", 0],
	] as const) {
		const s = session({ parentEnv: "some-parent", autoExitEnv });
		await s.start();
		await s.run("error", limit);
		assert.equal(s.shutdowns(), shutdowns, `auto-exit ${autoExitEnv}`);
	}
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
// The delegate: its task

test("the parent's request reaches the delegate as a user prompt; other mail is left to the provider", async () => {
	const s = session({ parentEnv: "some-parent", autoExitEnv: "1" });
	await s.start();
	const task = { envelope: { from: "some-parent", kind: "request", body: "do the thing" }, handled: false };
	const peer = { envelope: { from: "someone-else", kind: "request", body: "x" }, handled: false };
	const note = { envelope: { from: "some-parent", kind: "message", body: "y" }, handled: false };
	for (const payload of [task, peer, note]) s.events.emit("message:inbound", payload);
	assert.deepEqual([task.handled, peer.handled, note.handled], [true, false, false]);
	assert.equal(s.userMessages.length, 1);
	assert.match(s.userMessages[0].text, /^\[delegate\] Your task, from the session that started you \(some-parent\)/);
	assert.match(s.userMessages[0].text, /\n\ndo the thing$/);
	assert.deepEqual(s.userMessages[0].options, { deliverAs: "steer" });
});
