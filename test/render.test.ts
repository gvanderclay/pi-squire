// The delegate message renderer: collapsed, a result shows its first two lines
// and an expand hint; expanded, it leaves the message to Pi's default
// rendering, so Ctrl+O toggles it together with tool output.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";

import { renderMessage } from "../src/results.ts";

const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text } as unknown as Theme;

function render(content: string, expanded: boolean): string[] | undefined {
	const message = { role: "custom", customType: "delegate", content, display: true, timestamp: 0 } as const;
	return renderMessage(message, { expanded, outputPad: 1 }, theme)
		?.render(60)
		.map((line) => line.trim());
}

const result = "[delegate] Result from worker (a/b), delegation d, request r.\nStatus: done\nTask...\n\nbody";

test("a collapsed result shows its first two lines and the expand hint", () => {
	assert.deepEqual(render(result, false), [
		"",
		"[delegate] Result from worker (a/b), delegation d, request",
		"r.",
		"Status: done",
		"to expand",
		"",
	]);
});

test("an expanded result falls back to Pi's default rendering", () => {
	assert.equal(render(result, true), undefined);
});

test("a message of two lines or fewer gets no expand hint", () => {
	assert.deepEqual(render("[delegate] one\ntwo", false), ["", "[delegate] one", "two", ""]);
});
