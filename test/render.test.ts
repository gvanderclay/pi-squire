// The delegate result and gone messages, drawn as a finished tool row: a
// header (icon, name, model, status) on Pi's tool success or error background,
// then a preview and the expand hint, or, expanded, the result as Markdown,
// the task and the ids. A message without details is left to Pi.

import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";

import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";

import { renderMessage } from "../src/render.ts";
import type { MessageDetails } from "../src/results.ts";

// The expand hint and the Markdown body read Pi's global theme.
before(() => initTheme("dark"));

/** The background tokens the last render asked for. */
let backgrounds = new Set<string>();

/** Wraps colored text as `<token:text>`, so a test can see which color a part got. */
const theme = {
	fg: (token: string, text: string) => `<${token}:${text}>`,
	bg: (token: string, text: string) => {
		backgrounds.add(token);
		return text;
	},
	bold: (text: string) => `<bold:${text}>`,
} as unknown as Theme;

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips the real theme's ANSI from the expand hint
const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "").trim();

function render(details: MessageDetails | undefined, expanded: boolean, width = 120): string[] | undefined {
	backgrounds = new Set();
	const message = {
		role: "custom",
		customType: "delegate",
		content: "[delegate] the text the model reads",
		display: true,
		timestamp: 0,
		...(details === undefined ? {} : { details }),
	} as const;
	return renderMessage(message, { expanded, outputPad: 1 }, theme)?.render(width).map(plain);
}

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
	cwd: "/work/checkout",
	sessionDir: "/sessions",
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

// keyHint has no bindings loaded under test, so the key part of the hint is empty.
const HINT = "to expand";

const HEADER = "<success:✓> <toolTitle:<bold:scout-6ba168fc>><dim: (a/one) —> <dim:done>";

test("a collapsed done result is a tool row: header, dim preview, expand hint, on the success background", () => {
	assert.deepEqual(render(result(), false), [
		"",
		HEADER,
		"<dim:first>",
		"<dim:second>",
		"<dim:third>",
		"<dim:fourth>",
		HINT,
		"",
	]);
	assert.deepEqual([...backgrounds], ["toolSuccessBg"]);
});

test("a long result previews five non-blank lines, stripped of Markdown marks, and counts the rest", () => {
	const body = "## Files\n\n- `a.ts` is **key**\n2\n3\n4\n5\n6";
	const lines = render(result({ body }), false) ?? [];
	assert.deepEqual(lines.slice(2, 9), [
		"<dim:Files>",
		"<dim:- a.ts is key>",
		"<dim:2>",
		"<dim:3>",
		"<dim:4>",
		"<muted:… 2 more lines>",
		HINT,
	]);
});

test("a preview line longer than the width is cut, not wrapped", () => {
	const lines = render(result({ body: "x".repeat(200) }), false, 60) ?? [];
	assert.equal(lines.filter((line) => line.includes("xxx")).length, 1);
});

test("the header shows launched → finished when the models differ", () => {
	assert.match(render(result({ finishedModel: "b/two" }), false)?.[1] ?? "", /<dim: \(a\/one → b\/two\) —>/);
	assert.match(render(result({ finishedModel: "a/one" }), false)?.[1] ?? "", /<dim: \(a\/one\) —>/);
});

test("failed, stopped, gone and unknown statuses get their own icon, word and the error background", () => {
	const head = (details: MessageDetails) => render(details, false)?.[1] ?? "";
	assert.match(head(result({ status: "failed" })), /^<error:✗> .*<error:failed>$/);
	assert.deepEqual([...backgrounds], ["toolErrorBg"]);
	assert.match(head(result({ status: "stopped" })), /^<warning:✗> .*<warning:stopped>$/);
	assert.deepEqual([...backgrounds], ["toolErrorBg"]);
	assert.match(head(gone), /^<warning:✗> .*<warning:closed without a result>$/);
	assert.match(head(result({ status: "odd" })), /^<muted:•> .*<muted:odd>$/);
	// A status that names an Object.prototype member is still unknown, not a theme color of undefined.
	assert.match(head(result({ status: "constructor" })), /^<muted:•> .*<muted:constructor>$/);
});

test("a usage-limit line shows under the header, collapsed and expanded", () => {
	for (const expanded of [false, true])
		assert.equal(render(result({ limit: "Usage limit: hit." }), expanded)?.[2], "<warning:Usage limit: hit.>");
});

