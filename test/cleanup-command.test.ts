import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PaseoWorkspace } from "@getpaseo/client";
import { type CleanupDeps, cleanupLiveCheck, discover } from "../src/cleanup.ts";
import { cleanupCommand, previewCleanup, removeConfirmedCleanup } from "../src/cleanup-command.ts";
import type { StartedRecorded } from "../src/result-types.ts";
import { windowLocator } from "../src/tmux.ts";
import { readTreeDisplay, treePath, treeTransaction } from "../src/tree-registry.ts";
import { commit, fixture, git } from "./cleanup-fixture.ts";
import {
	agentDir,
	agentFile,
	cleanup,
	resetRoot,
	root,
	session,
	sessionDir,
	type UiAnswers,
	writeAgent,
} from "./harness.ts";
import { FakePaseo } from "./paseo-fixture.ts";

type Session = ReturnType<typeof session>;
const sessions: Session[] = [];
beforeEach(() => {
	resetRoot();
	writeAgent("scout", agentFile({ model: "alpha/fast-model" }));
});
afterEach(async () => {
	for (const s of sessions.splice(0)) await s.shutdown();
});
after(cleanup);
async function setup(ui: UiAnswers = {}, hasUI = true) {
	const s = session({ ui, hasUI });
	sessions.push(s);
	await s.start();
	const f = fixture();
	const record: StartedRecorded = {
		id: "child",
		agent: "scout",
		model: "alpha/fast-model",
		thinking: "low",
		requestId: "request",
		cwd: f.cwd,
		workspace: f.workspace,
		sessionDir,
		identity: {
			parent: s.parent,
			root: s.parent,
			rootPlacement: "fixture-delegates",
			depth: 1,
			agent: "scout",
			chain: ["scout"],
			autoExit: true,
		},
		locator: windowLocator({ id: "@77", name: "scout-fixture" }),
		gone: true,
	};
	const publish = (records = [record]): void => {
		mkdirSync(join(agentDir, "squire", "child-tasks"), { recursive: true });
		writeFileSync(
			join(agentDir, "squire", "child-tasks", `${s.parent}.json`),
			JSON.stringify({ records, outcomes: [] }),
		);
	};
	publish();
	const api = new FakePaseo();
	const deps: CleanupDeps = {
		host: s.tmux,
		assertActive: () => {},
		gh: () => ({ ok: false, message: "gh absent" }),
		paseoApi: () => api,
	};
	const ctx = s.context as unknown as ExtensionContext;
	const run = () => cleanupCommand(deps, ctx);
	return { s, f, record, publish, api, deps, ctx, run };
}
test("already-clean Git with unavailable receipt reports Paseo unverified without offering confirmation", async () => {
	const { s, f, record, publish, api, deps, ctx, run } = await setup({ confirm: [true] });
	record.workspace = {
		...f.workspace,
		paseo: {
			home: "/fake-paseo",
			workspaceId: "workspace",
			projectId: "project",
			directory: f.cwd,
			provenance: "created",
		},
	};
	publish();
	git(f.source, "worktree", "remove", f.cwd);
	git(f.source, "branch", "-d", f.plan.branch);
	api.down = true;
	const items = await previewCleanup(deps, ctx);
	assert.equal(items[0].outcome.outcome, "kept");
	assert.equal(items[0].preview, undefined);
	assert.deepEqual(items[0].outcome.resources, { git: "already-clean", paseo: "unverified" });
	await run();
	assert.match(s.notes.join("\n"), /kept.*Git already-clean.*Paseo workspace unverified.*unavailable/);
	assert.equal(s.confirms.length, 0);
	api.down = false;
	assert.equal((await previewCleanup(deps, ctx))[0].outcome.outcome, "already-clean");
});
test("ambiguous receiptless daemon state is reported, never offered as safe or already-clean", async () => {
	const { s, f, api, run } = await setup({ confirm: [true] });
	api.availabilityState = { state: "ambiguous", reason: "Paseo authentication failed" };
	const check = untouched(f);
	await run();
	check();
	assert.equal(s.confirms.length, 0);
	assert.match(s.notes.join("\n"), /Paseo workspace unverified.*authentication failed/);
});
function untouched(f: ReturnType<typeof fixture>): () => void {
	const trees = git(f.source, "worktree", "list", "--porcelain");
	const branches = git(f.source, "show-ref", "--heads");
	return () => {
		assert.equal(existsSync(f.cwd), true);
		assert.equal(git(f.source, "worktree", "list", "--porcelain"), trees);
		assert.equal(git(f.source, "show-ref", "--heads"), branches);
	};
}
function foreign(api: FakePaseo, cwd: string): PaseoWorkspace {
	const workspace = {
		id: "foreign",
		projectId: "project",
		workspaceDirectory: cwd,
		archivingAt: null,
		scripts: [],
		name: "original",
		title: "User workspace",
		createdAt: "2026-01-01T00:00:00Z",
	} as unknown as PaseoWorkspace;
	api.workspaces.set(workspace.id, workspace);
	return workspace;
}
function gone(f: ReturnType<typeof fixture>): void {
	commit(f.cwd);
	git(f.source, "remote", "add", "origin", "https://example.invalid/repo");
	git(f.source, "update-ref", "refs/remotes/origin/topic", "HEAD");
	git(f.cwd, "branch", "--set-upstream-to=origin/topic");
	git(f.source, "update-ref", "-d", "refs/remotes/origin/topic");
}
const unmergedLabel = "child — topic; unmerged";
const foreignLabel = "child — topic; foreign Paseo workspace";

