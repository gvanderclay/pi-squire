import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PaseoWorkspace } from "@getpaseo/client";
import { ChildTasks, readChildRecords } from "../src/child-tasks.ts";
import { type CleanupDeps, type CleanupResult, cleanupText, cleanup as runCleanup } from "../src/cleanup.ts";
import { type Identity, writeIdentity } from "../src/identity.ts";
import { createPaseoHost } from "../src/paseo.ts";
import { createPaseoApi } from "../src/paseo-api.ts";
import { restoreRecords } from "../src/result-restore.ts";
import type { Recorded, StartedRecorded, WorkspaceAttempt } from "../src/result-types.ts";
import { windowLocator } from "../src/tmux.ts";
import { readTree, type TreeEntry, treePath, treeTransaction } from "../src/tree-registry.ts";
import type { PaseoReceipt } from "../src/worktree.ts";
import { fixture, git } from "./cleanup-fixture.ts";
import { agentDir, agentFile, cleanup, resetRoot, root, session, sessionDir, writeAgent } from "./harness.ts";
import { FakePaseo } from "./paseo-fixture.ts";

type Session = ReturnType<typeof session>;
const sessions: Session[] = [];
function instance(cwd = root): Session {
	const s: Session = session({ cwd });
	sessions.push(s);
	return s;
}
beforeEach(() => {
	resetRoot();
	writeAgent("scout", agentFile({ model: "alpha/fast-model" }));
});
afterEach(async () => {
	for (const s of sessions.splice(0)) await s.shutdown();
});
after(cleanup);
function save(parent: string, records: Recorded[]): void {
	const dir: string = join(agentDir, "squire", "child-tasks");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${parent}.json`), JSON.stringify({ records, outcomes: [] }));
}
function own(parent: string, rootId = parent): Identity {
	return {
		parent,
		root: rootId,
		rootPlacement: "fixture-delegates",
		depth: parent === rootId ? 1 : 2,
		agent: "scout",
		chain: ["scout"],
		autoExit: true,
	};
}
function started(f: ReturnType<typeof fixture>, parent: string, id = "child", rootId = parent): StartedRecorded {
	return {
		id,
		agent: "scout",
		model: "alpha/fast-model",
		thinking: "low",
		requestId: "request",
		cwd: f.cwd,
		workspace: f.workspace,
		identity: own(parent, rootId),
		sessionDir,
		locator: windowLocator({ id: "@77", name: "scout-fixture" }),
		gone: true,
	};
}
function entry(record: StartedRecorded): TreeEntry {
	assert.ok(record.identity);
	return {
		id: record.id,
		sessionId: record.sessionId ?? record.id,
		identity: record.identity,
		ownerPid: process.pid,
		phase: "started",
		cwd: record.cwd,
		workspace: record.workspace,
		sessionDir: record.sessionDir,
		locator: record.locator,
		gone: record.gone,
	};
}
function publish(parent: string, records: Recorded[]): void {
	save(parent, records);
	for (const record of records)
		if (!("kind" in record) && record.identity) {
			treeTransaction(record.identity.root, (state) => state.entries.push(entry(record)));
			writeIdentity(record.id, record.identity);
		}
}
async function invoke(s: Session, request: { ids?: string[]; all?: boolean } = { all: true }): Promise<CleanupResult> {
	return (await s.toolCall("delegation_cleanup", request)).structuredContent as CleanupResult;
}
function deps(s: Session, extra: Partial<CleanupDeps> = {}): CleanupDeps {
	return { host: s.tmux, assertActive: () => {}, gh: () => ({ ok: false, message: "absent" }), ...extra };
}
function context(s: Session): ExtensionContext {
	return s.context as unknown as ExtensionContext;
}

test("tool removes a legacy managed start, returns already-clean on retry and marks status workspace removed", async () => {
	const f = fixture();
	const s = instance(f.source);
	await s.start();
	const record: StartedRecorded = started(f, s.parent);
	publish(s.parent, [record]);
	// Legacy unversioned records and no new workspace fields remain eligible.
	const restored: Session = session({
		parent: s.parent,
		cwd: f.source,
		entries: [{ customType: "delegate", data: record }],
	});
	await s.shutdown();
	sessions.push(restored);
	await restored.start();
	const first: CleanupResult = await invoke(restored);
	assert.equal(first.items[0].outcome, "removed", first.items[0].reason);
	assert.equal((await invoke(restored)).items[0].outcome, "already-clean");
	const status = await restored.toolCall("delegation_status", { id: record.id });
	assert.match(status.content[0].text, /workspace removed/);
	assert.equal((status.structuredContent as { delegations: { canResume: boolean }[] }).delegations[0].canResume, false);
	const compact = await restored.toolCall("delegation_status", {});
	assert.match(compact.content[0].text, /workspace removed/);
});
test("retained and interrupted-after-created attempts including grandchildren are discovered", async () => {
	const s = instance();
	await s.start();
	const f = fixture();
	const coordinator: StartedRecorded = started(f, s.parent, "coordinator");
	coordinator.workspace = { mode: "existing", cwd: root, git: { kind: "non-git" } };
	coordinator.cwd = root;
	publish(s.parent, [coordinator]);
	const records: WorkspaceAttempt[] = [];
	for (const phase of ["retained", "interrupted"] as const) {
		const next = fixture();
		records.push({
			kind: "workspace-attempt",
			id: phase,
			parentId: coordinator.id,
			agent: "scout",
			model: "alpha/fast-model",
			thinking: "low",
			sessionDir,
			plan: next.plan,
			attempt:
				phase === "retained"
					? {
							phase,
							resources: { kind: "worktree", cwd: next.cwd, branch: "topic", head: next.plan.baseCommit },
							cause: "window refused",
							recovery: [],
						}
					: {
							phase,
							lastPhase: "created",
							resources: { kind: "worktree", cwd: next.cwd, branch: "topic", head: next.plan.baseCommit },
							reason: "interrupted",
						},
		});
	}
	save(coordinator.id, records);
	const result: CleanupResult = await invoke(s);
	assert.deepEqual(
		result.items.map((item) => [item.id, item.outcome]),
		[
			["retained", "removed"],
			["interrupted", "removed"],
		],
	);
});
test("inherited, existing and planned attempts requested explicitly are kept as non-candidates", async () => {
	const s = instance();
	await s.start();
	const f = fixture();
	const inherited: StartedRecorded = started(f, s.parent, "inherited");
	inherited.workspace = { mode: "inherited", cwd: root, git: { kind: "non-git" } };
	const existing: StartedRecorded = {
		...inherited,
		id: "existing",
		workspace: { ...inherited.workspace, mode: "existing" },
	};
	const planned: WorkspaceAttempt = {
		kind: "workspace-attempt",
		id: "planned",
		parentId: s.parent,
		agent: "scout",
		model: "alpha/fast-model",
		thinking: "low",
		sessionDir,
		plan: f.plan,
		attempt: { phase: "planned", resources: { kind: "none" } },
	};
	publish(s.parent, [inherited, existing, planned]);
	const result: CleanupResult = await invoke(s, { ids: ["inherited", "existing", "planned"] });
	assert.ok(result.items.every((item) => item.outcome === "kept" && item.reason === "not a Squire-created worktree"));
	assert.equal((await invoke(s)).items.length, 0);
	assert.equal(existsSync(f.cwd), true);
});
test("selection requires exactly ids or all and refuses foreign descendants before any mutation", async () => {
	const s = instance();
	await s.start();
	const f = fixture();
	publish(s.parent, [started(f, s.parent)]);
	await assert.rejects(invoke(s, {}), /pass ids or all/);
	await assert.rejects(invoke(s, { ids: ["child"], all: true }), /pass ids or all/);
	await assert.rejects(invoke(s, { ids: ["child", "foreign"] }), /descendant tree/);
	assert.equal(existsSync(f.cwd), true);
	const other: Session = instance();
	await other.start();
	assert.equal((await invoke(other)).items.length, 0);
	await assert.rejects(invoke(other, { ids: ["child"] }), /descendant tree/);
});
test("aliases are processed once, reported each, and kept text groups at most ten ids", async () => {
	const s = instance();
	await s.start();
	const f = fixture();
	const first: StartedRecorded = started(f, s.parent);
	const alias: StartedRecorded = { ...first, id: "alias", sessionId: first.id, resumedFrom: first.id };
	publish(s.parent, [first, alias]);
	const result: CleanupResult = await invoke(s, { ids: ["child", "alias"] });
	assert.deepEqual(
		result.items.map((item) => item.outcome),
		["removed", "removed"],
	);
	const text: string = cleanupText({
		items: Array.from({ length: 12 }, (_, i) => ({ id: `id${i}`, outcome: "kept", reason: "dirty", remains: [] })),
		counts: { removed: 0, kept: 12, partial: 0, alreadyClean: 0 },
	});
	assert.match(text, /id9 and 2 more/);
	assert.ok(!text.includes("id10"));
});
test("all group cap reports omittedIds; explicit ids reaches omitted groups without starvation", async () => {
	const s = instance();
	await s.start();
	const records: StartedRecorded[] = [0, 1, 2].map((i) => started(fixture(), s.parent, `child${i}`));
	publish(s.parent, records);
	const result: CleanupResult = await runCleanup({ all: true }, deps(s, { maxGroups: 1 }), context(s));
	assert.deepEqual(result.selection, {
		total: 3,
		processed: 1,
		omitted: 2,
		omittedIds: ["child1", "child2"],
		notice: "Stops starting new worktrees after about 120 s; the rest are listed in omittedIds. Pass ids for them.",
	});
	const retry: CleanupResult = await invoke(s, { ids: result.selection?.omittedIds });
	assert.ok(retry.items.every((item) => item.outcome === "removed"));
});
test("running windows and unrecorded Paseo workspaces keep without Git mutations", async () => {
	const s = instance();
	await s.start();
	const f = fixture();
	const record: StartedRecorded = started(f, s.parent);
	publish(s.parent, [record]);
	s.tmux.windows.set("@77", { name: "scout-fixture", exited: false, session: "work" });
	assert.match((await invoke(s)).items[0].reason, /running delegation window/);
	s.tmux.windows.clear();
	const paseo: StartedRecorded = {
		...record,
		locator: {
			adapter: "paseo",
			version: 1,
			kind: "window",
			agent: "11111111-1111-4111-8111-111111111111",
			name: "paseo",
		},
	};
	save(s.parent, [paseo]);
	const api = new FakePaseo();
	api.workspaces.set("foreign", { id: "foreign", workspaceDirectory: f.cwd } as PaseoWorkspace);
	const result = await runCleanup({ all: true }, deps(s, { paseoApi: () => api }), context(s));
	assert.equal(result.items[0].reason, "Paseo workspace not created by Squire; kept; use /delegate-cleanup");
	assert.equal(existsSync(f.cwd), true);
});

function paseoFixture(s: Session, provenance: PaseoReceipt["provenance"] = "created") {
	const f = fixture();
	const receipt: PaseoReceipt = {
		home: "/fake-paseo",
		workspaceId: "workspace",
		directory: f.cwd,
		projectId: "project",
		provenance,
	};
	const record = started(f, s.parent);
	record.workspace = { ...f.workspace, paseo: receipt };
	const api = new FakePaseo();
	api.workspaces.set("workspace", {
		id: "workspace",
		workspaceDirectory: f.cwd,
		projectId: "project",
		archivingAt: null,
		scripts: [],
	} as unknown as PaseoWorkspace);
	publish(s.parent, [record]);
	const run = () =>
		runCleanup(
			{ all: true },
			deps(s, {
				paseoApi: (home) => {
					assert.equal(home, receipt.home);
					return api;
				},
			}),
			context(s),
		);
	return { f, api, record, receipt, run };
}
test("created Paseo receipt archives before Git re-check; late untracked changes keep Git as partial", async () => {
	const s = instance();
	await s.start();
	const { f, api, run } = paseoFixture(s);
	const check = unchangedWorktree(f);
	api.afterArchive = () => {
		check();
		writeFileSync(join(f.cwd, "late"), "untracked");
	};
	const result = await run();
	assert.equal(result.items[0].outcome, "partial");
	assert.match(result.items[0].reason, /uncommitted or untracked/);
	assert.equal(api.workspaces.size, 0);
	assert.deepEqual(api.calls.slice(-4), ["archiveWorkspace", "workspace", "agentsUsing", "terminalsUsing"]);
	check();
});
test("created Paseo workspace removed once, absent before archive also proceeds, retry already-clean", async () => {
	const s = instance();
	await s.start();
	const { f, api, run } = paseoFixture(s);
	const result = await run();
	assert.equal(result.items[0].outcome, "removed");
	assert.equal(result.items[0].reason, "merged, unused and clean; Paseo workspace archived");
	assert.match(cleanupText(result), /Paseo workspace archived/);
	assert.equal(existsSync(f.cwd), false);
	assert.equal(api.calls.filter((call) => call === "archiveWorkspace").length, 1);
	assert.equal((await run()).items[0].outcome, "already-clean");
	assert.equal(api.calls.filter((call) => call === "archiveWorkspace").length, 1);
});
test("already absent Paseo workspace permits removing a still-present worktree without archive", async () => {
	const s = instance();
	await s.start();
	const { f, api, run } = paseoFixture(s);
	api.workspaces.clear();
	const result = await run();
	assert.equal(result.items[0].outcome, "removed", result.items[0].reason);
	assert.equal(existsSync(f.cwd), false);
	assert.equal(api.calls.includes("archiveWorkspace"), false);
});
test("opened and reused receipts keep; a created alias authorizes that exact workspace", async (t) => {
	for (const provenance of ["opened", "reused"] as const)
		await t.test(provenance, async () => {
			resetRoot();
			const s = instance();
			await s.start();
			const { f, api, record, run } = paseoFixture(s, provenance);
			const check = unchangedWorktree(f);
			assert.equal((await run()).items[0].reason, "Paseo workspace not created by Squire; kept; use /delegate-cleanup");
			assert.equal(api.calls.includes("archiveWorkspace"), false);
			check();
			assert.ok(record.workspace?.mode === "managed");
			const alias = {
				...record,
				id: "alias",
				workspace: { ...record.workspace, paseo: { ...record.workspace.paseo!, provenance: "created" as const } },
			};
			save(s.parent, [record, alias]);
			const result = await run();
			assert.ok(result.items.every((item) => item.outcome === "removed"));
			assert.equal(api.calls.filter((call) => call === "archiveWorkspace").length, 1);
		});
});
test("multiple foreign workspaces omit the unusable command pointer without extra daemon calls", async (t) => {
	for (const mode of ["legacy", "created", "opened"] as const) {
		await t.test(mode, async () => {
			const s = instance();
			await s.start();
			const { f, api, record, run } = paseoFixture(s, mode === "opened" ? "opened" : "created");
			const workspace = api.workspaces.get("workspace")!;
			api.workspaces.set("second", { ...workspace, id: "second" });
			if (mode === "created") api.workspaces.set("third", { ...workspace, id: "third" });
			if (mode === "legacy") {
				record.workspace = f.workspace;
				save(s.parent, [record]);
			} else if (mode === "opened") {
				assert.ok(record.workspace?.mode === "managed");
				save(s.parent, [
					record,
					{
						...record,
						id: "alias",
						workspace: {
							...record.workspace,
							paseo: { ...record.workspace.paseo!, workspaceId: "second" },
						},
					},
				]);
			}
			const result =
				mode === "legacy" ? await runCleanup({ all: true }, deps(s, { paseoApi: () => api }), context(s)) : await run();
			assert.equal(result.items[0].outcome, "kept");
			assert.equal(result.items[0].reason, "Paseo workspace not created by Squire; kept");
			assert.deepEqual(
				api.calls,
				mode === "opened"
					? []
					: mode === "legacy"
						? ["availability", "workspaceAt"]
						: ["availability", "workspace", "agentsUsing", "terminalsUsing", "workspaceAt"],
			);
			assert.equal(existsSync(f.cwd), true);
			await s.shutdown();
			resetRoot();
		});
	}
});
test("unreadable Paseo receipts keep Git without choosing a daemon or archiving", async (t) => {
	const malformed: Record<string, unknown> = {
		"null receipt": null,
		"false receipt": false,
		"string receipt": "created",
		"missing home": { home: undefined },
		"relative home": { home: "relative/paseo" },
		"non-string home": { home: 3 },
		"missing workspaceId": { workspaceId: undefined },
		"non-string workspaceId": { workspaceId: 3 },
		"empty workspaceId": { workspaceId: "" },
		"missing directory": { directory: undefined },
		"non-string directory": { directory: 3 },
		"missing projectId": { projectId: undefined },
		"non-string projectId": { projectId: 3 },
		"missing provenance": { provenance: undefined },
		"unknown provenance": { provenance: "foreign" },
	};
	for (const [name, fields] of Object.entries(malformed))
		await t.test(name, async () => {
			resetRoot();
			const s = instance();
			await s.start();
			const { f, api, record, receipt } = paseoFixture(s);
			assert.ok(record.workspace?.mode === "managed");
			record.workspace.paseo = (
				fields && typeof fields === "object" ? { ...receipt, ...fields } : fields
			) as PaseoReceipt;
			save(s.parent, [record]);
			const check = unchangedWorktree(f);
			const result = await runCleanup(
				{ all: true },
				deps(s, {
					paseoApi: () => {
						throw new Error("invalid receipt reached daemon selection");
					},
				}),
				context(s),
			);
			assert.equal(result.items[0].outcome, "kept");
			assert.equal(result.items[0].reason, "Paseo workspace receipt unreadable");
			assert.deepEqual(api.calls, []);
			check();
		});
});

test("each Paseo workspace or user blocker keeps unchanged Git and never archives", async (t) => {
	const cases = [
		"agent id",
		"agent cwd",
		"terminal id",
		"terminal cwd",
		"setup",
		"script",
		"owned",
		"archiving",
		"internal",
		"directory",
		"project",
		"foreign workspace",
	];
	for (const kind of cases)
		await t.test(kind, async () => {
			resetRoot();
			const s = instance();
			await s.start();
			const { f, api, run } = paseoFixture(s);
			const workspace = api.workspaces.get("workspace")!;
			const reasons: Record<string, RegExp> = {
				"agent id": /live Paseo agent/,
				"agent cwd": /live Paseo agent/,
				"terminal id": /live Paseo terminal/,
				"terminal cwd": /live Paseo terminal/,
				setup: /setup running/,
				script: /script running/,
				owned: /Paseo-owned/,
				archiving: /already archiving/,
				internal: /internal Paseo/,
				directory: /identity changed/,
				project: /identity changed/,
				"foreign workspace": /not created by Squire/,
			};
			if (kind.startsWith("agent"))
				api.agents.push({
					id: "user",
					workspaceId: kind.endsWith("id") ? "workspace" : "other",
					cwd: kind.endsWith("cwd") ? join(f.cwd, "inside") : "/outside",
				});
			if (kind.startsWith("terminal"))
				api.terminals.push({
					id: "user",
					workspaceId: kind.endsWith("id") ? "workspace" : "other",
					cwd: kind.endsWith("cwd") ? join(f.cwd, "inside") : "/outside",
				});
			if (kind === "setup") workspace.setupStatus = "running";
			if (kind === "script") workspace.scripts = [{ lifecycle: "running" }] as PaseoWorkspace["scripts"];
			if (kind === "owned") workspace.gitRuntime = { isPaseoOwnedWorktree: true };
			if (kind === "archiving") workspace.archivingAt = "now";
			if (kind === "internal") workspace.internal = true;
			if (kind === "directory") workspace.workspaceDirectory = "/replaced";
			if (kind === "project") workspace.projectId = "replaced";
			if (kind === "foreign workspace") api.workspaces.set("foreign", { ...workspace, id: "foreign" });
			const check = unchangedWorktree(f);
			const result = await run();
			assert.equal(result.items[0].outcome, "kept", result.items[0].reason);
			assert.match(result.items[0].reason, reasons[kind]);
			assert.equal(api.calls.includes("archiveWorkspace"), false);
			check();
		});
});
test("workspace or agent/terminal survivor after archive is partial with no Git step", async (t) => {
	for (const kind of ["workspace", "agent", "terminal", "error"])
		await t.test(kind, async () => {
			resetRoot();
			const s = instance();
			await s.start();
			const { f, api, run } = paseoFixture(s);
			const check = unchangedWorktree(f);
			if (kind === "workspace") api.survivor = true;
			api.afterArchive = () => {
				if (kind === "agent") api.agents.push({ id: "late", workspaceId: "workspace", cwd: "/outside" });
				if (kind === "terminal") api.terminals.push({ id: "late", workspaceId: "workspace", cwd: "/outside" });
				if (kind === "error") throw new Error("archive reply lost");
			};
			const result = await run();
			assert.equal(result.items[0].outcome, "partial");
			assert.match(result.items[0].reason, /Git cleanup skipped/);
			assert.equal(api.calls.includes("archiveWorkspace"), true);
			check();
		});
});
test("Git preview blocks dirty or unmerged work before any Paseo archive", async (t) => {
	for (const kind of ["dirty", "unmerged"])
		await t.test(kind, async () => {
			resetRoot();
			const s = instance();
			await s.start();
			const { f, api, run } = paseoFixture(s);
			writeFileSync(join(f.cwd, "work"), kind);
			if (kind === "unmerged") {
				git(f.cwd, "add", "work");
				git(f.cwd, "commit", "-m", "unmerged");
			}
			const check = unchangedWorktree(f);
			const result = await run();
			assert.equal(result.items[0].outcome, "kept");
			assert.match(result.items[0].reason, kind === "dirty" ? /uncommitted or untracked/ : /merge not proved/);
			assert.deepEqual(api.calls, []);
			check();
		});
});
test("receipt with daemon down keeps; legacy absent receipt with no workspace or daemon proceeds", async (t) => {
	for (const mode of ["receipt down", "legacy up", "legacy down"])
		await t.test(mode, async () => {
			resetRoot();
			const s = instance();
			await s.start();
			const { f, api, record } = paseoFixture(s);
			api.down = mode.endsWith("down");
			if (mode.startsWith("legacy")) {
				record.workspace = f.workspace;
				save(s.parent, [record]);
				api.workspaces.clear();
			}
			const result = await runCleanup({ all: true }, deps(s, { paseoApi: () => api }), context(s));
			assert.equal(result.items[0].outcome, mode === "receipt down" ? "kept" : "removed");
			if (mode === "receipt down") assert.match(result.items[0].reason, /unavailable/);
			assert.equal(api.calls.includes("archiveWorkspace"), false);
			if (mode === "legacy down") assert.deepEqual(api.calls, ["availability"]);
		});
});
test("tmux cleanup with daemon down never imports the Paseo SDK", async () => {
	const s = instance();
	await s.start();
	const f = fixture();
	publish(s.parent, [started(f, s.parent)]);
	const hooks = registerHooks({
		resolve(specifier, context, next) {
			if (specifier.startsWith("@getpaseo/client")) throw new Error("SDK loaded by tmux cleanup");
			return next(specifier, context);
		},
	});
	try {
		const result = await runCleanup(
			{ all: true },
			deps(s, { paseoApi: () => createPaseoApi(join(root, "no-daemon")) }),
			context(s),
		);
		assert.equal(result.items[0].outcome, "removed", result.items[0].reason);
	} finally {
		hooks.deregister();
	}
});
test("tmux cleanup skips a stale dead-pid descriptor without loading the SDK", async () => {
	const s = instance();
	await s.start();
	const f = fixture();
	publish(s.parent, [started(f, s.parent)]);
	const home = join(root, "stale-paseo");
	mkdirSync(home, { recursive: true });
	writeFileSync(join(home, "paseo.pid"), JSON.stringify({ pid: 2147483647, listen: "127.0.0.1:1" }));
	const hooks = registerHooks({
		resolve(specifier, context, next) {
			if (specifier.startsWith("@getpaseo/client")) throw new Error("SDK loaded by stale descriptor");
			return next(specifier, context);
		},
	});
	try {
		const result = await runCleanup({ all: true }, deps(s, { paseoApi: () => createPaseoApi(home) }), context(s));
		assert.equal(result.items[0].outcome, "removed", result.items[0].reason);
		assert.equal(existsSync(f.cwd), false);
	} finally {
		hooks.deregister();
	}
});
test("ambiguous daemon state keeps tmux and receipt-backed Git; positively absent only skips receiptless checks", async (t) => {
	for (const receipt of [false, true]) {
		for (const state of ["absent", "ambiguous"] as const) {
			await t.test(`${receipt ? "receipt" : "tmux"} ${state}`, async () => {
				resetRoot();
				const s = instance();
				await s.start();
				const { f, api, record } = paseoFixture(s);
				if (!receipt) {
					record.workspace = f.workspace;
					save(s.parent, [record]);
				}
				api.availabilityState = { state, reason: `Paseo ${state}: test failure` };
				const result = await runCleanup({ all: true }, deps(s, { paseoApi: () => api }), context(s));
				const kept = receipt || state === "ambiguous";
				assert.equal(result.items[0].outcome, kept ? "kept" : "removed");
				assert.equal(existsSync(f.cwd), kept);
				assert.deepEqual(api.calls, ["availability"]);
				if (kept) assert.match(result.items[0].reason, /Paseo workspace unverified/);
			});
		}
	}
});
test("retry with clean Git and daemon down reports Git clean but Paseo unverified; recovery is checked afresh", async () => {
	const s = instance();
	await s.start();
	const { api, run } = paseoFixture(s);
	assert.equal((await run()).items[0].outcome, "removed");
	api.down = true;
	const result = await run();
	assert.equal(result.items[0].outcome, "kept");
	assert.deepEqual(result.items[0].resources, { git: "already-clean", paseo: "unverified" });
	assert.deepEqual(result.counts, { removed: 0, kept: 1, partial: 0, alreadyClean: 0 });
	assert.match(cleanupText(result), /Git already-clean.*Paseo workspace unverified.*unavailable/);
	assert.deepEqual(result.items[0].remains, ["paseo workspace: workspace"]);
	api.down = false;
	assert.equal((await run()).items[0].outcome, "already-clean");
});
test("already-clean Git is reported alongside a fast foreign receipt refusal without daemon calls", async (t) => {
	for (const provenance of ["opened", "reused"] as const) {
		await t.test(provenance, async () => {
			resetRoot();
			const s = instance();
			await s.start();
			const { f, api, run } = paseoFixture(s, provenance);
			git(f.source, "worktree", "remove", f.cwd);
			git(f.source, "branch", "-d", f.plan.branch);
			api.down = true;
			const result = await run();
			assert.equal(result.items[0].outcome, "kept");
			assert.deepEqual(result.items[0].resources, { git: "already-clean" });
			assert.match(result.items[0].reason, /Git already-clean.*not created by Squire.*use \/delegate-cleanup/);
			assert.deepEqual(api.calls, []);
		});
	}
});
test("Paseo launch receipt survives durable and transcript restoration; legacy absence accepted", async () => {
	const f = fixture();
	const api = new FakePaseo();
	const host = createPaseoHost(api, { PASEO_AGENT_ID: "11111111-1111-4111-8111-111111111111" });
	const s = session({ cwd: f.source, multiplexer: host });
	sessions.push(s);
	await s.start();
	const result = await s.toolCall("delegate", { agent: "scout", task: "work", worktree: "receipt" });
	const id = (result.structuredContent as { id: string }).id;
	const record = readChildRecords(s.parent).find((item) => item.id === id);
	assert.ok(record && !("kind" in record) && record.workspace?.mode === "managed");
	assert.deepEqual(record.workspace.paseo, {
		home: "/fake-paseo",
		workspaceId: "workspace",
		directory: record.cwd,
		projectId: "project",
		provenance: "created",
	});
	const receipt = record.workspace.paseo;
	assert.deepEqual((result.structuredContent as { workspace: { paseo?: PaseoReceipt } }).workspace.paseo, receipt);
	await s.shutdown();
	const restored = session({
		parent: s.parent,
		cwd: f.source,
		multiplexer: host,
		entries: [{ customType: "delegate", data: record }],
	});
	sessions.push(restored);
	await restored.start();
	const restoredRecord = restoreRecords(context(restored), new ChildTasks()).find((item) => item.id === id);
	assert.ok(restoredRecord && !("kind" in restoredRecord));
	assert.deepEqual(restoredRecord.workspace, record.workspace);
	const status = await restored.toolCall("delegation_status", { id });
	assert.match(status.content[0].text, /scout/);
	assert.deepEqual(record.workspace.paseo, receipt);
});

function owner(id: string, cwd: string): void {
	const dir: string = join(agentDir, "squire", "owners");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${id}.json`), JSON.stringify({ pid: process.pid, token: "live" }));
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(join(sessionDir, `date_${id}.jsonl`), `${JSON.stringify({ type: "session", cwd })}\n`);
}
test("owned session header cwd inside keeps; caller session and dead finished entry do not", async () => {
	const s = instance();
	await s.start();
	const f = fixture();
	publish(s.parent, [started(f, s.parent)]);
	owner("outsider", join(f.cwd, "inside"));
	assert.match((await invoke(s)).items[0].reason, /owned session cwd/);
	writeFileSync(
		join(agentDir, "squire", "owners", "outsider.json"),
		JSON.stringify({ pid: 2147483647, token: "dead" }),
	);
	writeFileSync(join(sessionDir, `date_${s.parent}.jsonl`), `${JSON.stringify({ type: "session", cwd: f.cwd })}\n`);
	assert.equal((await invoke(s)).items[0].outcome, "removed");
});
test("other-root owned overlap, pending reservations and unreadable registries keep", async (t) => {
	for (const kind of [
		"owned",
		"reserved absent",
		"reserved launch",
		"dispatched fork",
		"reserved resume",
		"unreadable",
	]) {
		await t.test(kind, async () => {
			resetRoot();
			const s = instance();
			await s.start();
			const f = fixture();
			publish(s.parent, [started(f, s.parent)]);
			const outsider: StartedRecorded = started(f, "other", "outsider");
			treeTransaction("other", (state) => {
				const next: TreeEntry = entry(outsider);
				if (kind.startsWith("reserved") || kind.startsWith("dispatched")) {
					next.phase = kind.startsWith("dispatched") ? "dispatched" : "reserved";
					next.cwd = kind === "reserved absent" ? undefined : f.cwd;
					if (kind.endsWith("fork")) next.forkedFrom = "prior";
					if (kind.endsWith("resume")) next.resumedFrom = "prior";
				}
				state.entries.push(next);
			});
			if (kind === "owned") owner("outsider", root);
			if (kind === "unreadable") writeFileSync(treePath("other"), "{broken");
			const before: string = git(f.source, "worktree", "list", "--porcelain");
			assert.equal((await invoke(s)).items[0].outcome, "kept");
			assert.equal(git(f.source, "worktree", "list", "--porcelain"), before);
			assert.equal(existsSync(f.cwd), true);
		});
	}
});
test("own created attempt with a live reserved or dispatched entry keeps its worktree and branch", async (t) => {
	for (const phase of ["reserved", "dispatched"] as const) {
		await t.test(phase, async () => {
			resetRoot();
			const s = instance();
			await s.start();
			const f = fixture();
			const record: StartedRecorded = started(f, s.parent);
			const attempt: WorkspaceAttempt = {
				kind: "workspace-attempt",
				id: record.id,
				parentId: s.parent,
				agent: record.agent,
				model: record.model,
				thinking: record.thinking,
				sessionDir,
				plan: f.plan,
				attempt: {
					phase: "created",
					resources: { kind: "worktree", cwd: f.cwd, branch: "topic", head: f.plan.baseCommit },
				},
			};
			save(s.parent, [attempt]);
			treeTransaction(s.parent, (state) => state.entries.push({ ...entry(record), phase }));
			const before: string = git(f.source, "worktree", "list", "--porcelain");
			const branches: string = git(f.source, "show-ref", "--heads");
			const result: CleanupResult = await invoke(s);
			assert.equal(result.items[0].outcome, "kept");
			assert.equal(result.items[0].reason, "live pending delegation reservation");
			assert.equal(git(f.source, "worktree", "list", "--porcelain"), before);
			assert.equal(git(f.source, "show-ref", "--heads"), branches);
			assert.equal(existsSync(f.cwd), true);
		});
	}
});
test("parallel managed launch and cleanup re-read created attempts and windows after the launch queue", async () => {
	const f = fixture();
	const s = instance(f.source);
	await s.start();
	let opening: () => void = () => {};
	const reached = new Promise<void>((resolve) => {
		opening = resolve;
	});
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const open = s.tmux.openWindow.bind(s.tmux);
	s.tmux.openWindow = async (spec, placement, companion) => {
		opening();
		await held;
		return open(spec, placement, companion);
	};
	const launching = s.toolCall("delegate", { agent: "scout", task: "work", worktree: "parallel" });
	await reached;
	const pending = readChildRecords(s.parent).find((record) => "kind" in record);
	assert.ok(pending && "kind" in pending && pending.attempt.phase === "created");
	const before: string = git(f.source, "worktree", "list", "--porcelain");
	const branches: string = git(f.source, "show-ref", "--heads");
	const cleaning = runCleanup({ all: true }, deps(s), context(s));
	release();
	await launching;
	const result: CleanupResult = await cleaning;
	assert.equal(result.items[0].id, pending.id);
	assert.equal(result.items[0].outcome, "kept");
	assert.match(result.items[0].reason, /running delegation window/);
	assert.equal(git(f.source, "worktree", "list", "--porcelain"), before);
	assert.equal(git(f.source, "show-ref", "--heads"), branches);
	assert.equal(existsSync(pending.plan.destination), true);
});
function created(f: ReturnType<typeof fixture>, parent: string, id = "child"): WorkspaceAttempt {
	return {
		kind: "workspace-attempt",
		id,
		parentId: parent,
		agent: "scout",
		model: "alpha/fast-model",
		thinking: "low",
		sessionDir,
		plan: f.plan,
		attempt: {
			phase: "created",
			resources: { kind: "worktree", cwd: f.cwd, branch: f.plan.branch, head: f.plan.baseCommit },
		},
	};
}
function unchangedWorktree(f: ReturnType<typeof fixture>): () => void {
	const trees: string = git(f.source, "worktree", "list", "--porcelain");
	const branches: string = git(f.source, "show-ref", "--heads");
	return () => {
		assert.equal(git(f.source, "worktree", "list", "--porcelain"), trees);
		assert.equal(git(f.source, "show-ref", "--heads"), branches);
		assert.equal(existsSync(f.cwd), true);
	};
}
test("grandchild opens and records its start after the window snapshot: cleanup keeps it", async () => {
	const s = instance();
	await s.start();
	const coordinator: StartedRecorded = started(fixture(), s.parent, "coordinator");
	coordinator.workspace = { mode: "existing", cwd: root, git: { kind: "non-git" } };
	publish(s.parent, [coordinator]);
	const f = fixture();
	const record: StartedRecorded = { ...started(f, coordinator.id, "grandchild", s.parent), gone: false };
	save(coordinator.id, [created(f, coordinator.id, record.id)]);
	treeTransaction(s.parent, (state) => state.entries.push({ ...entry(record), phase: "dispatched" }));
	const check = unchangedWorktree(f);
	const states = s.tmux.states.bind(s.tmux);
	s.tmux.states = async () => {
		const snapshot = await states();
		// Another process finishes opening after this host's listing, before the caller resumes.
		s.tmux.windows.set("@77", { name: "scout-fixture", exited: false, session: "work" });
		save(coordinator.id, [record]);
		treeTransaction(s.parent, (state) => {
			const ownEntry = state.entries.find((item) => item.id === record.id);
			assert.ok(ownEntry);
			Object.assign(ownEntry, entry(record));
		});
		return snapshot;
	};
	const result: CleanupResult = await runCleanup({ ids: [record.id] }, deps(s), context(s));
	assert.equal(result.items[0].outcome, "kept", result.items[0].reason);
	assert.match(result.items[0].reason, /live started delegation/);
	check();
});
test("own started registry entry without a durable start record keeps, including at the final recheck", async (t) => {
	for (const timing of ["before snapshot", "before removal"]) {
		await t.test(timing, async () => {
			resetRoot();
			const s = instance();
			await s.start();
			const f = fixture();
			const record: StartedRecorded = { ...started(f, s.parent), gone: false };
			save(s.parent, [created(f, s.parent)]);
			treeTransaction(s.parent, (state) =>
				state.entries.push({ ...entry(record), phase: timing === "before snapshot" ? "started" : "not-started" }),
			);
			s.tmux.windows.set("@77", { name: "scout-fixture", exited: false, session: "work" });
			const check = unchangedWorktree(f);
			const result: CleanupResult = await runCleanup(
				{ all: true },
				deps(s, {
					beforeRemove: () => {
						treeTransaction(s.parent, (state) => {
							const ownEntry = state.entries.find((item) => item.id === record.id);
							assert.ok(ownEntry);
							ownEntry.phase = "started";
						});
					},
				}),
				context(s),
			);
			assert.equal(result.items[0].outcome, "kept", result.items[0].reason);
			assert.match(result.items[0].reason, /live started delegation/);
			assert.equal("kind" in readChildRecords(s.parent)[0], true);
			check();
		});
	}
});
test("managed resume after cleanup's window snapshot keeps its worktree and branch", async () => {
	const f = fixture();
	const s = instance(f.source);
	await s.start();
	const launched = await s.toolCall("delegate", { agent: "scout", task: "work", worktree: "resuming" });
	const id: string = (launched.structuredContent as { id: string }).id;
	const record = readChildRecords(s.parent).find((item) => item.id === id);
	assert.ok(record && !("kind" in record) && record.cwd);
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(join(sessionDir, `date_${id}.jsonl`), `${JSON.stringify({ type: "session", id, cwd: record.cwd })}\n`);
	s.tmux.windows.clear();
	const trees: string = git(f.source, "worktree", "list", "--porcelain");
	const branches: string = git(f.source, "show-ref", "--heads");
	const states = s.tmux.states.bind(s.tmux);
	let resumed: string | undefined;
	s.tmux.states = async (strict) => {
		const snapshot = await states(strict);
		// Resume uses the existing workspace, not the managed-launch queue cleanup holds.
		s.tmux.states = states;
		const result = await s.toolCall("delegation_resume", { id, task: "resume" });
		resumed = (result.structuredContent as { id: string }).id;
		return snapshot;
	};
	const result: CleanupResult = await runCleanup({ ids: [id] }, deps(s), context(s));
	assert.ok(resumed);
	assert.equal(readTree(s.parent).entries.find((item) => item.id === resumed)?.phase, "started");
	assert.equal(result.items[0].outcome, "kept", result.items[0].reason);
	assert.match(result.items[0].reason, /live started delegation/);
	assert.equal(git(f.source, "worktree", "list", "--porcelain"), trees);
	assert.equal(git(f.source, "show-ref", "--heads"), branches);
	assert.equal(existsSync(record.cwd), true);
});
test("other-root unfinished started overlap is live even before session ownership", async () => {
	const s = instance();
	await s.start();
	const f = fixture();
	publish(s.parent, [started(f, s.parent)]);
	treeTransaction("other", (state) =>
		state.entries.push({ ...entry(started(f, "other", "starting")), cwd: join(f.cwd, "inside"), gone: false }),
	);
	const check = unchangedWorktree(f);
	const result: CleanupResult = await invoke(s);
	assert.equal(result.items[0].outcome, "kept", result.items[0].reason);
	assert.equal(result.items[0].reason, "in use by a delegation outside this tree");
	check();
});
test("a sibling branch's live start says outside this tree, not to close an unauthorized delegation", async () => {
	const rootSession = instance();
	await rootSession.start();
	const f = fixture();
	const coordinator = started(f, rootSession.parent, "coordinator");
	coordinator.workspace = { mode: "existing", cwd: root, git: { kind: "non-git" } };
	coordinator.cwd = root;
	const sibling = { ...started(f, rootSession.parent, "sibling"), gone: false };
	publish(rootSession.parent, [coordinator, sibling]);
	const child = session({ parent: coordinator.id });
	sessions.push(child);
	await child.start();
	publish(child.parent, [started(f, child.parent, "grandchild", rootSession.parent)]);
	const check = unchangedWorktree(f);
	const result = await runCleanup({ all: true }, deps(child), context(child));
	assert.equal(result.items[0].outcome, "kept");
	assert.equal(result.items[0].reason, "in use by a delegation outside this tree");
	check();
});

