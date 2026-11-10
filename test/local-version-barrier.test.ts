import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, beforeEach, test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ChildTasks, readChildRecords } from "../src/child-tasks.ts";
import { isStarted, START_TYPE } from "../src/result-types.ts";
import type { Delegation } from "../src/results.ts";
import { sessionIsOwned } from "../src/session-owner.ts";
import { locatedRecord, windowLocator } from "../src/tmux.ts";
import { readTree, reconcileTree, reserveTree, treeCounts, treePath } from "../src/tree-registry.ts";
import { assertChildAuthority, historicalRecord } from "../src/tree-view.ts";
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
import { TreeProcess } from "./tree-process-harness.ts";

const ROOT = "released-parent";
const ID = "released-child";
const path = (): string => join(agentDir, "squire", "child-tasks", `${ROOT}.json`);
const bytes = (): string => readFileSync(path(), "utf8");
const live = { id: "@72", name: "reopened" };
type OldPoll = {
	refusal?: string;
	running: string[];
	appended: number;
	messages: number;
	listCalls: number;
	completionReady: boolean;
};
beforeEach(() => {
	resetRoot();
	writeAgent("scout", agentFile({ model: "alpha/fast-model" }));
});
after(cleanup);
function save(file: string, value: unknown): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(value));
}
function launch(): Delegation {
	const fixture = JSON.parse(readFileSync(new URL("./fixtures/released-window-records.json", import.meta.url), "utf8"));
	const record = locatedRecord({ ...fixture.started, locator: windowLocator(live) }) as Delegation;
	const entry = locatedRecord({ ...fixture.tree.entries[0], locator: windowLocator(live) });
	delete entry.gone;
	delete entry.launch;
	save(treePath(ROOT), { version: 2, root: ROOT, entries: [entry] });
	assert.equal(sessionIsOwned(ID), false, "the child is delayed/unclaimed, not protected by a live owner marker");
	return record;
}
async function withOld(work: (old: TreeProcess) => Promise<void>): Promise<void> {
	const old = new TreeProcess(agentDir, "./fixtures/local-version-process.ts");
	try {
		await old.ready;
		await work(old);
	} finally {
		await old.kill();
	}
}
async function poll(old: TreeProcess, entries: Entry[]): Promise<{ result: OldPoll; transcript: string }> {
	const transcript = join(agentDir, "old-transcript.json");
	save(
		transcript,
		entries.map((entry) => ({ type: "custom", ...entry })),
	);
	const result = await old.command<OldPoll>("poll-save", { session: ROOT, transcript });
	return { result, transcript };
}
function capacityStillCharged(): void {
	assert.deepEqual(treeCounts(readTree(ROOT)), { concurrent: 1, lifetime: 1 });
	save(join(agentDir, "squire", "settings.json"), { maxConcurrentDelegates: 1 });
	assert.throws(
		() =>
			reserveTree({
				id: "another",
				sessionId: "another",
				identity: {
					parent: ROOT,
					root: ROOT,
					rootPlacement: "project-delegate-session",
					depth: 1,
					agent: "scout",
					chain: ["scout"],
					autoExit: false,
				},
			}),
		/count 1, limit 1/,
	);
}

test("control: tree barrier alone cannot stop a downgraded released parent poisoning local gone facts", async () => {
	const record = launch();
	save(path(), { records: [record], outcomes: [] });
	await withOld(async (old) => {
		const { result } = await poll(old, [{ customType: "delegate", data: record }]);
		assert.equal(result.listCalls, 1);
		assert.equal(result.appended, 1);
		const saved = readChildRecords(ROOT)[0];
		assert.ok(isStarted(saved));
		assert.equal(saved.gone, true, "actual released poll falsely treats missing raw fields as gone");
		const tmux = new FakeTmux();
		tmux.addWindow(live.id, live.name);
		await reconcileTree(ROOT, tmux);
		assert.deepEqual(treeCounts(readTree(ROOT)), { concurrent: 0, lifetime: 1 }, "control reproduces the bad refund");
		assert.equal(tmux.windows.has("@72"), true);
	});
});

