import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { parseArgs, SessionManager } from "@earendil-works/pi-coding-agent";

import { readIdentity } from "../src/identity.ts";
import type { Delegation } from "../src/results.ts";
import { readTree, treeCounts } from "../src/tree-registry.ts";
import {
	agentDir,
	agentFile,
	cleanup,
	resetRoot,
	root,
	rosterDir,
	type SessionOptions,
	session,
	sessionDir,
	writeAgent,
} from "./harness.ts";

beforeEach(() => {
	resetRoot();
	writeAgent("scout", agentFile({ model: "alpha/fast-model", thinking: "low", auto_exit: "false" }));
});
after(cleanup);

function settings(value: Record<string, unknown>): void {
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(join(agentDir, "squire", "settings.json"), JSON.stringify(value));
}

async function source(cwd = root, options: SessionOptions = {}) {
	const s = session(options);
	await s.start();
	const started = await s.toolCall("delegate", { agent: "scout", task: "first task", cwd });
	const id = (started.structuredContent as { id: string }).id;
	mkdirSync(sessionDir, { recursive: true });
	const file = join(sessionDir, `source_${id}.jsonl`);
	writeFileSync(
		file,
		`${JSON.stringify({ type: "session", version: 3, id, cwd, timestamp: new Date().toISOString() })}
${JSON.stringify({ type: "thinking_level_change", id: "level", parentId: null, thinkingLevel: "high", timestamp: new Date().toISOString() })}
${JSON.stringify({ type: "message", id: "answer", parentId: "level", message: { role: "assistant", provider: "alpha", model: "deep-model", content: [{ type: "text", text: "built state" }] } })}
`,
	);
	return { s, id, file };
}
const fork = (s: ReturnType<typeof session>, id: string, more: Record<string, unknown> = {}) =>
	s.toolCall("delegation_fork", { id, task: "new task from built state", ...more });

function lastStart(s: ReturnType<typeof session>): Delegation {
	return s.entries.findLast(({ data }) => typeof data.requestId === "string")!.data as Delegation;
}

test("fork combines Pi flags, copies context to a new exact session id and leaves a running source untouched", async () => {
	const cwd = join(root, "child-folder");
	mkdirSync(cwd);
	const d = await source(cwd);
	const original = readFileSync(d.file, "utf8");
	const originalIdentity = readIdentity(d.id);
	const launches: { args: string[]; env: Record<string, string>; toolCallId: string }[] = [];
	d.s.events.on("session:launch", (payload) => launches.push(payload as (typeof launches)[number]));
	const result = await fork(d.s, d.id);
	const detail = result.structuredContent as { id: string; forkedFrom: string; model: string; thinking: string };
	const record = lastStart(d.s);
	assert.notEqual(detail.id, d.id);
	assert.equal(detail.forkedFrom, d.id);
	assert.equal(record.forkedFrom, d.id);
	assert.equal(record.resumedFrom, undefined);
	assert.equal(record.sessionId, undefined, "a fresh fork's session id equals its delegation id");
	assert.equal(detail.model, "alpha/deep-model");
	assert.equal(detail.thinking, "high");
	assert.equal(record.autoExit, false);
	const window = d.s.tmux.opened[1];
	assert.equal(window.cwd, realpathSync(cwd));
	const parsed = parseArgs([...window.argv]);
	assert.equal(parsed.fork, d.file);
	assert.equal(parsed.sessionId, detail.id);
	assert.equal(parsed.sessionDir, sessionDir);
	assert.equal(parsed.model, "alpha/deep-model");
	assert.equal(parsed.thinking, "high");
	assert.ok(parsed.tools?.includes("read"));
	assert.equal(parsed.session, undefined);
	assert.ok(window.argv.includes("--no-approve"));
	assert.match(launches[0].toolCallId, /^call-/);
	assert.notEqual(window.name, d.s.tmux.opened[0].name);
	assert.equal(d.s.tmux.killed.length, 0);
	assert.equal(d.s.tmux.windows.size, 2);
	assert.equal(d.s.sendCalls.at(-1)?.to, detail.id);
	assert.equal(d.s.sendCalls.at(-1)?.body, "new task from built state");
	assert.equal(readFileSync(d.file, "utf8"), original);
	assert.deepEqual(readIdentity(d.id), originalIdentity);
	assert.equal(readIdentity(detail.id)?.parent, d.s.parent);
	assert.deepEqual(treeCounts(readTree(d.s.parent)), { concurrent: 2, lifetime: 2 });
	assert.equal(readTree(d.s.parent).entries.at(-1)?.forkedFrom, d.id);

	// Exercise the installed Pi copy primitive used by --fork, without a provider.
	const copied = SessionManager.forkFrom(parsed.fork!, window.cwd, parsed.sessionDir, { id: parsed.sessionId });
	assert.equal(copied.getSessionId(), detail.id);
	assert.equal(copied.getHeader()?.cwd, realpathSync(cwd));
	assert.equal(copied.getHeader()?.parentSession, d.file);
	assert.match(readFileSync(copied.getSessionFile()!, "utf8"), /built state/);
	assert.equal(readFileSync(d.file, "utf8"), original);
});