test("gone snapshot proof cannot exempt a same-id start with a newer window", async () => {
	const s = instance();
	await s.start();
	const f = fixture();
	publish(s.parent, [{ ...started(f, s.parent), gone: false }]);
	const check = unchangedWorktree(f);
	const result: CleanupResult = await runCleanup(
		{ all: true },
		deps(s, {
			beforeRemove: () =>
				treeTransaction(s.parent, (state) => {
					state.entries[0].locator = windowLocator({ id: "@78", name: "reopened" });
				}),
		}),
		context(s),
	);
	assert.equal(result.items[0].outcome, "kept", result.items[0].reason);
	assert.match(result.items[0].reason, /live started delegation/);
	check();
});
test("started entries with a gone snapshot, or already finished or closed, still remove", async (t) => {
	for (const fact of ["snapshot gone", "finished", "closed"]) {
		await t.test(fact, async () => {
			resetRoot();
			const s = instance();
			await s.start();
			const f = fixture();
			publish(s.parent, [{ ...started(f, s.parent), gone: false }]);
			if (fact !== "snapshot gone")
				treeTransaction("other", (state) =>
					state.entries.push({ ...entry(started(f, "other", fact)), gone: false, [fact]: true }),
				);
			const result: CleanupResult = await invoke(s);
			assert.equal(result.items[0].outcome, "removed", result.items[0].reason);
			assert.equal(existsSync(f.cwd), false);
			assert.equal(git(f.source, "branch", "--list", "topic"), "");
		});
	}
});
test("preflight remains lists only observed worktrees and branches", async () => {
	const s = instance();
	await s.start();
	const f = fixture();
	publish(s.parent, [started(f, s.parent)]);
	s.tmux.windows.set("@77", { name: "scout-fixture", exited: false, session: "work" });
	git(f.source, "update-ref", "-d", "refs/heads/topic");
	assert.deepEqual((await invoke(s)).items[0].remains, [`worktree: ${f.cwd}`]);
	git(f.source, "update-ref", "refs/heads/topic", f.plan.baseCommit);
	git(f.source, "worktree", "remove", f.cwd);
	const branchOnly: CleanupResult = await invoke(s);
	assert.equal(branchOnly.items[0].outcome, "kept");
	assert.deepEqual(branchOnly.items[0].remains, ["branch: refs/heads/topic"]);
	git(f.source, "update-ref", "-d", "refs/heads/topic");
	assert.deepEqual((await invoke(s)).items[0].remains, []);
});
test("final synchronous registry check catches a late reservation", async () => {
	const s = instance();
	await s.start();
	const f = fixture();
	publish(s.parent, [started(f, s.parent)]);
	const result: CleanupResult = await runCleanup(
		{ all: true },
		deps(s, {
			beforeRemove: () => {
				treeTransaction("other", (state) =>
					state.entries.push({ ...entry(started(f, "other", "late")), phase: "reserved" }),
				);
			},
		}),
		context(s),
	);
	assert.match(result.items[0].reason, /pending/);
	assert.equal(result.items[0].outcome, "kept");
});
test("launch, fork and resume reservations carry resolved cwd before dispatch", async () => {
	const f = fixture();
	const s = instance(f.source);
	await s.start();
	const snapshots: TreeEntry[] = [];
	const open = s.tmux.openWindow.bind(s.tmux);
	s.tmux.openWindow = async (spec, placement, companion) => {
		snapshots.push(...readTree(s.parent).entries.filter((item) => ["reserved", "dispatched"].includes(item.phase)));
		return open(spec, placement, companion);
	};
	const launched = await s.toolCall("delegate", { agent: "scout", task: "work", worktree: "launch" });
	const id: string = (launched.structuredContent as { id: string }).id;
	const record = readChildRecords(s.parent).find((item) => item.id === id);
	assert.ok(record && !("kind" in record));
	assert.equal(snapshots[0].cwd, record.cwd);
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(join(sessionDir, `date_${id}.jsonl`), `${JSON.stringify({ type: "session", id, cwd: record.cwd })}\n`);
	s.tmux.windows.clear();
	await s.toolCall("delegation_fork", { id, task: "fork", worktree: "forked" });
	assert.equal(snapshots[1].forkedFrom, id);
	assert.match(snapshots[1].cwd ?? "", /forked$/);
	s.tmux.windows.clear();
	await s.toolCall("delegation_resume", { id, task: "resume" });
	assert.equal(snapshots[2].cwd, record.cwd);
	assert.equal(snapshots[2].resumedFrom, id);
});

