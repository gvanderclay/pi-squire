import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Results, StartedRecorded } from "../src/results.ts";
import { ResultsPresentation } from "../src/results-presentation.ts";
import { DirectDelegateView } from "../src/widget-data.ts";
import { renderDelegateWidget, type WidgetTheme, widgetText } from "../src/widget-render.ts";
import { widgetSettings } from "../src/widget-settings.ts";
import {
	mirroredTitle,
	TITLE_LIVENESS_CACHE_MS,
	titleMirrorPath,
	titlePublisher,
	WidgetTitleMirrors,
} from "../src/widget-title.ts";
import { WidgetTitleFiles } from "../src/widget-title-file.ts";
import { agentDir, cleanup, resetRoot, root } from "./harness.ts";

beforeEach(resetRoot);
after(cleanup);
const settingsFile = join(agentDir, "squire", "settings.json");
const theme: WidgetTheme = { fg: (_color, text) => text, bold: (text) => text };

function configure(value: unknown): void {
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(settingsFile, JSON.stringify(value));
}
function transcript(name?: string, id = "session"): string {
	const entries: object[] = [{ type: "session", id }];
	if (name !== undefined) entries.push({ type: "session_info", name });
	return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}
function record(id: string, values: Partial<StartedRecorded> = {}): StartedRecorded {
	return {
		id,
		name: `worker-${id}`,
		agent: "worker",
		model: "provider/model-name",
		thinking: "low",
		windowId: `@${id}`,
		windowName: `worker-${id}`,
		requestId: `request-${id}`,
		...values,
	};
}
function results(records: StartedRecorded[]): Results {
	return { list: () => records, running: () => records.filter((r) => !r.result && !r.closed && !r.gone) } as Results;
}
function outcome(status: string): NonNullable<StartedRecorded["result"]> {
	return { status, replyId: "reply", envelopePath: "/reply" };
}

test("settings default above/three, allow below/zero and leave unrelated Squire settings alone", () => {
	assert.deepEqual(widgetSettings(), { placement: "aboveEditor", maxEntries: 3 });
	configure({ windowPlacement: "current", delegateWidgetPlacement: "below", delegateWidgetMaxEntries: 0 });
	assert.deepEqual(widgetSettings(), { placement: "belowEditor", maxEntries: 0 });
	configure({ delegateWidgetPlacement: "above", delegateWidgetMaxEntries: 9 });
	assert.deepEqual(widgetSettings(), { placement: "aboveEditor", maxEntries: 9 });
});
test("invalid widget settings name the key/file rather than silently disabling the overview", () => {
	for (const value of [-1, 1.5, "3", null, true]) {
		configure({ delegateWidgetMaxEntries: value });
		assert.throws(widgetSettings, /delegateWidgetMaxEntries.*settings.json/);
	}
	for (const value of ["sideways", null, 1]) {
		configure({ delegateWidgetPlacement: value });
		assert.throws(widgetSettings, /delegateWidgetPlacement.*settings.json/);
	}
	for (const value of [[], null, "bad"]) {
		configure(value);
		assert.throws(widgetSettings, /expected an object/);
	}
	writeFileSync(settingsFile, "{");
	assert.throws(widgetSettings, /could not read widget settings/);
});

test("native JSONL title reader honors latest metadata across branches, explicit clear and partial lines", () => {
	const path = join(root, "title.jsonl");
	const reader = new WidgetTitleFiles();
	writeFileSync(path, transcript("Initial"));
	assert.equal(reader.read(path, "session")?.name, "Initial");
	appendFileSync(path, JSON.stringify({ type: "session_info", parentId: "old-branch", name: "Latest" }));
	assert.equal(reader.read(path, "session")?.name, "Initial", "incomplete append is not authoritative");
	appendFileSync(path, "\n");
	assert.equal(reader.read(path, "session")?.name, "Latest");
	appendFileSync(path, `${JSON.stringify({ type: "session_info", name: "" })}\n`);
	assert.equal(reader.read(path, "session")?.name, "");
});

test("title cache rescans file replacement/truncation/same-size rewrite and rejects foreign headers", () => {
	const path = join(root, "replace.jsonl");
	const reader = new WidgetTitleFiles();
	writeFileSync(path, transcript("First"));
	assert.equal(reader.read(path, "session")?.name, "First");
	writeFileSync(`${path}.new`, transcript("Next"));
	renameSync(`${path}.new`, path);
	assert.equal(reader.read(path, "session")?.name, "Next");
	writeFileSync(path, transcript("Same"));
	assert.equal(reader.read(path, "session")?.name, "Same");
	writeFileSync(path, transcript());
	assert.equal(reader.read(path, "session")?.name, undefined);
	writeFileSync(path, transcript("Wrong", "foreign"));
	assert.equal(reader.read(path, "session"), undefined);
});

