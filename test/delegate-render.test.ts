// The `delegate` tool's row: ○ with the agent, label and task while the call
// is made, then ⟳ with the delegate's name, model and "started", matching the
// finished-tool-row look of the result message that arrives later. A refused
// call keeps its plain error text.

import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";

import { agentFile, cleanup, resetRoot, session, writeAgent } from "./harness.ts";

beforeEach(() => resetRoot());
after(() => cleanup());

/** Wraps colored text as `<token:text>`, so a test can see which color a part got. */
const theme = {
	fg: (token: string, text: string) => `<${token}:${text}>`,
	bg: (_: string, text: string) => text,
	bold: (text: string) => `<bold:${text}>`,
} as unknown as Theme;

type Renderable = { render(width: number): string[] };
type Renderers = {
	renderCall(args: unknown, theme: Theme, context: unknown): Renderable;
	renderResult(result: unknown, options: unknown, theme: Theme, context: unknown): Renderable;
};

const lines = (component: Renderable, width = 120) => component.render(width).map((line) => line.trim());
/** A render context; `isPartial` stays true until the tool's result arrives. */
const context = (args: unknown, expanded: boolean, isError = false, isPartial = false) => ({
	args,
	expanded,
	isError,
	isPartial,
});

async function launched(args: Record<string, unknown>) {
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
	const s = session();
	await s.start();
	const result = await s.toolCall("delegate", args);
	return { s, result, tool: s.tool("delegate") as unknown as Renderers };
}

const TASK = "## Look\n\n- into `src/` for **it**\nthen report\nand more";

test("the call row shows ○, the agent, the label, the task's first line and its line count", async () => {
	const args = { agent: "scout", task: TASK, label: "look" };
	const { tool } = await launched(args);
	assert.deepEqual(lines(tool.renderCall(args, theme, context(args, false, false, true))), [
		"○ <toolTitle:<bold:scout>><dim: [look]>",
		"<toolOutput:## Look><muted: (5 lines)>",
	]);
	assert.deepEqual(
		lines(tool.renderCall({}, theme, context({}, false, false, true))),
		["○ <toolTitle:<bold:…>>"],
		"args still streaming",
	);
});

test("once started, the call row draws nothing, so the row has one header", async () => {
	const args = { agent: "scout", task: TASK, label: "look" };
	const { tool } = await launched(args);
	assert.deepEqual(lines(tool.renderCall(args, theme, context(args, false))), []);
});

test("a refused call keeps its call row above the error", async () => {
	const args = { agent: "nobody", task: "t" };
	const { tool } = await launched({ agent: "scout", task: "t" });
	assert.deepEqual(lines(tool.renderCall(args, theme, context(args, false, true))), [
		"○ <toolTitle:<bold:nobody>>",
		"<toolOutput:t>",
	]);
});

test("a long first task line is cut at 100 characters", async () => {
	const args = { agent: "scout", task: "y".repeat(150) };
	const { tool } = await launched(args);
	assert.equal(
		lines(tool.renderCall(args, theme, context(args, false, false, true)), 300)[1],
		`<toolOutput:${"y".repeat(100)}…>`,
	);
});

test("a started row shows ⟳, the delegate's name, its model and started, then the task line", async () => {
	const args = { agent: "scout", task: TASK, label: "look" };
	const { tool, result } = await launched(args);
	assert.deepEqual(lines(tool.renderResult(result, { expanded: false }, theme, context(args, false))), [
		"<accent:⟳> <toolTitle:<bold:scout-look>><dim: (alpha/fast-model) — started>",
		"<toolOutput:## Look><muted: (5 lines)>",
	]);
});

test("an expanded started row adds the ids, window, thinking and auto-exit", async () => {
	const args = { agent: "scout", task: TASK, label: "look" };
	const { tool, result } = await launched(args);
	const id = (result.details as { id: string }).id;
	const shown = lines(tool.renderResult(result, { expanded: true }, theme, context(args, true)));
	for (const part of [`<dim:delegation ${id}>`, "<dim:thinking low, auto-exit on>"])
		assert.ok(shown.includes(part), `missing ${part}\n${shown.join("\n")}`);
	assert.ok(shown.some((line) => line.startsWith("<dim:window scout-look (")));
});

test("a launch on a fallback says which model was skipped", async () => {
	writeAgent(
		"scout",
		agentFile({
			description: "Looks things up",
			model: "nowhere/missing",
			fallback: "alpha/fast-model",
			thinking: "low",
		}),
	);
	const s = session();
	await s.start();
	const args = { agent: "scout", task: "t" };
	const result = await s.toolCall("delegate", args);
	const tool = s.tool("delegate") as unknown as Renderers;
	const text = lines(tool.renderResult(result, { expanded: false }, theme, context(args, false))).join("\n");
	assert.match(text, /<warning:\[Skipped nowhere\/missing: [^\]]+\]>/);
});

test("a refused call keeps its plain error text", async () => {
	const { tool } = await launched({ agent: "scout", task: "t" });
	const refused = { content: [{ type: "text", text: "unknown agent nobody" }], details: {} };
	const args = { agent: "nobody", task: "t" };
	assert.deepEqual(lines(tool.renderResult(refused, { expanded: false }, theme, context(args, false, true))), [
		"<error:unknown agent nobody>",
	]);
});
