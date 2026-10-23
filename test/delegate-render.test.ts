// The `delegate` tool's row, drawn in the same style as the result message
// that arrives later: a call line naming the agent, then a header (started
// icon, name, model) with a task preview, or the task, fallback notes and ids
// when expanded. A refused call keeps its plain error text.

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
const context = (args: unknown, expanded: boolean, isError = false) => ({ args, expanded, isError, isPartial: false });

async function launched(args: Record<string, unknown>) {
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
	const s = session();
	await s.start();
	const result = await s.toolCall("delegate", args);
	return { s, result, tool: s.tool("delegate") as unknown as Renderers };
}

const TASK = "## Look\n\n- into `src/` for **it**\nthen report\nand more";

test("the call line names the tool, the agent and the label", async () => {
	const { tool } = await launched({ agent: "scout", task: TASK, label: "look" });
	const args = { agent: "scout", task: TASK, label: "look" };
	assert.deepEqual(lines(tool.renderCall(args, theme, context(args, false))), [
		"<bold:delegate> <accent:scout> <muted:· look>",
	]);
	assert.deepEqual(lines(tool.renderCall({}, theme, context({}, false))), ["<bold:delegate>"], "args still streaming");
});

test("a collapsed started row shows the header, a three-line task preview and the hint", async () => {
	const args = { agent: "scout", task: TASK, label: "look" };
	const { tool, result } = await launched(args);
	assert.deepEqual(lines(tool.renderResult(result, { expanded: false }, theme, context(args, false))), [
		"<accent:◐> <accent:scout-look> <muted:alpha/fast-model>",
		"<muted:Look>",
		"<muted:- into src/ for it>",
		"<muted:then report>",
		"<dim:><muted: to expand>",
	]);
});

test("an expanded started row shows the whole task, then the ids and window", async () => {
	const args = { agent: "scout", task: TASK, label: "look" };
	const { tool, result } = await launched(args);
	const id = (result.details as { id: string }).id;
	const text = lines(tool.renderResult(result, { expanded: true }, theme, context(args, true))).join("\n");
	const order = ["<accent:◐>", "<muted:> and more>", `<dim:delegation ${id}>`, "<dim:window scout-look"].map((part) =>
		text.indexOf(part),
	);
	assert.ok(
		order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])),
		`out of order: ${order}\n${text}`,
	);
	assert.ok(text.includes("<dim:thinking low, auto-exit on>"), text);
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
	assert.match(text, /<warning:skipped nowhere\/missing: [^>]+>/);
});

test("a refused call keeps its plain error text", async () => {
	const { tool } = await launched({ agent: "scout", task: "t" });
	const refused = { content: [{ type: "text", text: "unknown agent nobody" }], details: {} };
	const args = { agent: "nobody", task: "t" };
	assert.deepEqual(lines(tool.renderResult(refused, { expanded: false }, theme, context(args, false, true))), [
		"<error:unknown agent nobody>",
	]);
});
