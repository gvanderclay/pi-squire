// Original-root companion preference through real-provider/Git fixtures and
// actual coordinator process death/reopen. No model or live tmux/mail resources.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { devNull } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { readChildRecords } from "../src/child-tasks.ts";
import { readIdentity } from "../src/identity.ts";
import { type Delegation, isStarted } from "../src/results.ts";
import { sessionIsOwned } from "../src/session-owner.ts";
import type { TmuxWindow, WindowSpec } from "../src/tmux.ts";
import { readTree, treeCounts, treePath } from "../src/tree-registry.ts";
import { assertRootPlacement } from "../src/window-placement.ts";
import { FakeTmux } from "./fake-tmux.ts";
import {
	agentDir,
	agentFile,
	cleanup,
	resetRoot,
	root,
	type SessionOptions,
	sessionDir,
	writeAgent,
} from "./harness.ts";
import { envelopes, mailSession, scan } from "./mail-harness.ts";
import { TreeProcess } from "./tree-process-harness.ts";

type Session = ReturnType<typeof mailSession>;
type Server = { windows: TmuxWindow[]; companions: string[]; parentSession: string };
type ProcessSnapshot = Server & {
	identity: NonNullable<ReturnType<typeof readIdentity>>;
	opened: (WindowSpec & { windowId: string; session: string })[];
	killed: string[];
	selects: unknown[];
	delegateEnv: string[];
	prompts: string[];
	entries: { data: Delegation }[];
	result: { structuredContent: { id: string; windowId: string; windowSession: string; resumedFrom?: string } };
};
const active: Session[] = [];
const processes: TreeProcess[] = [];
let sequence = 0;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = devNull;

function settings(windowPlacement = "companion"): void {
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(join(agentDir, "squire", "settings.json"), JSON.stringify({ maxDepth: 2, windowPlacement }));
}
beforeEach(() => {
	resetRoot();
	settings();
	writeAgent(
		"coordinator",
		agentFile({
			model: "alpha/fast-model",
			allow_nested_delegation: "[worker]",
			tools: "read",
			auto_exit: "false",
		}),
	);
	writeAgent("worker", agentFile({ model: "alpha/fast-model", tools: "read,write", auto_exit: "false" }));
});
afterEach(async () => {
	for (const s of active.splice(0).reverse()) await s.shutdown();
	for (const p of processes.splice(0)) await p.kill();
});
after(cleanup);

function directory(name: string): string {
	const cwd = join(root, `case-${++sequence}`, name);
	mkdirSync(cwd, { recursive: true });
	return realpathSync(cwd);
}
function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@example.invalid",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@example.invalid",
		},
	}).trim();
}
function repository(name: string): string {
	const cwd = directory(name);
	git(cwd, "init", "-q", "-b", "main");
	git(cwd, "commit", "--allow-empty", "-qm", "initial");
	return cwd;
}
function resolvedProject(name: string, decision: boolean): string {
	const cwd = repository(name);
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(join(cwd, ".pi", "settings.json"), "{}");
	new ProjectTrustStore(agentDir).set(cwd, decision);
	return cwd;
}
async function instance(options: SessionOptions = {}): Promise<Session> {
	const s = mailSession(options);
	active.push(s);
	await s.start();
	return s;
}
async function launch(
	s: Session,
	agent: string,
	extra: Record<string, unknown> = {},
): Promise<Delegation & { windowSession: string }> {
	const result = await s.toolCall("delegate", { agent, task: "work", ...extra });
	const details = result.details as { id: string; windowSession: string };
	const record = s.entries.findLast(({ data }) => data.id === details.id)!.data as Delegation;
	return { ...record, windowSession: details.windowSession };
}
async function coordinator(cwd: string, b: string, tmux = new FakeTmux()) {
	const owner = await instance({ cwd, tmux });
	const c = await launch(owner, "coordinator", { cwd: b });
	const child = await instance({
		parent: c.id,
		cwd: b,
		tmux,
		activeTools: ["read", "delegate", "delegation_status", "delegation_close", "delegation_resume"],
	});
	scan(child);
	return { owner, child, c, tmux };
}
function header(record: Delegation): void {
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(
		join(sessionDir, `date_${record.id}.jsonl`),
		`${JSON.stringify({ type: "session", version: 3, id: record.id, cwd: record.cwd })}\n`,
	);
}
const identityFile = (id: string): string => join(agentDir, "squire", "identity", `${id}.json`);
const finals = (s: Session) =>
	[...envelopes(s.parent, "new"), ...envelopes(s.parent, "cur")].filter((mail) => mail.in_reply_to.length > 0);