test("title reader bounds memory/work per refresh and never parses transcript payloads as titles", () => {
	const path = join(root, "large.jsonl");
	const reader = new WidgetTitleFiles();
	writeFileSync(path, transcript("Original"));
	appendFileSync(path, `${JSON.stringify({ type: "message", message: { content: "x".repeat(2 * 1024 * 1024) } })}\n`);
	appendFileSync(path, `${JSON.stringify({ type: "session_info", name: "After large message" })}\n`);
	assert.equal(reader.read(path, "session")?.name, "Original");
	assert.equal(reader.read(path, "session")?.name, "Original");
	assert.equal(reader.read(path, "session")?.name, "After large message");
});

test("native title mirror is private, rejects dead/mismatched owners and old cleanup cannot delete a replacement", () => {
	const first = titlePublisher("native");
	first.publish("Before flush");
	assert.equal(mirroredTitle("native"), "Before flush");
	const path = titleMirrorPath("native");
	assert.equal(statSync(path).mode & 0o777, 0o600);
	const second = titlePublisher("native");
	second.publish("Replacement");
	first.stop();
	assert.equal(mirroredTitle("native"), "Replacement");
	const saved = JSON.parse(readFileSync(path, "utf8"));
	writeFileSync(path, JSON.stringify({ ...saved, start: "different-process-start" }));
	assert.equal(mirroredTitle("native"), undefined);
	writeFileSync(path, JSON.stringify({ ...saved, sessionId: "unrelated" }));
	assert.equal(mirroredTitle("native"), undefined);
	second.stop();
});

test("direct adapter is read-only, deduplicates resumes by stable id, excludes attempts/closed/gone and preserves outcomes", () => {
	const records = [
		record("old", { sessionId: "stable", gone: true }),
		record("done", { result: outcome("done") }),
		record("run"),
		record("failed", { result: outcome("failed"), gone: true }),
		record("closed", { closed: true }),
		record("new", { sessionId: "stable", resumedFrom: "old" }),
	];
	const source = results(records);
	const before = JSON.stringify(records);
	const windows = records.map((r) => ({ id: r.windowId, name: r.windowName, exited: false, session: "work" }));
	const view = new DirectDelegateView();
	const rows = view.read(source, windows, undefined);
	assert.deepEqual(
		rows.map((r) => r.key),
		["stable", "run", "failed", "done"],
	);
	assert.equal(rows[0].launchId, "new");
	assert.equal(rows[2].state, "failed");
	assert.equal(JSON.stringify(records), before);
	assert.deepEqual(
		view.read(source, undefined, undefined).map((r) => r.key),
		["stable", "run"],
	);
});

test("responsive style B keeps identity/state, hides model before file-age and clamps wide/malicious names at every width", () => {
	const source = results([record("identity")]);
	const rows = new DirectDelegateView().read(source, undefined, undefined);
	rows[0].title = "Native title";
	rows[0].lastActive = 1000;
	const full = renderDelegateWidget(rows, 3, 120, theme, 1000).join("\n");
	assert.match(full, /└─ ◌ worker-identity {2}Native title.*running.*file just now.*model-name/);
	const medium = renderDelegateWidget(rows, 3, 65, theme, 1000).join("\n");
	assert.match(medium, /file just now/);
	assert.ok(!medium.includes("model-name"));
	const narrow = renderDelegateWidget(rows, 3, 42, theme, 1000).join("\n");
	assert.match(narrow, /running/);
	assert.ok(!narrow.includes("file just now"));
	rows[0].identity = "測試界👩‍💻-".repeat(100);
	rows[0].title = "Bad\nline\u001b[31mred\u001b]0;terminal-title\u0007suffix";
	for (let width = 0; width <= 150; width++) {
		for (const line of renderDelegateWidget(rows, 3, width, theme, 1000)) {
			assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
			assert.ok(!line.includes("\n") && !line.includes("\u001b[31m") && !line.includes("\u001b]"));
		}
	}
	assert.equal(widgetText("title\u0000\n\u001b[31mtext"), "title text");
	assert.deepEqual(renderDelegateWidget(rows, 0, 100, theme), []);
	assert.deepEqual(renderDelegateWidget([], 3, 100, theme), []);
});