for (const crashGap of [false, true]) {
	test(`released same-parent downgrade refuses local restore/save and ignores v2 starts (${crashGap ? "start absent locally" : "start durable locally"})`, async () => {
		const record = launch();
		save(path(), { version: 2, state: { records: crashGap ? [] : [record], outcomes: [], paused: false } });
		const before = bytes();
		await withOld(async (old) => {
			await assert.rejects(old.command("read", { session: ROOT }), /invalid child task record/);
			const attempts = await old.command<{ restoreError: string; saveError: string; unreadable: boolean }>(
				"restore-save",
				{ session: ROOT },
			);
			assert.match(attempts.restoreError, /expected records and outcomes arrays/);
			assert.match(attempts.saveError, /unreadable/);
			assert.equal(attempts.unreadable, true);
			const entry: Entry = { customType: START_TYPE, data: record };
			const { result, transcript } = await poll(old, [entry]);
			assert.match(result.refusal ?? "", /unreadable/);
			assert.deepEqual(result.running, []);
			assert.equal(result.completionReady, false);
			assert.equal(result.listCalls, 0);
			assert.equal(result.appended, 0);
			assert.equal(result.messages, 0);
			assert.equal(bytes(), before);
			assert.deepEqual(JSON.parse(readFileSync(transcript, "utf8")), [{ type: "custom", ...entry }]);
			const upgraded = session({ parent: ROOT, entries: [entry] });
			upgraded.tmux.addWindow(live.id, live.name);
			await upgraded.start();
			const status = (await upgraded.toolCall("delegation_status", { id: ID })).structuredContent as {
				delegations: { state: string }[];
			};
			assert.equal(status.delegations[0].state, "running");
			await reconcileTree(ROOT, upgraded.tmux);
			assert.equal(readTree(ROOT).entries[0].gone, undefined);
			assert.equal(readTree(ROOT).entries[0].closed, undefined);
			capacityStillCharged();
			await upgraded.shutdown();
		});
	});
}

test("an explicit malformed child-task wrapper never falls back to legacy arrays or permits a repair save", () => {
	const state = { records: [], outcomes: [] };
	const legacy = JSON.parse(
		readFileSync(new URL("./fixtures/released-window-records.json", import.meta.url), "utf8"),
	).started;
	for (const wire of [
		{ version: 2, state: { records: [legacy], outcomes: [] } },
		{ version: 2, state: { records: [{ ...legacy, locator: windowLocator(live), model: undefined }], outcomes: [] } },
		{ version: 2, state: null, ...state },
		{ version: 3, state, ...state },
		{ state, ...state },
		{ version: 2, state: { records: [], outcomes: "bad" }, ...state },
		{ version: 2, state, ...state },
	]) {
		save(path(), wire);
		const before = bytes();
		assert.throws(() => readChildRecords(ROOT), /child task record/);
		const tasks = new ChildTasks();
		assert.throws(() => tasks.restore(ROOT), /child task record/);
		assert.throws(() => tasks.save([]), /unreadable/);
		assert.equal(bytes(), before);
	}
});

test("malformed explicit v2 start cannot fall back to legacy fields or an earlier legacy start", async () => {
	const record = launch();
	const legacy = JSON.parse(
		readFileSync(new URL("./fixtures/released-window-records.json", import.meta.url), "utf8"),
	).started;
	for (const bad of [
		{ ...record, locator: undefined, windowId: "@72", windowName: "reopened" },
		{ ...record, model: undefined },
	]) {
		save(path(), { version: 2, state: { records: [], outcomes: [] } });
		const s = session({
			parent: ROOT,
			entries: [
				{ customType: "delegate", data: legacy },
				{ customType: START_TYPE, data: bad },
			],
		});
		await s.start();
		await assert.rejects(s.toolCall("delegate", { agent: "scout", task: "unsafe" }), /restoration failed/);
		assert.throws(() => historicalRecord(ID, s.context as unknown as ExtensionContext), /invalid v2 delegate start/);
		assert.deepEqual(s.tmux.opened, []);
		assert.deepEqual(s.sendCalls, []);
		await s.shutdown();
	}
});

test("new restore and historical lookup read mixed start generations without granting copied fork authority", async () => {
	const current = { ...launch(), id: "opaque-child", requestId: "opaque-request" };
	const fixture = JSON.parse(readFileSync(new URL("./fixtures/released-window-records.json", import.meta.url), "utf8"));
	const entries: Entry[] = [
		{ customType: "delegate", data: fixture.started },
		{ customType: START_TYPE, data: current },
	];
	const s = session({ parent: ROOT, entries });
	s.tmux.addWindow("@71", "scout-released");
	s.tmux.addWindow("@72", "reopened");
	await s.start();
	const status = (await s.toolCall("delegation_status", {})).structuredContent as {
		delegations: { id: string; state: string }[];
	};
	assert.equal(status.delegations.find((row) => row.id === ID)?.state, "running");
	assert.equal(status.delegations.find((row) => row.id === "opaque-child")?.state, "running");
	assert.equal(historicalRecord("opaque-child", s.context as unknown as ExtensionContext)?.id, "opaque-child");
	await s.shutdown();
	const copy = session({ parent: "copied-parent", entries, sessionHeader: { parentSession: "/original.jsonl" } });
	await copy.start();
	assert.throws(
		() => assertChildAuthority(current, copy.context as unknown as ExtensionContext, "fork"),
		/only direct parent/,
	);
	const copied = (await copy.toolCall("delegation_status", {})).structuredContent as { delegations: unknown[] };
	assert.deepEqual(copied.delegations, []);
	await copy.shutdown();
});