test("Git A main/subdirectory/linked root → B → C uses A and keeps independent trust/tool/registry facts", async () => {
	const a = repository("A.project");
	const sub = join(a, "src");
	mkdirSync(sub);
	const linked = join(directory("linked-parent"), "different-leaf");
	git(a, "worktree", "add", "-qb", "root-feature", linked);
	const b = resolvedProject("B", false),
		c = resolvedProject("C", true);
	const tmux = new FakeTmux();
	for (const cwd of [a, sub, linked]) {
		const { owner, child, c: parent } = await coordinator(cwd, b, tmux);
		const worker = await launch(child, "worker", { cwd: c });
		const preferred = "A-project-delegate-session";
		assert.equal(parent.windowSession, preferred);
		assert.equal(worker.windowSession, preferred);
		assert.equal(parent.cwd, b);
		assert.equal(worker.cwd, c);
		assert.equal(readIdentity(worker.id)?.rootPlacement, preferred);
		assert.equal(readIdentity(worker.id)?.root, owner.parent);
		assert.deepEqual(readIdentity(worker.id)?.chain, ["coordinator", "worker"]);
		const state = readTree(owner.parent);
		assert.deepEqual(
			state.entries.map((entry) => entry.identity.rootPlacement),
			[preferred, preferred],
		);
		assert.equal(state.entries[1].launch?.identity?.rootPlacement, preferred);
		assert.deepEqual(treeCounts(state), { concurrent: 2, lifetime: 2 });
		assert.ok(tmux.opened.at(-2)!.argv.includes("--no-approve"));
		assert.ok(tmux.opened.at(-1)!.argv.includes("--approve"));
		assert.equal(tmux.opened.at(-1)!.argv[tmux.opened.at(-1)!.argv.lastIndexOf("--tools") + 1], "read,mcp__");
		assert.deepEqual(child.selects, []);
		assert.equal(owner.sent.filter(({ message }) => message.customType === "delegate").length, 0);
	}
});

