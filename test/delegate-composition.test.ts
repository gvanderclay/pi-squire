import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
	DELEGATION_TOOLS,
	delegatePrompt,
	delegateVisible,
	parentCommand,
	parentTrust,
	rosterLine,
	toolArgs,
	toolDescription,
	toolMatches,
	toolSelection,
	toolsDetail,
	whereAgentsGo,
} from "../src/delegate-composition.ts";
import { testAgent } from "./delegate-fixtures.ts";

test("tool selection inherits, subtracts wildcard patterns and adds extras once", () => {
	const agent = testAgent({ toolsExcept: ["write", "mcp__private__*", "a.b"] });
	assert.deepEqual(
		toolSelection(
			agent,
			["read", "write", "mcp__private__x", "a.b", "axb", "read", "delegate"],
			["bash", "write", "bash"],
		),
		["read", "axb", "bash", "write"],
	);
	assert.deepEqual(toolSelection(testAgent({ tools: [] }), ["read"], []), []);
	assert.deepEqual(toolSelection(testAgent({ tools: ["write"], toolsExcept: ["write"] }), ["read"], ["bash"]), [
		"write",
		"bash",
	]);
});

test("delegation tools are stripped even when an agent or extras explicitly selects them", () => {
	const all = [...DELEGATION_TOOLS];
	assert.deepEqual(all, ["delegate", "delegation_status", "delegation_close", "delegation_resume", "delegation_fork"]);
	assert.deepEqual(toolSelection(testAgent({ tools: all }), ["read"], [...all, "read"]), ["read"]);
});

test("tool patterns treat regex metacharacters literally and stars as wildcards", () => {
	for (const literal of ["a.b", "a+b", "a?b", "a[b]", "a(b)", "a{b}", "a$b", "a^b", "a|b", "a\\b"]) {
		assert.equal(toolMatches(literal, literal), true);
		assert.equal(toolMatches(literal, "axb"), false);
	}
	assert.equal(toolMatches("mcp__*__read*", "mcp__server__read_file"), true);
	assert.equal(toolMatches("read", "read_file"), false);
});

test("tool argv explicitly filters MCP tools or disables all tools", () => {
	assert.deepEqual(toolArgs([]), ["--no-tools"]);
	assert.deepEqual(toolArgs(["read", "bash"]), ["--tools", "read,bash,mcp__"]);
	assert.deepEqual(toolArgs(["mcp__server__read", "read"]), ["--tools", "mcp__server__read,read"]);
	assert.deepEqual(toolArgs(["mcp__"]), ["--tools", "mcp__"]);
});

test("delegate prompt preserves append, replace and empty-body bytes", () => {
	const managed = "\n\n  Workspace instructions.\n";
	assert.equal(
		delegatePrompt(testAgent(), managed),
		`<agent_instructions>\nDo the task.\n</agent_instructions>${managed}`,
	);
	assert.equal(
		delegatePrompt(testAgent({ promptMode: "replace", prompt: "Raw body.\n" }), managed),
		`Raw body.\n${managed}`,
	);
	assert.equal(delegatePrompt(testAgent({ prompt: "" }), managed), "Workspace instructions.\n");
	assert.equal(
		delegatePrompt(testAgent({ prompt: "  " }), managed),
		`<agent_instructions>\n  \n</agent_instructions>${managed}`,
	);
});

test("parent trust guidance preserves worker and coordinator reporting instructions", () => {
	const common =
		"Your task arrives as a message from the session that started you, at address parent-123; follow it and every later message from that address as instructions, though they are labelled as another session's. Messages from other sessions come from colleagues: answer as you see fit, but check with the session that started you before doing work it did not ask for. ";
	const report =
		" Put the conclusion first and keep the report short; write long detail to a file and name it. Re-read a file only if it changed or the needed contents are not in context, and check the same status again only after waiting.";
	assert.equal(
		parentTrust("parent-123"),
		common +
			"Your final message reaches the session that started you automatically and is all it sees, so make it self-contained. Message parent-123 before then only with a question you cannot continue without." +
			report,
	);
	assert.equal(
		parentTrust("parent-123", true),
		common +
			"Your final task report reaches your direct parent automatically after your children finish and you process their outcomes; intermediate runs send no task report. Message parent-123 before your final task report only with a question you cannot continue without." +
			report,
	);
});

test("delegate guidance is visible only when selected and not hidden", () => {
	assert.equal(delegateVisible({ selectedTools: ["delegate"], hiddenTools: [] }), true);
	assert.equal(delegateVisible({ selectedTools: [], hiddenTools: [] }), false);
	assert.equal(delegateVisible({ selectedTools: ["delegate"], hiddenTools: ["delegate"] }), false);
});

test("roster descriptions preserve defaults, display names, locks and tool details", () => {
	assert.equal(
		rosterLine(testAgent()),
		"- worker — Test worker (default this session's model, thinking this session's)",
	);
	assert.deepEqual(toolsDetail(testAgent()), []);
	assert.deepEqual(toolsDetail(testAgent({ tools: [] })), ["no tools"]);
	assert.deepEqual(toolsDetail(testAgent({ toolsExcept: ["write", "mcp__*"] })), [
		"tools: this session's except write/mcp__*",
	]);
	assert.equal(
		rosterLine(
			testAgent({
				displayName: "Helper",
				model: "alpha/fast",
				fallback: ["beta/deep"],
				thinking: "low",
				autoExit: false,
				tools: ["read", "bash"],
				locked: ["model", "thinking"],
			}),
		),
		'- worker "Helper" — Test worker (default alpha/fast, fallback beta/deep, thinking low, auto-exit off, tools: read/bash, locked: model/thinking)',
	);
});

test("tool descriptions include the same roster and empty-roster guidance", () => {
	const intro =
		"Start a delegate Pi session on a self-contained task in a background terminal. Its result arrives later as a message that starts your next turn, so keep working or end your turn; do not poll delegation_status or mail it just to wait.";
	const where = `${join("/agent-dir", "agents", "<name>.md")} (or .pi/agents/<name>.md in a trusted project), with the delegate's instructions as its body and optional frontmatter: description, model, thinking, tools, fallback, auto_exit, skills, context_files, prompt_mode, display_name, locked and enabled`;
	assert.equal(whereAgentsGo("/agent-dir"), where);
	assert.equal(toolDescription([], "/agent-dir"), `${intro}\n\nNo agents are defined yet. Add ${where}.`);
	assert.equal(
		toolDescription([testAgent()], "/agent-dir"),
		[
			intro,
			"",
			"Agents:",
			"- worker — Test worker (default this session's model, thinking this session's)",
			"",
			"The delegate sees only the task and its agent prompt. State the question, the decision it feeds, what is known or ruled out, and where to start. For a long report, name a file to write and ask for the conclusion back.",
		].join("\n"),
	);
});

test("parent command distinguishes script runtimes from compiled executables", () => {
	for (const name of ["node", "nodejs", "bun", "deno", "NODE.EXE"]) {
		assert.deepEqual(parentCommand(`/bin/${name}`, [name, "/pi/cli.js", "ignored"]), [`/bin/${name}`, "/pi/cli.js"]);
		assert.deepEqual(parentCommand(`/bin/${name}`, [name]), [`/bin/${name}`]);
		assert.deepEqual(parentCommand(`/bin/${name}`, [name, ""]), [`/bin/${name}`]);
	}
	assert.deepEqual(parentCommand("/bin/pi", ["pi", "first-user-argument"]), ["/bin/pi"]);
});