test("metadata work is capped after full eligibility/order, with an offset seam and zero-cost cap zero", () => {
	const records = Array.from({ length: 16 }, (_value, index) =>
		record(String(index), index >= 12 ? { result: outcome(index === 15 ? "failed" : "done") } : {}),
	);
	const source = results(records);
	const windows = records.map((r) => ({ id: r.windowId, name: r.windowName, exited: false, session: "work" }));
	const located: string[] = [];
	const read: string[] = [];
	const mirrored: string[] = [];
	const view = new DirectDelegateView({
		locate: (r) => {
			located.push(r.id);
			return `/sessions/${r.id}.jsonl`;
		},
		titles: {
			read: (_path, id) => {
				read.push(id);
				return { name: undefined, modified: 1000 };
			},
			clear: () => {},
		},
		mirrors: {
			read: (id) => {
				mirrored.push(id);
				return `native-${id}`;
			},
			clear: () => {},
		},
	});
	let rows = view.read(source, windows, undefined);
	assert.equal(rows.length, 16, "overflow/selection retain every eligible direct child");
	assert.deepEqual(read, ["11", "10", "9"]);
	assert.deepEqual(mirrored, read);
	assert.deepEqual(located, read);
	assert.equal(rows.filter((row) => row.title !== undefined).length, 3);
	assert.equal(rows[12].state, "failed", "hidden outcome facts remain available without metadata I/O");
	assert.match(renderDelegateWidget(rows, 3, 100, theme).join("\n"), /\+13 more direct delegates/);

	read.length = mirrored.length = located.length = 0;
	rows = view.read(source, windows, undefined);
	assert.deepEqual(located, [], "successful path lookup is cached in the view");
	assert.deepEqual(read, ["11", "10", "9"]);
	assert.deepEqual(mirrored, read);

	read.length = mirrored.length = 0;
	const keys = rows.map((row) => row.key);
	rows = view.read(source, windows, undefined, { offset: 3, limit: 2 });
	assert.deepEqual(
		rows.map((row) => row.key),
		keys,
		"viewport changes do not change eligibility or identity",
	);
	assert.deepEqual(read, ["8", "7"]);
	assert.deepEqual(mirrored, read);
	assert.deepEqual(located, read);

	read.length = mirrored.length = located.length = 0;
	rows = view.read(source, windows, undefined, { offset: 0, limit: 0 });
	assert.equal(rows.length, 16);
	assert.deepEqual(read, []);
	assert.deepEqual(mirrored, []);
	assert.deepEqual(located, []);
	assert.deepEqual(renderDelegateWidget(rows, 0, 100, theme), []);
});

test("view path cache avoids directory lookup but does not cache titles; locator, disappearance and resume invalidate it", () => {
	const path = join(root, "cached.jsonl");
	const moved = join(root, "moved.jsonl");
	const r = record("cache");
	let current = path;
	let calls = 0;
	const view = new DirectDelegateView({
		locate: () => {
			calls++;
			return current;
		},
	});
	const source = results([r]);
	writeFileSync(path, transcript("First", "cache"));
	assert.equal(view.read(source, undefined, "first-dir")[0].title, "First");
	assert.equal(calls, 1);
	appendFileSync(path, `${JSON.stringify({ type: "session_info", name: "Fresh append" })}\n`);
	assert.equal(view.read(source, undefined, "first-dir")[0].title, "Fresh append");
	assert.equal(calls, 1, "native append refreshes without relisting the directory");
	writeFileSync(`${path}.new`, transcript("Replaced file", "cache"));
	renameSync(`${path}.new`, path);
	assert.equal(view.read(source, undefined, "first-dir")[0].title, "Replaced file");
	assert.equal(calls, 1, "file-identity change is handled by the reader, not directory lookup");
	renameSync(path, moved);
	current = moved;
	assert.equal(view.read(source, undefined, "first-dir")[0].title, undefined);
	assert.equal(view.read(source, undefined, "first-dir")[0].title, "Replaced file");
	assert.equal(calls, 2, "missing cached file invalidates the path");
	view.read(source, undefined, "other-dir");
	assert.equal(calls, 3, "fallback storage locator changes invalidate the cache");
	r.sessionPath = moved;
	view.read(source, undefined, "other-dir");
	assert.equal(calls, 4, "recorded locator changes invalidate the cache");
	const resumed = results([r, record("resumed", { sessionId: "cache", resumedFrom: "cache" })]);
	assert.equal(view.read(resumed, undefined, "other-dir")[0].title, "Replaced file");
	assert.equal(calls, 5, "resumed launch has its own path-cache identity");
	view.clear();
	view.read(resumed, undefined, "other-dir");
	assert.equal(calls, 6, "session lifecycle clears path and metadata caches");
});

test("missing paths are not negatively cached before the first native transcript flush", () => {
	let path: string | undefined;
	let calls = 0;
	const view = new DirectDelegateView({
		locate: () => {
			calls++;
			return path;
		},
	});
	const source = results([record("flush")]);
	assert.equal(view.read(source, undefined, undefined)[0].title, undefined);
	path = join(root, "flushed.jsonl");
	writeFileSync(path, transcript("First flush", "flush"));
	assert.equal(view.read(source, undefined, undefined)[0].title, "First flush");
	assert.equal(calls, 2);
});