test("closed subtree resumes in original root preference with placement consistency, current trust and cap checks", async () => {
	const a = repository("CloseRoot"),
		b = resolvedProject("CloseB", false),
		c = resolvedProject("CloseC", true);
	const preferred = "CloseRoot-delegate-session";
	const selected = `${preferred}-2`;
	const tmux = new FakeTmux();
	tmux.addWindow("@user", "unmarked", preferred);
	const { owner, child, c: coordinatorRecord } = await coordinator(a, b, tmux);
	const worker = await launch(child, "worker", { cwd: c });
	header(coordinatorRecord);
	header(worker);
	tmux.addWindow("@anchor", "other-tree", selected);
	const closed = await owner.toolCall("delegation_close", { id: coordinatorRecord.id });
	assert.equal((closed.details as { complete: boolean }).complete, true);
	assert.equal(tmux.windows.has("@anchor"), true);
	for (const entry of readTree(owner.parent).entries) {
		assert.equal(entry.closed, true);
		assert.equal(entry.identity.rootPlacement, preferred);
		assert.equal(entry.launch?.identity?.rootPlacement, preferred);
	}
	assert.equal(readChildRecords(owner.parent).filter(isStarted)[0].identity?.rootPlacement, preferred);
	await child.shutdown();
	await owner.shutdown();
	tmux.windows.delete("@user");
	tmux.parentSession = "different-root-pane";
	const reopenedRoot = await instance({ parent: owner.parent, cwd: directory("DifferentRoot"), tmux });
	const original = readIdentity(coordinatorRecord.id)!;
	writeFileSync(
		identityFile(coordinatorRecord.id),
		JSON.stringify({ ...original, rootPlacement: "wrong-delegate-session" }),
	);
	rmSync(join(agentDir, "trust.json"), { force: true });
	await assert.rejects(
		reopenedRoot.toolCall("delegation_resume", { id: coordinatorRecord.id, task: "blocked" }),
		/conflicting/,
	);
	assert.deepEqual(reopenedRoot.selects, [], "post-close placement conflict refuses before unresolved trust");
	assert.equal(existsSync(join(agentDir, "trust.json")), false);
	assert.deepEqual(treeCounts(readTree(owner.parent)), { concurrent: 0, lifetime: 2 });
	writeFileSync(identityFile(coordinatorRecord.id), JSON.stringify(original));
	new ProjectTrustStore(agentDir).set(b, true);
	const resumedC = await reopenedRoot.toolCall("delegation_resume", {
		id: coordinatorRecord.id,
		task: "continue coordinator",
	});
	assert.equal((resumedC.details as { windowSession: string }).windowSession, selected);
	assert.ok(tmux.opened.at(-1)!.argv.includes("--approve"), "resume re-resolves B's changed trust");
	const restored = await instance({
		parent: child.parent,
		cwd: b,
		tmux,
		entries: [],
		activeTools: ["read", "delegate", "delegation_status", "delegation_close", "delegation_resume"],
	});
	scan(restored);
	assert.equal(
		readChildRecords(child.parent)
			.filter(isStarted)
			.find((record) => record.id === worker.id)?.closed,
		true,
	);
	assert.equal(
		readChildRecords(child.parent)
			.filter(isStarted)
			.find((record) => record.id === worker.id)?.identity?.rootPlacement,
		preferred,
	);
	assert.equal(readIdentity(child.parent)?.rootPlacement, preferred);
	settings();
	writeFileSync(join(agentDir, "squire", "settings.json"), JSON.stringify({ maxDepth: 2, maxConcurrentDelegates: 1 }));
	const opens = tmux.opened.length,
		kills = tmux.killed.length;
	await assert.rejects(
		restored.toolCall("delegation_resume", { id: worker.id, task: "cap blocked" }),
		/maxConcurrentDelegates/,
	);
	assert.equal(tmux.opened.length, opens);
	assert.equal(tmux.killed.length, kills);
	assert.deepEqual(reopenedRoot.selects, [], "cap refusal precedes unresolved C trust");
	writeFileSync(join(agentDir, "squire", "settings.json"), JSON.stringify({ maxDepth: 2, maxConcurrentDelegates: 2 }));
	new ProjectTrustStore(agentDir).set(c, false);
	const resumedW = await restored.toolCall("delegation_resume", { id: worker.id, task: "continue worker" });
	assert.equal((resumedW.details as { windowSession: string }).windowSession, selected);
	assert.ok(tmux.opened.at(-1)!.argv.includes("--no-approve"), "resume re-resolves C's changed trust");
	assert.equal(tmux.opened.at(-1)!.argv[tmux.opened.at(-1)!.argv.lastIndexOf("--tools") + 1], "read,mcp__");
	assert.equal(readIdentity(worker.id)?.rootPlacement, preferred);
	assert.deepEqual(treeCounts(readTree(owner.parent)), { concurrent: 2, lifetime: 4 });
	for (const entry of readTree(owner.parent).entries) assert.equal(entry.identity.rootPlacement, preferred);
	assert.equal(tmux.windows.has("@anchor"), true);
});

test("C worktree_source and root-absent coordinator reopen inherit A without launch env or transcript", async () => {
	const a = repository("A"),
		b = resolvedProject("B", false),
		c = resolvedProject("C", true);
	const { owner, child, tmux } = await coordinator(a, b);
	const first = await launch(child, "worker", { worktree: "placement/topic", worktree_source: c });
	assert.equal(first.windowSession, "A-delegate-session");
	assert.equal(first.workspace?.mode, "managed");
	assert.notEqual(first.cwd, c);
	await owner.shutdown();
	await child.shutdown();
	assert.equal(sessionIsOwned(owner.parent), false);
	const reopened = await instance({ parent: child.parent, cwd: b, tmux, entries: [] });
	assert.deepEqual(reopened.entries, []);
	assert.equal(reopened.pi.getActiveTools().includes("delegate"), true);
	const second = await launch(reopened, "worker", { cwd: c });
	assert.equal(second.windowSession, first.windowSession);
	assert.equal(second.identity?.rootPlacement, first.identity?.rootPlacement);
	assert.equal(tmux.opened.length, 3, "reopen did not recreate its existing worker");
	assert.deepEqual(tmux.killed, []);
	assert.deepEqual(reopened.selects, []);
	await reopened.run();
	assert.equal(finals(owner).length, 0, "unfinished children still hold the coordinator barrier");
});

