// The delegate message renderer, drawn from a message's details: collapsed, a
// header (status icon, name, model) with a short body preview and an expand
// hint; expanded, the header, the ids and files, the task and the body as
// Markdown. A message without details is left to Pi's default rendering.

import assert from "node:assert/strict";
import { before, test } from "node:test";

import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";

import { renderMessage } from "../src/render.ts";
import type { MessageDetails } from "../src/results.ts";

// The expanded body renders through Pi's Markdown theme, which reads Pi's global theme.
before(() => initTheme("dark"));

/** Wraps colored text as `<token:text>`, so a test can see which color a part got. */
const theme = {
	fg: (token: string, text: string) => `<${token}:${text}>`,
	bg: (_: string, text: string) => text,
} as unknown as Theme;

function render(details: MessageDetails | undefined, expanded: boolean, width = 120): string[] | undefined {
	const message = {
		role: "custom",
		customType: "delegate",
		content: "[delegate] the text the model reads",
		display: true,
		timestamp: 0,
		...(details === undefined ? {} : { details }),
	} as const;
	return renderMessage(message, { expanded, outputPad: 1 }, theme)
		?.render(width)
		.map((line) => line.trim());
}

// keyText has no bindings loaded under test, so the key part of the hint is empty.
const HINT = "<dim:><muted: to expand>";

const result = (overrides: Partial<MessageDetails & { kind: "result" }> = {}): MessageDetails => ({
	kind: "result",
	status: "done",
	name: "scout-6ba168fc",
	agent: "scout",
	model: "a/one",
	id: "6ba168fc-id",
	requestId: "req-id",
	envelopePath: "/mail/cur/reply.json",
	sessionPath: "/sessions/s.jsonl",
	task: { text: "look into it", path: "/mail/sent/req.json" },
	body: "first\nsecond\nthird\nfourth",
	...overrides,
});

const gone: MessageDetails = {
	kind: "gone",
	name: "scout-6ba168fc",
	agent: "scout",
	model: "a/one",
	id: "6ba168fc-id",
	requestId: "req-id",
	windowName: "scout-6ba168fc",
};

test("a collapsed result shows the header, the first three body lines dim, and the hint", () => {
	assert.deepEqual(render(result(), false), [
		"",
		"<success:✓> <accent:scout-6ba168fc> <muted:a/one>",
		"<dim:first>",
		"<dim:second>",
		"<dim:third>",
		HINT,
		"",
	]);
});

test("a body shorter than the preview shows only its lines", () => {
	const lines = render(result({ body: "only" }), false) ?? [];
	assert.deepEqual(lines.slice(2, 4), ["<dim:only>", HINT]);
});

test("a preview line longer than the width is cut, not wrapped", () => {
	const lines = render(result({ body: "x".repeat(200) }), false, 60) ?? [];
	assert.equal(lines.filter((line) => line.includes("xxx")).length, 1);
});

test("the header shows launched → finished when the models differ, and one model when they match", () => {
	assert.match(render(result({ finishedModel: "b/two" }), false)?.[1] ?? "", /<muted:a\/one → b\/two>/);
	assert.match(render(result({ finishedModel: "a/one" }), false)?.[1] ?? "", /<muted:a\/one>/);
});

test("each status gets its own icon and color", () => {
	const head = (details: MessageDetails) => render(details, false)?.[1] ?? "";
	assert.match(head(result({ status: "done" })), /^<success:✓>/);
	assert.match(head(result({ status: "failed" })), /^<error:✗>/);
	assert.match(head(result({ status: "stopped" })), /^<warning:■>/);
	assert.match(head(result({ status: "odd" })), /^<muted:•> .*<muted: odd>$/);
	// A status that names an Object.prototype member is still unknown, not a theme color of undefined.
	assert.match(head(result({ status: "constructor" })), /^<muted:•> .*<muted: constructor>$/);
	assert.match(head(gone), /^<warning:⊘> .*<warning: closed without a result>$/);
});

test("a collapsed header too long for the width stays one line", () => {
	const lines = render(result({ name: "scout-roster-research", finishedModel: "openai/gpt-6-luna" }), false, 60) ?? [];
	assert.equal(lines.length, 7, "padding, header, three preview lines, hint, padding");
});

test("an expanded header wraps, so the whole model label stays visible", () => {
	const text = (render(result({ finishedModel: "openai/gpt-6-luna" }), true, 60) ?? []).join(" ");
	assert.ok(text.includes("openai/gpt-6-luna"));
});

test("a collapsed gone message shows the header and hint, with no preview", () => {
	assert.equal(render(gone, false)?.length, 4);
});

test("an expanded result shows the ids and files, the usage-limit line, the task and the body", () => {
	const text = (render(result({ limit: "Usage limit: hit." }), true) ?? []).join("\n");
	for (const part of [
		"<dim:delegation 6ba168fc-id>",
		"<dim:request req-id>",
		"<dim:envelope /mail/cur/reply.json>",
		"<dim:session /sessions/s.jsonl>",
		"<dim:Usage limit: hit.>",
		"<muted:Task (/mail/sent/req.json):>",
		"<muted:> look into it>",
		"fourth",
	])
		assert.ok(text.includes(part), `missing ${part}`);
});

test("an expanded result renders the body as Markdown", () => {
	const text = (render(result({ body: "# Title\n\n- item" }), true) ?? []).join("\n");
	assert.ok(!text.includes("# Title"), "the heading marker is rendered away");
	assert.ok(text.includes("Title"));
});

test("an expanded result with no task copy shows the note", () => {
	const text = (render(result({ task: { note: "no copy" } }), true) ?? []).join("\n");
	assert.ok(text.includes("<muted:no copy>"));
});

test("an expanded gone message names its window and says a late reply still arrives", () => {
	const text = (render(gone, true) ?? []).join("\n");
	assert.ok(text.includes("window scout-6ba168fc"));
	assert.ok(text.includes("session 6ba168fc-id (no session file found)"));
	assert.ok(text.includes("A reply that arrives later is still delivered."));
});

test("a message without details is left to Pi's default rendering", () => {
	assert.equal(render(undefined, false), undefined);
	assert.equal(render(undefined, true), undefined);
});