test("forks can branch repeatedly, including from an older resumed record", async () => {
	const d = await source();
	d.s.tmux.windows.delete(d.s.tmux.opened[0].windowId);
	await d.s.toolCall("delegation_resume", { id: d.id, task: "continue original" });
	const a = await fork(d.s, d.id);
	const b = await fork(d.s, d.id);
	assert.notEqual((a.structuredContent as { id: string }).id, (b.structuredContent as { id: string }).id);
	assert.equal(d.s.tmux.opened.length, 4);
	assert.equal(d.s.tmux.killed.length, 0);
});

test("fork reply, status and durable restore retain independent lineage", async () => {
	const d = await source();
	const result = await fork(d.s, d.id);
	const { id } = result.structuredContent as { id: string };
	const record = lastStart(d.s);
	const payload = {
		envelope: {
			id: "reply",
			from: id,
			to: d.s.parent,
			in_reply_to: [record.requestId],
			status: "done",
			ts: "",
			body: "fork answer",
		},
		path: "/mail/cur/reply.json",
		requests: [],
		handled: false,
	};
	d.s.events.emit("message:inbound", payload);
	assert.equal(payload.handled, true);
	const message = d.s.sent.find((item) => String(item.message.content).includes("fork answer"));
	assert.match(String(message?.message.content), new RegExp(`forked from ${d.id}`));
	assert.equal((await d.s.toolCall("delegation_status", { id })).content[0].text.includes(`forked from ${d.id}`), true);
	await d.s.shutdown();
	const restored = session({ parent: d.s.parent, entries: d.s.entries, tmux: d.s.tmux });
	await restored.start();
	const status = await restored.toolCall("delegation_status", { id });
	const details = status.structuredContent as { delegations: { forkedFrom: string; state: string }[] };
	assert.equal(details.delegations[0].forkedFrom, d.id);
	assert.equal(details.delegations[0].state, "done");
	assert.equal(treeCounts(readTree(d.s.parent)).concurrent, 1, "the source is still tracked and active");
});

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, {
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Fixture",
			GIT_AUTHOR_EMAIL: "fixture@example.invalid",
			GIT_COMMITTER_NAME: "Fixture",
			GIT_COMMITTER_EMAIL: "fixture@example.invalid",
		},
		stdio: ["ignore", "pipe", "pipe"],
	})
		.toString()
		.trim();

test("fork worktree starts from the child's checkout, not the parent's, with an optional base", async () => {
	const checkout = join(root, "checkout");
	mkdirSync(checkout);
	git(checkout, "init", "-q", "-b", "main");
	writeFileSync(join(checkout, "base.txt"), "base");
	git(checkout, "add", ".");
	git(checkout, "commit", "-qm", "base");
	const base = git(checkout, "rev-parse", "HEAD");
	writeFileSync(join(checkout, "next.txt"), "next");
	git(checkout, "add", ".");
	git(checkout, "commit", "-qm", "next");
	const head = git(checkout, "rev-parse", "HEAD");
	const d = await source(checkout);
	for (const [branch, more, expected] of [
		["fork/head", {}, head],
		["fork/base", { worktree_base: "HEAD~1" }, base],
	] as const) {
		const result = await fork(d.s, d.id, { worktree: branch, ...more });
		const details = result.structuredContent as {
			cwd: string;
			workspace: { mode: string; baseCommit: string; sourceCwd: string };
		};
		assert.equal(details.workspace.mode, "managed");
		assert.equal(details.workspace.baseCommit, expected);
		assert.notEqual(details.cwd, checkout);
		assert.equal(git(details.cwd, "rev-parse", "HEAD"), expected);
		assert.equal(git(details.cwd, "branch", "--show-current"), branch);
		assert.equal(parseArgs([...d.s.tmux.opened.at(-1)!.argv]).fork, d.file);
	}
	assert.equal(git(checkout, "rev-parse", "HEAD"), head);
	assert.equal(git(checkout, "branch", "--show-current"), "main");
});