test("nested opens and direct-parent resume retain marked alternatives without adopting freed/unmarked names", async () => {
	const a = repository("same"),
		b = resolvedProject("B", false),
		c = resolvedProject("C", true);
	const tmux = new FakeTmux();
	tmux.addWindow("@100", "user-base", "same-delegate-session");
	tmux.addWindow("@101", "user-numbered", "same-delegate-session-2");
	const { owner, child } = await coordinator(a, b, tmux);
	tmux.windows.delete("@100");
	const w = await launch(child, "worker", { cwd: c });
	assert.equal(w.windowSession, "same-delegate-session-3");
	assert.equal(w.identity?.rootPlacement, "same-delegate-session", "save preference, not selected alternative");
	header(w);
	tmux.exit(w.windowId);
	await assert.rejects(owner.toolCall("delegation_resume", { id: w.id, task: "not owner" }), /only direct parent/);
	await owner.shutdown();
	const resumed = await child.toolCall("delegation_resume", { id: w.id, task: "continue" });
	assert.equal((resumed.details as { windowSession: string }).windowSession, "same-delegate-session-3");
	assert.equal(tmux.windows.get("@101")?.name, "user-numbered");
	assert.equal(tmux.detachOnDestroy.has("same-delegate-session-2"), false);
	assert.deepEqual(tmux.killed, [w.windowId]);
});

test("call-time current vs companion selection is independent of persisted original-root project", async () => {
	settings("current");
	const a = repository("A"),
		b = resolvedProject("B", false),
		c = resolvedProject("C", true);
	const { child, tmux } = await coordinator(a, b);
	assert.equal(tmux.opened[0].session, "work");
	assert.equal(readIdentity(child.parent)?.rootPlacement, "A-delegate-session");
	tmux.parentSession = "coordinator-pane";
	settings();
	const off = child.events.on("session:launch", () => settings("current"));
	const w = await launch(child, "worker", { cwd: c });
	off();
	assert.equal(w.windowSession, "A-delegate-session", "mode is read once before hook changes");
	header(w);
	tmux.exit(w.windowId);
	await child.toolCall("delegation_resume", { id: w.id, task: "current now" });
	assert.equal(tmux.opened.at(-1)!.session, "coordinator-pane");
	assert.equal(readIdentity(w.id)?.rootPlacement, "A-delegate-session");
});

test("root same-id reopen resumes B coordinator with its original preference before it launches C", async () => {
	const a = repository("A"),
		b = resolvedProject("B", false),
		c = resolvedProject("C", true);
	const { owner, child, c: record, tmux } = await coordinator(a, b);
	header(record);
	await child.shutdown();
	tmux.exit(record.windowId);
	await owner.shutdown();
	tmux.parentSession = "unrelated-root-reopen-pane";
	const reopened = await instance({ parent: owner.parent, cwd: a, tmux, entries: [] });
	const result = await reopened.toolCall("delegation_resume", { id: record.id, task: "coordinate again" });
	assert.equal((result.details as { windowSession: string }).windowSession, "A-delegate-session");
	const again = await instance({ parent: child.parent, cwd: b, tmux });
	const worker = await launch(again, "worker", { cwd: c });
	assert.equal(worker.windowSession, "A-delegate-session");
	assert.equal(worker.identity?.root, owner.parent);
	assert.equal(worker.identity?.rootPlacement, record.identity?.rootPlacement);
	assert.equal(readTree(owner.parent).entries.length, 3, "resume is a new delegation, not a new root");
});