test("a committed local wrapper plus failed tree migration leaves legacy tree bytes intact and cannot launch", async () => {
	const fixture = JSON.parse(readFileSync(new URL("./fixtures/released-window-records.json", import.meta.url), "utf8"));
	Object.assign(fixture.tree.entries[0], { launch: fixture.started });
	save(path(), { records: [fixture.started], outcomes: [] });
	save(treePath(ROOT), fixture.tree);
	const before = readFileSync(treePath(ROOT), "utf8");
	const s = session({ parent: ROOT });
	s.tmux.addWindow("@71", "scout-released");
	await s.start();
	const temporary = `${treePath(ROOT)}.${process.pid}.tmp`;
	mkdirSync(temporary);
	try {
		await assert.rejects(s.toolCall("delegate", { agent: "scout", task: "blocked" }), /EISDIR/);
		assert.equal(JSON.parse(bytes()).version, 2);
		assert.equal(readFileSync(treePath(ROOT), "utf8"), before);
		assert.deepEqual(s.tmux.opened, []);
		assert.deepEqual(s.sendCalls, []);
		assert.equal(
			s.entries.some((entry) => entry.customType === START_TYPE),
			false,
		);
		const old = new TreeProcess(agentDir, "./fixtures/tree-version-process.ts");
		try {
			await assert.rejects(
				old.command("reconcile", {
					root: ROOT,
					id: ID,
					released: true,
					windows: [{ id: "@71", name: "scout-released" }],
				}),
				/invalid child task record/,
			);
			assert.equal(readFileSync(treePath(ROOT), "utf8"), before);
		} finally {
			await old.kill();
		}
	} finally {
		rmSync(temporary, { recursive: true });
		await s.shutdown();
	}
});

for (const operation of ["delegation_resume", "delegation_fork"] as const) {
	test(`${operation} establishes both durable barriers before close/mail/open/new journal effects`, async () => {
		const fixture = JSON.parse(
			readFileSync(new URL("./fixtures/released-window-records.json", import.meta.url), "utf8"),
		);
		save(path(), { records: [fixture.started], outcomes: [] });
		Object.assign(fixture.tree.entries[0], { launch: fixture.started });
		save(treePath(ROOT), fixture.tree);
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(join(sessionDir, `date_${ID}.jsonl`), `${JSON.stringify({ type: "session", id: ID, cwd: root })}\n`);
		const s = session({ parent: ROOT });
		s.tmux.addWindow("@71", "scout-released");
		if (operation === "delegation_resume") s.tmux.exit("@71");
		await s.start();
		assert.equal(
			Array.isArray(JSON.parse(bytes()).records),
			true,
			"legacy local data remains readable before mutation",
		);
		assert.equal(JSON.parse(readFileSync(treePath(ROOT), "utf8")).version, 1);
		const assertBarriers = (): void => {
			const wire = JSON.parse(bytes());
			assert.equal(wire.version, 2);
			assert.equal("records" in wire, false);
			assert.equal(JSON.parse(readFileSync(treePath(ROOT), "utf8")).version, 2);
		};
		const kill = s.tmux.kill.bind(s.tmux);
		s.tmux.kill = async (id: string): Promise<void> => {
			assertBarriers();
			await kill(id);
		};
		let observed = false;
		s.events.on("session:launch", () => {
			assertBarriers();
			assert.equal(
				s.entries.some((entry) => entry.customType === START_TYPE),
				false,
			);
			assert.equal(s.tmux.opened.length, 0);
			observed = true;
		});
		await s.toolCall(operation, { id: ID, task: "continue" });
		assert.equal(observed, true);
		assert.equal(
			s.entries.some((entry) => entry.customType === START_TYPE),
			true,
		);
		await s.shutdown();
	});
}

test("fresh launch establishes rejecting local wrapper and shared v2 before mail/open/opaque journal effects", async () => {
	const s = session({ parent: ROOT });
	await s.start();
	let observed = false;
	s.events.on("session:launch", () => {
		const wire = JSON.parse(bytes());
		assert.equal(wire.version, 2);
		assert.equal(Array.isArray(wire.records), false);
		assert.equal(JSON.parse(readFileSync(treePath(ROOT), "utf8")).version, 2);
		assert.equal(
			s.entries.some((entry) => entry.customType === START_TYPE),
			false,
		);
		assert.equal(s.tmux.opened.length, 0);
		observed = true;
	});
	await s.toolCall("delegate", { agent: "scout", task: "inspect" });
	assert.equal(observed, true);
	assert.equal(s.entries[0].customType, START_TYPE);
	assert.equal(existsSync(path()), true);
	await s.shutdown();
});
