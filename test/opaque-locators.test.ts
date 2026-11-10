import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { readChildRecords } from "../src/child-tasks.ts";
import type { Delegation } from "../src/results.ts";
import {
	locatedRecord,
	normalizeLiveLocator,
	paneLocator,
	recordLocator,
	sameWindowLocator,
	windowLocator,
	windowPresentation,
} from "../src/tmux.ts";
import { readTree, readTreeDisplay, treePath } from "../src/tree-registry.ts";
import { historicalRecord, recordedIdentity } from "../src/tree-view.ts";
import { LiveActivityPublisher, LiveActivityReader, liveSessionDir } from "../src/widget-live.ts";
import { askToClose, askWindowStates, windowStates } from "../src/window-state.ts";
import { FakeTmux } from "./fake-tmux.ts";
import {
	agentDir,
	agentFile,
	cleanup,
	type Entry,
	resetRoot,
	root,
	session,
	sessionDir,
	writeAgent,
} from "./harness.ts";

type Released = {
	started: Delegation;
	tree: { entries: object[] };
	pane: NonNullable<ReturnType<typeof paneLocator>>;
};
const released = (): Released =>
	JSON.parse(readFileSync(new URL("./fixtures/released-window-records.json", import.meta.url), "utf8"));
beforeEach(() => {
	resetRoot();
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
});
after(cleanup);

function save(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value));
}
function stored(): object {
	return JSON.parse(readFileSync(join(agentDir, "squire", "child-tasks", "released-parent.json"), "utf8"));
}

test("new started/local/tree records store only opaque identity; public window fields stay unchanged", async () => {
	const s = session();
	await s.start();
	const result = await s.toolCall("delegate", { agent: "scout", task: "inspect", label: "new" });
	const details = result.structuredContent as { id: string; windowId: string; windowName: string };
	assert.equal(details.windowId, s.tmux.opened[0].windowId);
	assert.equal(details.windowName, "scout-new");
	const record = s.entries.find(({ data }) => data.id === details.id)!.data;
	assert.ok(recordLocator(record));
	assert.equal("windowId" in record, false);
	assert.equal("windowName" in record, false);
	assert.deepEqual(windowPresentation(record), { windowId: details.windowId, windowName: details.windowName });
	const local = readChildRecords(s.parent)[0];
	assert.equal("windowId" in local, false);
	const raw = JSON.parse(readFileSync(treePath(s.parent), "utf8"));
	assert.ok(raw.entries[0].locator);
	assert.equal("windowId" in raw.entries[0], false);
	assert.equal("windowName" in raw.entries[0], false);
	assert.equal("windowId" in raw.entries[0].launch, false);
});

for (const local of [false, true]) {
	test(`released ${local ? "local child facts" : "transcript"} and tree restore, mixed status, close and resume`, async () => {
		const fixture = released();
		const legacy = fixture.started;
		const tree = fixture.tree;
		Object.assign(tree.entries[0], { launch: { ...legacy } });
		save(treePath("released-parent"), tree);
		if (local)
			save(join(agentDir, "squire", "child-tasks", "released-parent.json"), { records: [legacy], outcomes: [] });
		const entries: Entry[] = local ? [] : [{ customType: "delegate", data: legacy as Entry["data"] }];
		const s = session({ parent: "released-parent", entries });
		s.tmux.addWindow("@71", "scout-released");
		await s.start();
		const before = await s.toolCall("delegation_status", { id: "released-child" });
		assert.match(before.content[0].text, /window: scout-released \(@71\)/);
		assert.match(before.content[0].text, /state: running/);
		const next = await s.toolCall("delegate", { agent: "scout", task: "new beside old", label: "mixed" });
		assert.ok((next.structuredContent as { id: string }).id);
		const status = await s.toolCall("delegation_status", {});
		assert.match(status.content[0].text, /scout-released/);
		assert.match(status.content[0].text, /scout-mixed/);
		const close = await s.toolCall("delegation_close", { id: "released-child" });
		assert.equal((close.structuredContent as { killed: boolean }).killed, true);
		assert.deepEqual(s.tmux.killed, ["@71"]);
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(
			join(sessionDir, "date_released-child.jsonl"),
			`${JSON.stringify({ type: "session", id: "released-child", cwd: root })}\n`,
		);
		const resume = await s.toolCall("delegation_resume", { id: "released-child", task: "continue old session" });
		assert.ok((resume.structuredContent as { id: string }).id);
		assert.equal((resume.structuredContent as { resumedFrom: string }).resumedFrom, "released-child");
		assert.ok(s.tmux.opened.at(-1)!.argv.some((arg) => arg.endsWith("date_released-child.jsonl")));
		assert.equal(JSON.stringify(stored()).includes('"windowId"'), false);
		assert.equal(JSON.stringify(readTree("released-parent")).includes('"windowId"'), false);
	});
}