test("malformed/missing root placement blocks ordinary reopen, launch and completion, never infers B", async () => {
	const a = repository("A"),
		b = resolvedProject("B", false),
		c = resolvedProject("C", true);
	const { owner, child, tmux } = await coordinator(a, b);
	const own = readIdentity(child.parent)!;
	await owner.shutdown();
	await child.shutdown();
	for (const invalid of [undefined, "", "elsewhere", "A-delegate-session-2", "../A-delegate-session", 42]) {
		writeFileSync(identityFile(child.parent), JSON.stringify({ ...own, rootPlacement: invalid }));
		const reopened = mailSession({ parent: child.parent, cwd: b, tmux });
		active.push(reopened);
		await assert.rejects(reopened.start(), /rootPlacement/);
		await assert.rejects(launch(reopened, "worker", { cwd: c }), /rootPlacement/);
		await assert.rejects(reopened.run(), /rootPlacement/);
		assert.equal(finals(owner).length, 0);
		assert.equal(tmux.opened.length, 1);
		await reopened.shutdown();
	}
	for (const valid of [
		"A-delegate-session",
		"project-delegate-session",
		"___-delegate-session",
		"A_b-9-delegate-session",
	])
		assert.doesNotThrow(() => assertRootPlacement(valid));
});

test("conflicting or corrupt saved placement refuses resume before kill/mail/reserve and corrupt registry refuses admission", async () => {
	const a = repository("A"),
		b = resolvedProject("B", false),
		c = resolvedProject("C", true);
	const { owner, child, tmux } = await coordinator(a, b);
	const w = await launch(child, "worker", { cwd: c });
	header(w);
	tmux.exit(w.windowId);
	const own = readIdentity(w.id)!;
	const sent = envelopes(child.parent, "sent").length;
	for (const changed of ["other-delegate-session", null]) {
		writeFileSync(identityFile(w.id), JSON.stringify({ ...own, rootPlacement: changed }));
		await assert.rejects(
			child.toolCall("delegation_resume", { id: w.id, task: "more" }),
			/conflicting ownership|rootPlacement/,
		);
		assert.deepEqual(tmux.killed, []);
		assert.equal(readTree(owner.parent).entries.length, 2);
		assert.equal(envelopes(child.parent, "sent").length, sent);
	}
	writeFileSync(identityFile(w.id), JSON.stringify(own));
	const parentIdentity = readIdentity(child.parent)!;
	await child.shutdown();
	writeFileSync(
		identityFile(child.parent),
		JSON.stringify({ ...parentIdentity, rootPlacement: "other-delegate-session" }),
	);
	const changedParent = await instance({ parent: child.parent, cwd: b, tmux });
	await assert.rejects(launch(changedParent, "worker", { cwd: c }), /conflicting rootPlacement/);
	await assert.rejects(changedParent.toolCall("delegation_resume", { id: w.id, task: "more" }), /rootPlacement/);
	assert.deepEqual(tmux.killed, []);
	assert.equal(envelopes(child.parent, "sent").length, sent);
	await changedParent.shutdown();
	writeFileSync(identityFile(child.parent), JSON.stringify(parentIdentity));
	const state = readTree(owner.parent);
	state.entries[0].identity.rootPlacement = "invalid";
	writeFileSync(treePath(owner.parent), JSON.stringify(state));
	const validParent = await instance({ parent: child.parent, cwd: b, tmux });
	await assert.rejects(launch(validParent, "worker", { cwd: c }), /rootPlacement/);
	assert.equal(tmux.opened.length, 2);
});