test("fork honors model/thinking locks, explicit overrides, tools and auto-exit", async () => {
	const d = await source();
	writeAgent(
		"scout",
		agentFile({ model: "alpha/fast-model", thinking: "low", locked: "[model, thinking]", tools: "[]" }),
	);
	const locked = await fork(d.s, d.id, { model: "beta/other-model", thinking: "minimal", auto_exit: true });
	const details = locked.structuredContent as { model: string; thinking: string; autoExit: boolean; notices: string[] };
	assert.equal(details.model, "alpha/fast-model");
	assert.equal(details.thinking, "low");
	assert.equal(details.autoExit, true);
	assert.ok(details.notices.length > 0);
	assert.ok(d.s.tmux.opened.at(-1)!.argv.includes("--no-tools"));
	writeAgent("scout", agentFile({ model: "alpha/fast-model" }));
	const unlocked = await fork(d.s, d.id, { model: "beta/other-model", thinking: "minimal" });
	assert.equal((unlocked.structuredContent as { model: string }).model, "beta/other-model");
	assert.equal((unlocked.structuredContent as { thinking: string }).thinking, "minimal");
});

test("fork validates task, id, session, roster and model before mailing or opening", async () => {
	const d = await source();
	for (const [id, more, pattern] of [
		[d.id, { task: " " }, /task is required/],
		["missing", {}, /no delegation/],
		[d.id, { thinking: "loud" }, /unknown thinking/],
		[d.id, { model: "unknown/model" }, /model/],
		[d.id, { worktree_base: "HEAD" }, /requires worktree/],
	] as const)
		await assert.rejects(fork(d.s, id, more), pattern);
	unlinkSync(join(rosterDir, "scout.md"));
	await assert.rejects(fork(d.s, d.id), /no longer in the roster/);
	writeAgent("scout", agentFile({ model: "alpha/fast-model" }));
	unlinkSync(d.file);
	await assert.rejects(fork(d.s, d.id), /no session file|could not read a working directory/);
	assert.equal(d.s.tmux.opened.length, 1);
	assert.equal(d.s.sendCalls.length, 1);
});

test("fork requires direct-parent authority, depth/grant admission and shared capacity", async () => {
	const d = await source();
	const stranger = session({ entries: d.s.entries });
	await stranger.start();
	await assert.rejects(fork(stranger, d.id), /no delegation|only direct parent/);
	settings({ maxConcurrentDelegates: 1 });
	await assert.rejects(fork(d.s, d.id), /maxConcurrentDelegates/);
	assert.equal(d.s.tmux.opened.length, 1);
	assert.equal(d.s.sendCalls.length, 1);
	settings({ maxDepth: 2 });
	const child = session({ parent: d.id, tmux: d.s.tmux });
	await child.start();
	assert.ok(!child.pi.getActiveTools().includes("delegation_fork"), "ordinary children cannot fork delegates");
});

test("fork rechecks a coordinator's grant and depth before launching", async () => {
	settings({ maxDepth: 3 });
	writeAgent("coordinator", agentFile({ model: "alpha/fast-model", allow_nested_delegation: "[scout]" }));
	const d = await source(root, { parentEnv: "root-owner", agentEnv: "coordinator" });
	assert.ok(d.s.pi.getActiveTools().includes("delegation_fork"));
	await fork(d.s, d.id);
	writeAgent("coordinator", agentFile({ model: "alpha/fast-model" }));
	await assert.rejects(fork(d.s, d.id), /does not permit nested agent/);
	writeAgent("coordinator", agentFile({ model: "alpha/fast-model", allow_nested_delegation: "[scout]" }));
	settings({ maxDepth: 1 });
	await assert.rejects(fork(d.s, d.id), /exceeds maxDepth/);
	assert.equal(d.s.tmux.opened.length, 2);
	assert.equal(d.s.sendCalls.length, 2);
});

test("a definite failed fork window launch refunds its reservation and leaves the original untouched", async () => {
	const d = await source();
	d.s.tmux.failOpen = "no space";
	await assert.rejects(fork(d.s, d.id), /could not open window.*no space/);
	assert.equal(d.s.tmux.killed.length, 0);
	assert.deepEqual(treeCounts(readTree(d.s.parent)), { concurrent: 1, lifetime: 1 });
	d.s.tmux.failOpen = undefined;
	await fork(d.s, d.id);
	assert.equal(d.s.tmux.opened.length, 2);
});