const invalid: unknown[] = [
	null,
	undefined,
	[],
	"tmux:@71",
	{ adapter: "herdr", version: 1, kind: "window", id: "@71", name: "scout-released" },
	{ adapter: "tmux", version: 2, kind: "window", id: "@71", name: "scout-released" },
	{ adapter: "tmux", version: 1, kind: "pane", id: "@71", name: "scout-released" },
	{ adapter: "tmux", version: 1, kind: "window", id: 71, name: "scout-released" },
	{ adapter: "tmux", version: 1, kind: "window", id: "not-a-tmux-target", name: "scout-released" },
];
test("invalid/foreign explicit locators cannot fall back to coexisting legacy identity or close", async () => {
	const tmux = new FakeTmux();
	tmux.addWindow("@71", "scout-released");
	const windows = await askToClose(tmux);
	for (const locator of invalid) {
		const record = { ...released().started, locator } as Delegation;
		assert.equal(recordLocator(record), undefined);
		assert.equal(windowStates(await tmux.listWindows()).state(record), "unknown");
		assert.equal(windows.listed(record), false);
		assert.throws(() => locatedRecord(record), /locator/);
		await assert.rejects(windows.close(record), /locator/);
	}
	assert.deepEqual(tmux.killed, []);
	assert.equal(
		sameWindowLocator(released().started, { locator: windowLocator({ id: "@71", name: "replacement" }) }),
		false,
	);
});

test("invalid locator in local facts, transcript or registry blocks restore/admission and resume", async () => {
	for (const source of ["local", "transcript", "tree"] as const) {
		resetRoot();
		writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
		const record = {
			...released().started,
			locator: { adapter: "herdr", version: 1, kind: "window", id: "@71", name: "scout-released" },
		};
		const fixture = released();
		if (source === "tree") {
			Object.assign(fixture.tree.entries[0], { locator: record.locator, launch: record });
			save(treePath("released-parent"), fixture.tree);
			assert.throws(() => readTree("released-parent"), /locator/);
		} else if (source === "local") {
			save(join(agentDir, "squire", "child-tasks", "released-parent.json"), { records: [record], outcomes: [] });
			assert.throws(() => readChildRecords("released-parent"), /locator/);
		}
		const s = session({
			parent: "released-parent",
			entries: source === "local" ? [] : [{ customType: "delegate", data: record }],
		});
		s.tmux.addWindow("@71", "scout-released");
		await s.start();
		await assert.rejects(s.toolCall("delegation_resume", { id: "released-child", task: "unsafe" }));
		await assert.rejects(s.toolCall("delegate", { agent: "scout", task: "unsafe" }));
		assert.deepEqual(s.tmux.killed, []);
		assert.deepEqual(s.tmux.opened, []);
	}
});

test("tree launch recovery and historical identity validation reject a foreign locator independently of entry identity", () => {
	const fixture = released();
	const record = {
		...fixture.started,
		locator: { adapter: "herdr", version: 1, kind: "window", id: "@71", name: "scout-released" },
	};
	Object.assign(fixture.tree.entries[0], { launch: record });
	save(treePath("released-parent"), fixture.tree);
	assert.throws(() => readTree("released-parent"), /locator/);
	assert.throws(() => readTreeDisplay("released-parent"), /locator/);
	assert.throws(() => recordedIdentity(record), /locator/);
	const s = session({ parent: "released-parent", entries: [{ customType: "delegate", data: record }] });
	assert.throws(() => historicalRecord("released-child", s.context as never), /locator/);
});

test("new and released window identities share one batched ask and keep unrestricted window names", async () => {
	const tmux = new FakeTmux();
	const longName = "worker-".repeat(100);
	tmux.addWindow("@71", "scout-released");
	tmux.addWindow("@72", longName);
	const current = { locator: windowLocator({ id: "@72", name: longName }) };
	const observed = await askWindowStates(tmux);
	assert.equal(observed.state(released().started), "running");
	assert.equal(observed.state(current), "running");
	assert.equal(observed.state({ locator: windowLocator({ id: "@73", name: "absent" }) }), "gone");
	assert.equal(tmux.listCalls, 1);
	assert.equal(windowPresentation(current).windowName, longName);
});

test("released bare live telemetry reads, new publication envelopes it; foreign/malformed values fail closed", async () => {
	const fixture = released();
	const owner = { token: "released-owner" };
	save(join(agentDir, "squire", "owners", "released-live.json"), { pid: process.pid, token: owner.token });
	const generation = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
	const path = join(liveSessionDir("released-live"), `${generation}.json`);
	const snapshot = {
		version: 1,
		sessionId: "released-live",
		generation,
		pid: process.pid,
		revision: 1,
		observedAt: Date.now(),
		activity: null,
		ownerToken: owner.token,
		locator: fixture.pane,
	};
	save(path, snapshot);
	const reader = new LiveActivityReader();
	assert.deepEqual(paneLocator((await reader.locator("released-live"))?.locator), fixture.pane);
	for (const locator of [
		{ ...fixture.pane, adapter: "herdr" },
		{ adapter: "tmux", version: 1, kind: "pane", pane: {} },
	]) {
		save(path, { ...snapshot, locator });
		assert.equal(await reader.locator("released-live"), undefined);
		assert.equal(normalizeLiveLocator(locator), undefined);
	}
	const publisher = new LiveActivityPublisher("new-live");
	publisher.publishLocator(fixture.pane, owner.token);
	await publisher.flush();
	const published = JSON.parse(readFileSync(join(liveSessionDir("new-live"), `${publisher.generation}.json`), "utf8"));
	assert.equal("windowId" in published.locator, false);
	assert.deepEqual(paneLocator(published.locator), fixture.pane);
	publisher.stop();
	await publisher.closed();
});