test("legacy identity-less delegation cannot resume after update, before any trust or launch effects", async () => {
	const target = repository("unresolved-legacy-target");
	mkdirSync(join(target, ".pi"));
	writeFileSync(join(target, ".pi", "settings.json"), "{}");
	const original = await instance();
	const record = await launch(original, "worker");
	header({ ...record, cwd: target });
	original.tmux.exit(record.windowId);
	await original.shutdown();
	const legacy = structuredClone(original.entries);
	for (const entry of legacy) delete (entry.data as Record<string, unknown>).identity;
	rmSync(join(agentDir, "squire", "child-tasks", `${encodeURIComponent(original.parent)}.json`), { force: true });
	rmSync(identityFile(record.id), { force: true });
	rmSync(treePath(original.parent), { force: true });
	const reopened = await instance({
		parent: original.parent,
		entries: legacy,
		tmux: original.tmux,
		ui: { select: ["Trust"] },
	});
	const beforeTree = readTree(original.parent);
	const beforeCounts = treeCounts(beforeTree);
	const trustFile = join(agentDir, "trust.json");
	const beforeTrust = existsSync(trustFile) ? readFileSync(trustFile, "utf8") : undefined;
	const beforeSent = envelopes(reopened.parent, "sent");
	const beforeOpened = reopened.tmux.opened.length;
	const beforeKilled = [...reopened.tmux.killed];
	assert.equal(new ProjectTrustStore(agentDir).get(target), null);
	await assert.rejects(
		reopened.toolCall("delegation_resume", { id: record.id, task: "again" }),
		/no original root placement identity; resume refused/,
	);
	await reopened.command("delegate-resume", `${record.id} again`);
	assert.match(reopened.errors.join("\n"), /no original root placement identity; resume refused/);
	await reopened.command("delegate-resume");
	assert.deepEqual(reopened.selects, []);
	assert.deepEqual(reopened.customs, []);
	assert.deepEqual(reopened.editors, []);
	assert.equal(existsSync(trustFile) ? readFileSync(trustFile, "utf8") : undefined, beforeTrust);
	assert.equal(new ProjectTrustStore(agentDir).get(target), null);
	assert.deepEqual(envelopes(reopened.parent, "sent"), beforeSent);
	assert.deepEqual(readTree(original.parent), beforeTree);
	assert.deepEqual(treeCounts(readTree(original.parent)), beforeCounts);
	assert.deepEqual(beforeCounts, { concurrent: 0, lifetime: 0 });
	assert.equal(reopened.tmux.opened.length, beforeOpened);
	assert.deepEqual(reopened.tmux.killed, beforeKilled);
	assert.equal(readIdentity(record.id), undefined, "refusal must not synthesize legacy identity");
});

test("contradictory inherited placement refuses before unresolved directory/worktree trust can prompt or persist", async () => {
	const a = repository("A"),
		b = resolvedProject("B", false),
		target = repository("unresolved");
	mkdirSync(join(target, ".pi"));
	writeFileSync(join(target, ".pi", "settings.json"), "{}");
	git(target, "add", ".pi/settings.json");
	git(target, "commit", "-qm", "project resources");
	const owner = await instance({ cwd: a, ui: { select: ["Trust", "Trust"] } });
	const record = await launch(owner, "coordinator", { cwd: b });
	const own = readIdentity(record.id)!;
	writeFileSync(identityFile(record.id), JSON.stringify({ ...own, rootPlacement: "other-delegate-session" }));
	const child = await instance({ parent: record.id, cwd: b, tmux: owner.tmux });
	const trustFile = join(agentDir, "trust.json");
	const beforeTrust = readFileSync(trustFile, "utf8");
	const beforeTree = readTree(owner.parent);
	const beforeWindows = [...owner.tmux.windows];
	const beforeSent = envelopes(child.parent, "sent");
	const beforeWorktrees = git(target, "worktree", "list", "--porcelain");
	const beforeBranches = git(target, "branch", "--list");
	assert.equal(new ProjectTrustStore(agentDir).get(target), null);
	for (const extra of [{ cwd: target }, { worktree: "placement/unresolved", worktree_source: target }])
		await assert.rejects(launch(child, "worker", extra), /conflicting rootPlacement/);
	assert.deepEqual(owner.selects, [], "root must not see a trust prompt before a known placement refusal");
	assert.deepEqual(child.selects, []);
	assert.equal(readFileSync(trustFile, "utf8"), beforeTrust);
	assert.equal(new ProjectTrustStore(agentDir).get(target), null);
	assert.deepEqual(envelopes(child.parent, "sent"), beforeSent);
	assert.deepEqual(readTree(owner.parent), beforeTree);
	assert.deepEqual([...owner.tmux.windows], beforeWindows);
	assert.equal(owner.tmux.opened.length, 1);
	assert.deepEqual(owner.tmux.killed, []);
	assert.equal(git(target, "worktree", "list", "--porcelain"), beforeWorktrees);
	assert.equal(git(target, "branch", "--list"), beforeBranches);
});