test("registered /delegate-cleanup refuses no-UI before proof or mutations; no model message/turn", async (t) => {
	let stderr = "";
	t.mock.method(process.stderr, "write", (chunk: string) => {
		stderr += chunk;
		return true;
	});
	const { s, f, api, deps, run } = await setup({ confirm: [true] }, false);
	const check = untouched(f);
	deps.assertActive = () => assert.fail("no-UI must refuse before proving");
	await run();
	await s.command("delegate-cleanup");
	assert.ok(s.commands().includes("delegate-cleanup"));
	assert.match(stderr, /needs an interactive session/);
	assert.deepEqual(s.warnings, []);
	assert.equal(s.confirms.length, 0);
	assert.equal(s.selects.length, 0);
	assert.deepEqual(api.calls, []);
	check();
	assert.deepEqual(s.sent, []);
	assert.deepEqual(s.userMessages, []);
});
test("unreadable registries fail closed with zero mutations and explicit notification", async () => {
	for (const which of ["caller", "other"]) {
		const { s, f, api, run } = await setup({ confirm: [true] });
		foreign(api, f.cwd);
		const check = untouched(f);
		mkdirSync(join(agentDir, "squire", "trees"), { recursive: true });
		writeFileSync(treePath(which === "caller" ? s.parent : "other-root"), "{broken");
		await run();
		assert.equal(s.confirms.length, 0);
		assert.equal(s.selects.length, 0);
		assert.equal(api.calls.includes("archiveWorkspace"), false);
		assert.match([...s.errors, ...s.notes].join("\n"), which === "caller" ? /nothing removed/ : /kept/);
		check();
		// Keep the next subcase independent, including its root's shutdown.
		await s.shutdown();
		resetRoot();
	}
});

