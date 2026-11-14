import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readChildRecords } from "../src/child-tasks.ts";
import { type CleanupDeps, type CleanupResult, cleanupText, cleanup as runCleanup } from "../src/cleanup.ts";
import { type Identity, writeIdentity } from "../src/identity.ts";
import type { Recorded, StartedRecorded, WorkspaceAttempt } from "../src/result-types.ts";
import { windowLocator } from "../src/tmux.ts";
import { readTree, type TreeEntry, treePath, treeTransaction } from "../src/tree-registry.ts";
import { fixture, git } from "./cleanup-fixture.ts";
import { agentDir, agentFile, cleanup, resetRoot, root, session, sessionDir, writeAgent } from "./harness.ts";

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
		gone: true,
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
test("running windows and Paseo locators keep without Git mutations", async () => {
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
	assert.equal((await invoke(s)).items[0].reason, "Paseo workspace not recorded");
	assert.equal(existsSync(f.cwd), true);
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
