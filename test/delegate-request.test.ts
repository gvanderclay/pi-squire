import assert from "node:assert/strict";
import { test } from "node:test";
import { THINKING_LEVELS } from "../src/agents.ts";
import {
	closest,
	completions,
	labelProblem,
	parse,
	parseResume,
	RESUME_USAGE,
	resumeCompletions,
	thinkingProblem,
	USAGE,
} from "../src/delegate-request.ts";

test("launch parsing preserves the task after the leading flags", () => {
	assert.deepEqual(
		parse(
			' worker --model alpha/fast --thinking high --label task_1 --cwd "/project with spaces" --no-auto-exit  inspect  this\n--model is task text  ',
		),
		{
			parsed: {
				agent: "worker",
				model: "alpha/fast",
				thinking: "high",
				label: "task_1",
				cwd: "/project with spaces",
				autoExit: false,
				task: "inspect  this\n--model is task text",
			},
		},
	);
	assert.deepEqual(parse("worker --worktree feature --worktree-base main --worktree-source /repo task"), {
		parsed: { agent: "worker", worktree: "feature", worktree_base: "main", worktree_source: "/repo", task: "task" },
	});
});

test("flag quoting only decodes escaped double quotes and backslashes", () => {
	assert.deepEqual(parse(String.raw`worker --label "a\"b\\c\q" task`), {
		parsed: { agent: "worker", label: 'a"b\\c\\q', task: "task" },
	});
	assert.deepEqual(parse('worker --cwd "" task'), { parsed: { agent: "worker", cwd: "", task: "task" } });
	assert.deepEqual(parse("worker --cwd '$HOME' task"), {
		parsed: { agent: "worker", cwd: "'$HOME'", task: "task" },
	});
});

test("repeated flags use the last value, and parsing does not perform validation", () => {
	assert.deepEqual(parse("worker --model a --model b --auto-exit --no-auto-exit --auto-exit task"), {
		parsed: { agent: "worker", model: "b", autoExit: true, task: "task" },
	});
	assert.deepEqual(parse("worker --cwd /a --worktree b task"), {
		parsed: { agent: "worker", cwd: "/a", worktree: "b", task: "task" },
	});
});

test("launch parser refusals retain their usage and precise flag diagnostics", () => {
	for (const [input, error] of [
		["", USAGE],
		["--model a task", `the first argument is the agent name; ${USAGE}`],
		["worker", `a task is required after the agent and flags; ${USAGE}`],
		["worker --unknown task", `unknown flag --unknown; ${USAGE}`],
		["worker -task", `unknown flag -task; ${USAGE}`],
		["worker --model", `--model needs a value; ${USAGE}`],
		["worker --cwd --model x task", `--cwd needs a value; ${USAGE}`],
		['worker --cwd "unfinished', `--cwd's value has no closing quote; ${USAGE}`],
		['worker --cwd "dir"suffix task', `--cwd's quoted value must be followed by a space; ${USAGE}`],
	])
		assert.deepEqual(parse(input), { error }, input);
});

test("resume parsing has its own flag set and preserves the task", () => {
	assert.deepEqual(parseResume(' abc --model "alpha/fast" --thinking low --auto-exit --no-auto-exit do  this\nnext '), {
		request: { id: "abc", model: "alpha/fast", thinking: "low", autoExit: false, task: "do  this\nnext" },
	});
	for (const [input, error] of [
		["", RESUME_USAGE],
		["--model a", `the first argument is the delegation id; ${RESUME_USAGE}`],
		["abc", `a task is required after the id and flags; ${RESUME_USAGE}`],
		["abc --label a task", `unknown flag --label; ${RESUME_USAGE}`],
		["abc --thinking --model a", `--thinking needs a value; ${RESUME_USAGE}`],
		['abc --model "a"b task', `--model's quoted value must be followed by a space; ${RESUME_USAGE}`],
	])
		assert.deepEqual(parseResume(input), { error }, input);
});

test("labels are bounded ASCII name segments, not display text", () => {
	for (const value of ["a", "A0_-", "a".repeat(32)]) assert.equal(labelProblem(value), undefined);
	for (const value of ["", "_a", "-a", "a b", "é", "a".repeat(33)]) {
		assert.equal(
			labelProblem(value),
			`label ${JSON.stringify(value)} must be at most 32 letters, digits, _ or -, starting with a letter or digit`,
		);
	}
});

test("thinking validation and close matches are deterministic", () => {
	for (const level of THINKING_LEVELS) assert.equal(thinkingProblem(level), undefined);
	assert.equal(
		thinkingProblem("hihg"),
		`unknown thinking level "hihg"; levels: ${THINKING_LEVELS.join(", ")}; close matches: high`,
	);
	assert.deepEqual(closest("CAT", ["cut", "bat", "cat", "coat", "unrelated"]), ["cat", "bat", "coat"]);
	assert.deepEqual(closest("x", ["unrelated"]), []);
});

const agents = () => ["worker", "writer"];
const models = () => ["alpha/fast", "beta/deep"];
const ids = () => ["abc123", "abc456"];

test("launch completions retain the full prefix, case sensitivity and source order", () => {
	assert.deepEqual(completions("w", agents, models), [
		{ value: "worker", label: "worker" },
		{ value: "writer", label: "writer" },
	]);
	assert.deepEqual(completions("  worker --model a", agents, models), [
		{ value: "  worker --model alpha/fast", label: "alpha/fast" },
	]);
	assert.deepEqual(completions("worker --thinking h", agents, models), [
		{ value: "worker --thinking high", label: "high" },
	]);
	assert.deepEqual(completions("worker --no", agents, models), [
		{ value: "worker --no-auto-exit", label: "--no-auto-exit" },
	]);
	assert.equal(completions("W", agents, models), null);
	assert.equal(completions("worker task", agents, models), null);
});

test("resume completions offer ids, their own flags, models and thinking", () => {
	assert.deepEqual(resumeCompletions("abc", ids, models), [
		{ value: "abc123", label: "abc123" },
		{ value: "abc456", label: "abc456" },
	]);
	assert.deepEqual(
		resumeCompletions("abc123 --", ids, models)?.map((item) => item.label),
		["--model", "--thinking", "--auto-exit", "--no-auto-exit"],
	);
	assert.deepEqual(resumeCompletions("abc123 --model b", ids, models), [
		{ value: "abc123 --model beta/deep", label: "beta/deep" },
	]);
	assert.deepEqual(resumeCompletions("abc123 --thinking l", ids, models), [
		{ value: "abc123 --thinking low", label: "low" },
	]);
	assert.equal(resumeCompletions("zzz", ids, models), null);
});

test("completion sources are evaluated only for the matching token", () => {
	const unused = (): never => {
		throw new Error("source should not be read");
	};
	assert.equal(completions("worker task", unused, unused), null);
	assert.equal(resumeCompletions("abc123 task", unused, unused), null);
	assert.deepEqual(
		completions("", agents, unused)?.map((item) => item.label),
		agents(),
	);
	assert.deepEqual(
		resumeCompletions("", ids, unused)?.map((item) => item.label),
		ids(),
	);
	assert.deepEqual(
		completions("worker --model a", unused, models)?.map((item) => item.label),
		["alpha/fast"],
	);
});