function server(tmux: FakeTmux): Server {
	return {
		windows: [...tmux.windows].map(([id, window]) => ({ id, ...window })),
		companions: [...tmux.companions],
		parentSession: "unrelated-coordinator-tmux",
	};
}
function processInstance(): TreeProcess {
	const p = new TreeProcess(agentDir, "./fixtures/session-owner.ts");
	processes.push(p);
	return p;
}

for (const exit of ["shutdown", "crash"]) {
	test(`actual coordinator process ${exit}/same-id restart resumes C with root absent and no env`, async () => {
		const a = repository("A"),
			b = resolvedProject("B", false),
			c = resolvedProject("C", true);
		const owner = await instance({ cwd: a });
		owner.tmux.addWindow("@100", "user", "A-delegate-session");
		const coordinatorRecord = await launch(owner, "coordinator", { cwd: b });
		await owner.shutdown();
		assert.equal(sessionIsOwned(owner.parent), false);
		const original = processInstance();
		const boot = { session: coordinatorRecord.id, cwd: b, sessionDir, stateHome: join(root, "mail-state") };
		const started = await original.command<ProcessSnapshot>("boot", { ...boot, server: server(owner.tmux) });
		assert.deepEqual(started.delegateEnv, []);
		assert.equal(started.identity.rootPlacement, "A-delegate-session");
		const claimed = await original.command<ProcessSnapshot>("scan");
		assert.equal(claimed.prompts.length, 1, "released provider took over the coordinator task");
		const opened = await original.command<ProcessSnapshot>("tool", {
			tool: "delegate",
			params: { agent: "worker", task: "work", cwd: c },
		});
		const worker = opened.entries.find(({ data }) => data.id === opened.result.structuredContent.id)!.data;
		assert.equal(opened.result.structuredContent.windowSession, "A-delegate-session-2");
		assert.equal(worker.identity?.rootPlacement, "A-delegate-session");
		header(worker);
		if (exit === "shutdown") await original.command("shutdown");
		await original.kill();
		assert.equal(sessionIsOwned(coordinatorRecord.id), false);
		const next = processInstance();
		const restored = await next.command<ProcessSnapshot>("boot", {
			...boot,
			server: {
				windows: opened.windows.map((window) => ({ ...window, exited: window.id === worker.windowId })),
				companions: opened.companions,
				parentSession: "different-reopen-pane",
			},
		});
		assert.deepEqual(restored.delegateEnv, []);
		assert.equal(restored.identity.rootPlacement, "A-delegate-session");
		assert.deepEqual(restored.opened, [], "same-id startup never recreates workers");
		const resumed = await next.command<ProcessSnapshot>("tool", {
			tool: "delegation_resume",
			params: { id: worker.id, task: "continue" },
		});
		assert.equal(resumed.result.structuredContent.windowSession, "A-delegate-session-2");
		assert.equal(resumed.result.structuredContent.resumedFrom, worker.id);
		const identity = readIdentity(worker.id)!;
		assert.equal(identity.rootPlacement, "A-delegate-session");
		assert.equal(identity.root, owner.parent);
		assert.equal(identity.parent, coordinatorRecord.id);
		assert.equal(identity.depth, 2);
		assert.deepEqual(identity.chain, ["coordinator", "worker"]);
		assert.deepEqual(resumed.killed, [worker.windowId]);
		assert.deepEqual(resumed.selects, [], "offline trust was already decided, not bypassed");
		assert.ok(resumed.opened[0].argv.includes("--approve"));
		assert.deepEqual(treeCounts(readTree(owner.parent)), { concurrent: 2, lifetime: 3 });
		const another = await next.command<ProcessSnapshot>("tool", {
			tool: "delegate",
			params: { agent: "worker", task: "new task", cwd: c },
		});
		assert.equal(another.result.structuredContent.windowSession, "A-delegate-session-2");
		assert.equal(another.opened.length, 2);
		assert.equal(
			another.windows.some((window) => window.id === "@100" && window.name === "user"),
			true,
		);
		assert.equal(finals(owner).length, 0, "no raw grandchild final or coordinator interim final");
		await next.command("shutdown");
	});
}