test("mirror liveness skips empty titles, expires non-sliding positives, and never caches native name changes", () => {
	const publisher = titlePublisher("cache-mirror");
	publisher.publish("");
	const saved = JSON.parse(readFileSync(titleMirrorPath("cache-mirror"), "utf8"));
	let now = 0;
	let probes = 0;
	let start: string | undefined = saved.start;
	const mirrors = new WidgetTitleMirrors({
		now: () => now,
		start: () => {
			probes++;
			return start;
		},
	});
	assert.equal(mirrors.read("cache-mirror"), undefined);
	assert.equal(probes, 0, "unnamed children never incur a process-start probe");
	publisher.publish("First");
	assert.equal(mirrors.read("cache-mirror"), "First");
	assert.equal(probes, 1);
	now = TITLE_LIVENESS_CACHE_MS - 1;
	publisher.publish("Rename");
	assert.equal(mirrors.read("cache-mirror"), "Rename", "metadata reads stay fresh within the liveness-cache interval");
	assert.equal(probes, 1);
	now = TITLE_LIVENESS_CACHE_MS;
	start = undefined;
	assert.equal(mirrors.read("cache-mirror"), undefined, "a cached positive expires even under repeated reads");
	assert.equal(probes, 2);
	now += TITLE_LIVENESS_CACHE_MS;
	start = saved.start;
	assert.equal(mirrors.read("cache-mirror"), "Rename", "an unavailable probe does not permanently hide a live owner");
	assert.equal(probes, 3);
	mirrors.clear();
	assert.equal(mirrors.read("cache-mirror"), "Rename");
	assert.equal(probes, 4);
	publisher.publish("");
	assert.equal(mirrors.read("cache-mirror"), undefined);
	assert.equal(probes, 4);
	publisher.stop();
});

test("transcript payload lines are filtered before JSON.parse and later native metadata stays fresh", (t) => {
	const path = join(root, "prefilter.jsonl");
	writeFileSync(path, transcript("Initial"));
	const parse = JSON.parse;
	const parsed: string[] = [];
	t.mock.method(JSON, "parse", (text: string) => {
		parsed.push(text);
		return parse(text);
	});
	const reader = new WidgetTitleFiles();
	assert.equal(reader.read(path, "session")?.name, "Initial");
	parsed.length = 0;
	appendFileSync(
		path,
		`${JSON.stringify({ type: "message", message: { content: "large-ignored-body".repeat(2000) } })}\n`,
	);
	appendFileSync(path, `${JSON.stringify({ type: "model_change", modelId: "ignored" })}\n`);
	appendFileSync(path, `${JSON.stringify({ type: "session_info", name: "Fresh metadata" })}\n`);
	assert.equal(reader.read(path, "session")?.name, "Fresh metadata");
	assert.equal(
		parsed.some((text) => text.includes("large-ignored-body") || text.includes("model_change")),
		false,
	);
	assert.equal(parsed.filter((text) => text.includes("Fresh metadata")).length, 1);
});

test("ANSI-themed long/wide rows fit every width without losing terminal state safety", () => {
	const rows = new DirectDelegateView().read(results([record("ansi")]), undefined, undefined);
	rows[0].identity = "界👩‍💻-".repeat(30);
	rows[0].title = "長い title ".repeat(30);
	rows[0].lastActive = 1000;
	const ansi: WidgetTheme = {
		fg: (_color, text) => `\u001b[36m${text}\u001b[39m`,
		bold: (text) => `\u001b[1m${text}\u001b[22m`,
	};
	for (let width = 0; width <= 150; width++) {
		const lines = renderDelegateWidget(rows, 3, width, ansi, 1000);
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `ANSI row exceeds ${width} columns`);
	}
	assert.ok(renderDelegateWidget(rows, 3, 150, ansi, 1000).some((line) => line.includes("\u001b[")));
});

test("presentation observers unsubscribe and cannot break result processing or custom status keys", () => {
	const statuses: { key: string; text: string | undefined }[] = [];
	const presentation = new ResultsPresentation();
	const ctx = {
		hasUI: true,
		ui: { setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }) },
	} as unknown as ExtensionContext;
	let calls = 0;
	const stop = presentation.subscribe(() => {
		calls++;
	});
	presentation.subscribe(() => {
		throw new Error("optional view failed");
	});
	presentation.update(ctx, 2);
	assert.equal(calls, 1);
	presentation.setCountVisible(false);
	assert.deepEqual(statuses.at(-1), { key: "delegate", text: undefined });
	stop();
	presentation.update(ctx, 1);
	assert.equal(calls, 1);
	presentation.setCountVisible(true);
	assert.match(statuses.at(-1)?.text ?? "", /1 delegate running/);
	assert.ok(statuses.every(({ key }) => key === "delegate"));
});