test("a collapsed header too long for the width stays one line", () => {
	const lines = render(result({ name: "scout-roster-research", finishedModel: "openai/gpt-6-luna" }), false, 60) ?? [];
	assert.equal(lines.length, 8, "padding, header, four preview lines, hint, padding");
});

test("a collapsed gone message shows the header and the hint", () => {
	assert.deepEqual(render(gone, false)?.slice(1, 3), [
		"<warning:✗> <toolTitle:<bold:scout-6ba168fc>><dim: (a/one) —> <warning:closed without a result>",
		HINT,
	]);
});

test("an expanded result shows the body as Markdown, then the task, then the ids", () => {
	const text = (render(result({ body: "# Title\n\nfourth" }), true) ?? []).join("\n");
	assert.ok(!text.includes("# Title"), "the heading marker is rendered away");
	const order = [
		"Title",
		"fourth",
		"<dim:Task (/mail/sent/req.json):>",
		"<dim:look into it>",
		"<dim:delegation 6ba168fc-id>",
	].map((part) => text.indexOf(part));
	assert.ok(
		order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])),
		`out of order: ${order}\n${text}`,
	);
	for (const part of ["<dim:request req-id>", "<dim:envelope /mail/cur/reply.json>", "<dim:session /sessions/s.jsonl>"])
		assert.ok(text.includes(part), `missing ${part}`);
});

test("an expanded result names the recorded cwd, and a record without one says it is unknown", () => {
	const recorded = (render(result(), true) ?? []).join("\n");
	assert.ok(recorded.includes("<dim:cwd /work/checkout>"), recorded);
	const legacy = (render(result({ cwd: undefined }), true) ?? []).join("\n");
	assert.ok(legacy.includes("<dim:cwd unknown (not recorded)>"), legacy);
	assert.ok(!legacy.includes(process.cwd()), legacy);
	assert.ok((render(gone, true) ?? []).includes("<dim:cwd unknown (not recorded)>"));
});

test("an expanded result names its workspace, its Git checkout or an unknown Git state", () => {
	// A view that drops the workspace, or calls a failed inspection a non-Git directory, is what this catches.
	const checkout = (
		render(
			result({
				workspace: {
					mode: "existing",
					cwd: "/work/topic",
					git: {
						kind: "git",
						identity: { mainRoot: "/work/main", commonDir: "/work/main/.git", checkoutRoot: "/work/topic" },
						position: { branch: null, detached: true },
						head: "abc123",
						baseline: "abc123",
					},
				},
			}),
			true,
			400,
		) ?? []
	).join("\n");
	assert.ok(
		checkout.includes(
			"<dim:workspace existing directory; Git checkout /work/main (linked worktree /work/topic), detached HEAD, launch commit abc123>",
		),
		checkout,
	);
	const unknown = (
		render(
			result({ workspace: { mode: "existing", cwd: "/work/x", git: { kind: "unknown", reason: "git timed out" } } }),
			true,
			400,
		) ?? []
	).join("\n");
	assert.ok(unknown.includes("<dim:workspace existing directory; Git state unknown (git timed out)>"), unknown);
	assert.ok(!(render(result(), true, 400) ?? []).join("\n").includes("workspace"), "older records show no workspace");
});

test("an expanded result with no task copy shows the note", () => {
	assert.ok((render(result({ task: { note: "no copy" } }), true) ?? []).includes("<dim:no copy>"));
});

test("paths under the home directory show as ~", () => {
	const home = homedir();
	const text = (
		render(
			result({ sessionPath: join(home, "s.jsonl"), task: { text: "t", path: join(home, "sent", "r.json") } }),
			true,
		) ?? []
	).join("\n");
	assert.ok(text.includes("<dim:session ~/s.jsonl>"), text);
	assert.ok(text.includes("<dim:Task (~/sent/r.json):>"), text);
});

test("an expanded gone message names its window and says a late reply still arrives", () => {
	const text = (render(gone, true) ?? []).join("\n");
	assert.ok(text.includes("<dim:window scout-6ba168fc>"));
	assert.ok(text.includes("<dim:session 6ba168fc-id (no session file found)>"));
	assert.ok(text.includes("<dim:A reply that arrives later is still delivered.>"));
});

test("a message without details is left to Pi's default rendering", () => {
	assert.equal(render(undefined, false), undefined);
	assert.equal(render(undefined, true), undefined);
});