test("oldest registry groups precede newer direct children across descendant journals", async () => {
	const s = instance();
	await s.start();
	const coordinator: StartedRecorded = started(fixture(), s.parent, "coordinator");
	coordinator.workspace = { mode: "existing", cwd: root, git: { kind: "non-git" } };
	publish(s.parent, [coordinator]);
	const grandchild: StartedRecorded = started(fixture(), coordinator.id, "old-grandchild", s.parent);
	publish(coordinator.id, [grandchild]);
	const late: StartedRecorded = started(fixture(), s.parent, "new-direct");
	save(s.parent, [coordinator, late]);
	treeTransaction(s.parent, (state) => state.entries.push(entry(late)));
	const result: CleanupResult = await runCleanup({ all: true }, deps(s, { maxGroups: 1 }), context(s));
	assert.equal(result.items[0].id, grandchild.id);
	assert.deepEqual(result.selection?.omittedIds, [late.id]);
});
test("deadline omits all groups without mutation and own retained/dead finished registry entries are not live", async () => {
	const s = instance();
	await s.start();
	const f = fixture();
	const record: StartedRecorded = started(f, s.parent);
	publish(s.parent, [record]);
	const deadline: CleanupResult = await runCleanup({ all: true }, deps(s, { maxMs: 0 }), context(s));
	assert.deepEqual(deadline.selection?.omittedIds, ["child"]);
	assert.equal(existsSync(f.cwd), true);
	treeTransaction(s.parent, (state) => {
		const ownEntry: TreeEntry | undefined = state.entries.find((item) => item.id === record.id);
		assert.ok(ownEntry);
		ownEntry.phase = "not-started";
		const dead: TreeEntry = entry(started(f, s.parent, "dead-finished"));
		dead.finished = true;
		dead.ownerPid = 2147483647;
		state.entries.push(dead);
	});
	assert.equal((await invoke(s)).items[0].outcome, "removed");
});