test("confirm 1 decline leaves Git and created Paseo workspace unchanged; preview never archives", async () => {
	const { s, f, api, run, record, publish } = await setup({ confirm: [false] });
	record.workspace = {
		...f.workspace,
		paseo: { home: "/fake", workspaceId: "foreign", directory: f.cwd, projectId: "project", provenance: "created" },
	};
	publish();
	foreign(api, f.cwd);
	const check = untouched(f);
	await run();
	assert.equal(s.confirms[0].title, "Remove 1 proven-safe items?");
	assert.equal(s.confirms[0].timeout, 60000);
	assert.equal(s.selects.length, 0);
	assert.equal(api.calls.includes("archiveWorkspace"), false);
	check();
});
test("proven items removed on confirm 1, ignored count shown, no model messages or turns", async () => {
	const { s, f, run } = await setup({ confirm: [true] });
	mkdirSync(join(f.cwd, "node_modules"));
	writeFileSync(join(f.cwd, "node_modules", "ignored"), "delete");
	await run();
	assert.equal(s.confirms.length, 1);
	assert.match(s.confirms[0].message, /ignored entries deleted: 1/);
	assert.ok(s.confirms[0].message.includes(f.cwd));
	assert.match(s.confirms[0].message, /refs\/heads\/topic/);
	assert.equal(s.confirms[0].timeout, 60000);
	assert.equal(existsSync(f.cwd), false);
	assert.equal(git(f.source, "branch", "--list", "topic"), "");
	assert.match(s.notes.join("\n"), /removed.*1 ignored entries removed/);
	assert.deepEqual(s.sent, []);
	assert.deepEqual(s.userMessages, []);
});
test("[gone] has only confirm 2, never confirm 1; decline keeps and yes removes without fetching", async () => {
	for (const yes of [false, true]) {
		const { s, f, run, deps } = await setup({ confirm: [yes] });
		gone(f);
		const check = untouched(f);
		const calls: string[][] = [];
		const { askGit } = await import("../src/git.ts");
		deps.git = (cwd, args, options) => {
			calls.push(args);
			return askGit(cwd, args, options);
		};
		await run();
		assert.equal(s.confirms.length, 1);
		assert.match(s.confirms[0].title, /upstream branch was deleted.*Merge is not proved/);
		assert.match(s.confirms[0].message, /refs\/remotes\/origin\/topic \[gone\]; unique commits: 1/);
		assert.equal(s.confirms[0].timeout, 60000);
		assert.equal(s.selects.length, 0);
		if (yes) assert.equal(existsSync(f.cwd), false);
		else check();
		assert.ok(calls.every((args) => !args.includes("--force") && !args.includes("fetch")));
	}
});
test("unmerged discard is per-item select + confirm; CAS deletes only the confirmed local tip", async () => {
	const { s, f, run, deps } = await setup({ select: [unmergedLabel], confirm: [true] });
	const tip = commit(f.cwd);
	git(f.source, "update-ref", "refs/remotes/origin/keep", tip);
	const calls: string[][] = [];
	const { askGit } = await import("../src/git.ts");
	deps.git = (cwd, args, options) => {
		calls.push(args);
		return askGit(cwd, args, options);
	};
	await run();
	assert.deepEqual(s.selects[0].options, [unmergedLabel, "Done"]);
	assert.equal(s.selects[0].timeout, 60000);
	assert.equal(s.confirms.length, 1);
	assert.equal(s.confirms[0].timeout, 60000);
	assert.ok(s.confirms[0].message.includes(tip));
	assert.match(s.confirms[0].message, /unique commits: 1 vs refs\/heads\/main/);
	assert.match(s.confirms[0].message, /Unique commits.*may be lost/);
	assert.deepEqual(calls, [
		["worktree", "remove", f.cwd],
		["update-ref", "--no-deref", "-d", "refs/heads/topic", tip],
	]);
	assert.equal(git(f.source, "rev-parse", "refs/remotes/origin/keep"), tip);
	assert.equal(git(f.source, "branch", "--list", "topic"), "");
});
test("path-found workspace never enters confirm 1; D3 confirms exactly one foreign id with schedule warning", async () => {
	const { s, f, api, run } = await setup({ select: [foreignLabel], confirm: [true] });
	foreign(api, f.cwd);
	await run();
	assert.deepEqual(s.selects[0].options, [foreignLabel, "Done"]);
	assert.equal(s.confirms.length, 1);
	assert.equal(s.confirms[0].title, "Discard this worktree and local branch?");
	assert.match(s.confirms[0].message, /Paseo workspace: foreign; title: User workspace; created: 2026-01-01/);
	assert.match(s.confirms[0].message, /Squire did not create this workspace/);
	assert.match(s.confirms[0].message, /schedule.*fails on its next run/);
	assert.equal(s.selects[0].timeout, 60000);
	assert.equal(s.confirms[0].timeout, 60000);
	assert.equal(api.calls.filter((call) => call === "archiveWorkspace").length, 1);
	assert.equal(api.workspaces.size, 0);
	assert.equal(existsSync(f.cwd), false);
});
test("volatile workspace observations changing at yes still allow D3 and created-workspace confirm 1", async (t) => {
	for (const provenance of ["foreign", "created"]) {
		await t.test(provenance, async () => {
			const { s, f, api, run, record, publish, ctx } = await setup({
				select: [foreignLabel],
				confirm: [true],
			});
			const workspace = foreign(api, f.cwd);
			workspace.scripts = [
				{ scriptName: "build", lifecycle: "stopped", health: "healthy" },
			] as PaseoWorkspace["scripts"];
			if (provenance === "created") {
				record.workspace = {
					...f.workspace,
					paseo: { home: "/fake", workspaceId: workspace.id, directory: f.cwd, projectId: "project", provenance },
				};
				publish();
			}
			const original = ctx.ui.confirm.bind(ctx.ui);
			ctx.ui.confirm = async (...args) => {
				const yes = await original(...args);
				// Replace the descriptor as a real daemon response would; never mutate the preview.
				api.workspaces.set(workspace.id, {
					...workspace,
					activityAt: "2026-02-01T00:00:00Z",
					status: "running",
					statusEnteredAt: "2026-02-01T00:00:00Z",
					diffStat: { additions: 1, deletions: 2 },
					gitRuntime: { aheadBehind: { ahead: 1, behind: 0 } },
					githubRuntime: {
						refreshedAt: "2026-02-01T00:00:00Z",
						pullRequest: {
							url: "https://example.invalid/pr/1",
							state: "open",
							title: "refreshed",
							baseRefName: "main",
							headRefName: "topic",
							isMerged: false,
							checks: [{ name: "check", status: "success", url: null }],
						},
					},
					scripts: workspace.scripts.map((script) => ({ ...script, health: "unhealthy" })),
				});
				return yes;
			};
			await run();
			assert.equal(s.selects.length, provenance === "foreign" ? 1 : 0);
			assert.equal(s.confirms.length, 1);
			assert.equal(
				s.confirms[0].title,
				provenance === "foreign" ? "Discard this worktree and local branch?" : "Remove 1 proven-safe items?",
			);
			assert.equal(api.workspaces.size, 0, s.notes.join("\n"));
			assert.equal(existsSync(f.cwd), false);
		});
	}
});
test("stable workspace name and script identity changes at yes abort D3 and confirm 1", async (t) => {
	for (const provenance of ["foreign", "created"]) {
		for (const change of ["name", "scriptName"]) {
			await t.test(`${provenance}: ${change}`, async () => {
				const { f, api, run, record, publish, ctx, s } = await setup({ select: [foreignLabel], confirm: [true] });
				const workspace = foreign(api, f.cwd);
				workspace.scripts = [{ scriptName: "build", lifecycle: "stopped" }] as PaseoWorkspace["scripts"];
				if (provenance === "created") {
					record.workspace = {
						...f.workspace,
						paseo: {
							home: "/fake",
							workspaceId: workspace.id,
							directory: f.cwd,
							projectId: "project",
							provenance,
						},
					};
					publish();
				}
				const original = ctx.ui.confirm.bind(ctx.ui);
				ctx.ui.confirm = async (...args) => {
					const yes = await original(...args);
					if (change === "name") workspace.name = "renamed";
					else workspace.scripts[0].scriptName = "different";
					return yes;
				};
				const check = untouched(f);
				await run();
				assert.equal(api.calls.includes("archiveWorkspace"), false);
				assert.match(s.notes.join("\n"), /changed since you confirmed; nothing removed/);
				check();
			});
		}
	}
});
test("cleanup live check reads registries without taking the tree lock", async () => {
	const { s, ctx } = await setup();
	const group = discover(readTreeDisplay(s.parent), s.parent).groups[0];
	const lock = `${treePath(s.parent)}.lock`;
	mkdirSync(lock, { recursive: true });
	// Any lock admission would parse this ticket and fail; display reads must ignore it.
	writeFileSync(join(lock, "blocked.json"), "{unreadable ticket");
	const before = readdirSync(lock);
	try {
		assert.doesNotThrow(() => cleanupLiveCheck(group, s.parent, ctx, new Map()));
		assert.deepEqual(readdirSync(lock), before);
	} finally {
		unlinkSync(join(lock, "blocked.json"));
	}
});
test("[gone] plus a foreign workspace uses the per-item selector, never confirm 2", async () => {
	const { s, f, api, run } = await setup({ select: [foreignLabel], confirm: [false] });
	gone(f);
	foreign(api, f.cwd);
	const check = untouched(f);
	await run();
	assert.deepEqual(s.selects[0].options, [foreignLabel, "Done"]);
	assert.equal(s.confirms.length, 1);
	assert.equal(s.confirms[0].title, "Discard this worktree and local branch?");
	assert.match(s.confirms[0].message, /\[gone\]; unique commits: 1/);
	assert.match(s.confirms[0].message, /Squire did not create this workspace/);
	assert.equal(api.calls.includes("archiveWorkspace"), false);
	check();
});
test("D3 confirmation lists every archived workspace id, including created workspaces across homes", async () => {
	const { s, f, api, deps, run, record, publish } = await setup({
		select: ["child, alias — topic; foreign Paseo workspace"],
		confirm: [true],
	});
	const workspace = foreign(api, f.cwd);
	api.workspaces.set("created-here", { ...workspace, id: "created-here" });
	const other = new FakePaseo();
	other.workspaces.set("created-elsewhere", { ...workspace, id: "created-elsewhere" });
	record.workspace = {
		...f.workspace,
		paseo: {
			home: "/fake",
			workspaceId: "created-here",
			directory: f.cwd,
			projectId: "project",
			provenance: "created",
		},
	};
	publish([
		record,
		{
			...record,
			id: "alias",
			workspace: {
				...f.workspace,
				paseo: {
					home: "/other",
					workspaceId: "created-elsewhere",
					directory: f.cwd,
					projectId: "project",
					provenance: "created",
				},
			},
		},
	]);
	deps.paseoApi = (home) => {
		assert.ok(home === "/fake" || home === "/other");
		return home === "/fake" ? api : other;
	};
	await run();
	assert.equal(s.confirms.length, 1);
	assert.equal(s.confirms[0].title, "Discard this worktree and local branch?");
	assert.match(
		s.confirms[0].message,
		/workspaces to archive: .*created-here \(home: \/fake\).*foreign \(home: \/fake\).*created-elsewhere \(home: \/other\)/,
	);
	assert.equal(api.calls.filter((call) => call === "archiveWorkspace").length, 2);
	assert.equal(other.calls.filter((call) => call === "archiveWorkspace").length, 1);
	assert.equal(api.workspaces.size + other.workspaces.size, 0);
	assert.equal(existsSync(f.cwd), false);
});
test("overrides offered only when every blocker is D2/D3", async (t) => {
	for (const blocker of [
		"untracked",
		"locked",
		"pending",
		"window",
		"agent",
		"terminal",
		"internal",
		"archiving",
		"setup",
		"script",
		"paseo-owned",
		"workspace identity",
		"multiple",
	]) {
		await t.test(blocker, async () => {
			const { s, f, api, run, record } = await setup({ select: [foreignLabel], confirm: [true] });
			commit(f.cwd);
			const workspace = foreign(api, f.cwd);
			if (blocker === "untracked") writeFileSync(join(f.cwd, "new"), "keep");
			if (blocker === "locked") git(f.source, "worktree", "lock", f.cwd);
			if (blocker === "pending") {
				assert.ok(record.identity);
				treeTransaction(s.parent, (state) =>
					state.entries.push({
						id: "pending",
						sessionId: "pending",
						identity: record.identity!,
						ownerPid: process.pid,
						phase: "reserved",
						cwd: f.cwd,
					}),
				);
			}
			if (blocker === "window") s.tmux.windows.set("@77", { name: "scout-fixture", exited: false, session: "work" });
			if (blocker === "agent") api.agents.push({ id: "user", workspaceId: "foreign", cwd: root });
			if (blocker === "terminal") api.terminals.push({ id: "term", workspaceId: "other", cwd: join(f.cwd, "nested") });
			if (blocker === "internal") workspace.internal = true;
			if (blocker === "archiving") workspace.archivingAt = "now";
			if (blocker === "setup") workspace.setupStatus = "running";
			if (blocker === "script") workspace.scripts = [{ lifecycle: "running" }] as PaseoWorkspace["scripts"];
			if (blocker === "paseo-owned")
				workspace.gitRuntime = { isPaseoOwnedWorktree: true } as NonNullable<PaseoWorkspace["gitRuntime"]>;
			if (blocker === "multiple") api.workspaces.set("second", { ...workspace, id: "second" });
			if (blocker === "workspace identity") api.workspace = async () => ({ ...workspace, id: "different" });
			const check = untouched(f);
			await run();
			assert.equal(s.confirms.length, 0, s.errors.join("\n"));
			assert.equal(s.selects.length, 0);
			assert.equal(api.calls.includes("archiveWorkspace"), false);
			assert.match(s.notes.join("\n"), /kept/, s.errors.join("\n"));
			check();
		});
	}
});
test("override decline and Escape at selection or confirmation keep; no yes-to-all", async () => {
	for (const mode of ["decline", "select Escape", "confirm Escape"]) {
		const { s, f, run } = await setup({
			select: [mode === "select Escape" ? undefined : unmergedLabel],
			confirm: [false],
		});
		commit(f.cwd);
		const check = untouched(f);
		await run();
		assert.equal(s.confirms.length, mode === "select Escape" ? 0 : 1);
		assert.equal(s.selects.length, 1);
		assert.ok(!s.selects[0].options.some((option) => /all/i.test(option)));
		check();
	}
});
test("confirm and select timeout after 60000 keep (Pi cancellation values)", async (t) => {
	for (const kind of ["confirm", "select"]) {
		const never = new Promise<never>(() => {});
		const { s, f, run } = await setup(kind === "confirm" ? { confirm: [never] } : { select: [never] });
		if (kind === "select") commit(f.cwd);
		const check = untouched(f);
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const running = run();
		for (let n = 0; n < 100; n++) await Promise.resolve();
		assert.equal(kind === "confirm" ? s.confirms.length : s.selects.length, 1);
		t.mock.timers.tick(60000);
		await running;
		t.mock.timers.reset();
		assert.match(s.notes.join("\n"), /kept/);
		check();
	}
});
test("tip, tracking, workspace id/descriptor, and cleanliness changes after yes abort before any mutation", async (t) => {
	for (const change of [
		"tip",
		"track",
		"upstream name",
		"workspace id",
		"workspace title",
		"workspace users",
		"registry",
		"untracked",
		"ignored nested repository",
	]) {
		await t.test(change, async () => {
			const { s, f, run, ctx, api } = await setup({ select: [foreignLabel], confirm: [true] });
			foreign(api, f.cwd);
			if (change === "track") gone(f);
			const original = ctx.ui.confirm.bind(ctx.ui);
			ctx.ui.confirm = async (...args) => {
				const yes = await original(...args);
				if (change === "tip") commit(f.cwd);
				if (change === "track") git(f.source, "update-ref", "refs/remotes/origin/topic", "topic");
				if (change === "upstream name") {
					git(f.source, "remote", "add", "origin", "https://example.invalid/repo");
					git(f.source, "update-ref", "refs/remotes/origin/topic", "HEAD");
					git(f.cwd, "branch", "--set-upstream-to=origin/topic");
				}
				if (change === "workspace id") {
					api.workspaces.clear();
					api.workspaces.set("new-id", { ...foreign(api, f.cwd), id: "new-id" });
					api.workspaces.delete("foreign");
				}
				if (change === "workspace title") api.workspaces.get("foreign")!.title = "changed";
				if (change === "workspace users") api.agents.push({ id: "late", workspaceId: "foreign", cwd: root });
				if (change === "registry") writeFileSync(treePath(s.parent), "{changed");
				if (change === "untracked") writeFileSync(join(f.cwd, "late"), "keep");
				if (change === "ignored nested repository")
					mkdirSync(join(f.cwd, "scratch", "repo", ".git"), { recursive: true });
				return yes;
			};
			await run();
			assert.equal(existsSync(f.cwd), true);
			assert.ok(git(f.source, "branch", "--list", "topic"));
			assert.equal(api.calls.includes("archiveWorkspace"), false);
			assert.match(s.notes.join("\n"), /changed since you confirmed; nothing removed/);
		});
	}
});
test("changes after an actual archive report partial, never promise nothing removed", async () => {
	const { f, api, deps, ctx } = await setup();
	foreign(api, f.cwd);
	const preview = (await previewCleanup(deps, ctx))[0].preview;
	assert.ok(preview);
	api.afterArchive = () => commit(f.cwd, "late after archive");
	const result = await removeConfirmedCleanup(preview, deps, ctx);
	assert.equal(result.outcome, "partial");
	assert.match(result.reason, /changed after archive; Git cleanup skipped/);
	assert.doesNotMatch(result.reason, /nothing removed/);
	assert.equal(api.workspaces.size, 0);
	assert.equal(existsSync(f.cwd), true);
	assert.ok(git(f.source, "branch", "--list", "topic"));
});

test("full proof repeats after async Paseo listing and at the final synchronous boundary; CAS refuses late tip", async (t) => {
	for (const change of ["during Paseo", "before remove", "after remove"]) {
		await t.test(change, async () => {
			const { s, f, ctx, deps, api } = await setup();
			commit(f.cwd);
			const preview = (await previewCleanup(deps, ctx))[0].preview;
			assert.ok(preview);
			if (change === "during Paseo") {
				const at = api.workspaceAt.bind(api);
				api.workspaceAt = async (dir) => {
					commit(f.cwd, "late tip");
					return at(dir);
				};
			}
			if (change === "before remove") deps.beforeRemove = () => commit(f.cwd, "late tip");
			if (change === "after remove") deps.afterRemove = () => git(f.source, "update-ref", "refs/heads/topic", "main");
			const result = await removeConfirmedCleanup(preview, deps, ctx);
			assert.equal(result.outcome, change === "after remove" ? "partial" : "kept", result.reason);
			assert.ok(git(f.source, "branch", "--list", "topic"));
			if (change !== "after remove") assert.equal(existsSync(f.cwd), true);
			assert.deepEqual(s.sent, []);
		});
	}
});
