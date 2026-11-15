import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { createPaseoHost } from "../src/paseo.ts";
import { readTree, treeCounts } from "../src/tree-registry.ts";
import { agentFile, cleanup, resetRoot, root, session, sessionDir, writeAgent } from "./harness.ts";
import { FakePaseo } from "./paseo-fixture.ts";

beforeEach(resetRoot);
after(cleanup);

function paseo() {
	const api = new FakePaseo();
	return { api, host: createPaseoHost(api, { PASEO_AGENT_ID: randomUUID() }) };
}

test("Paseo resource switches refuse before reservation, trust, hook, mail or workspace creation", async () => {
	const cases: Record<string, string>[] = [
		{ skills: "false" },
		{ context_files: "false" },
		{ skills: "false", context_files: "false" },
	];
	for (const fields of cases) {
		resetRoot();
		writeAgent("scout", agentFile(fields));
		const { api, host } = paseo();
		const s = session({ multiplexer: host });
		await s.start();
		let hooks = 0;
		s.events.on("session:launch", () => hooks++);
		await assert.rejects(
			s.toolCall("delegate", { agent: "scout", task: "inspect", worktree: "not-created" }),
			/Paseo cannot disable Pi resources.*tmux or Herdr/,
		);
		assert.deepEqual(readTree(s.parent).entries, []);
		assert.deepEqual(s.sendCalls, []);
		assert.deepEqual(api.created, []);
		assert.equal(s.confirms.length, 0);
		assert.equal(hooks, 0);
		await s.command("delegate", "scout --worktree not-created inspect");
		assert.match(s.errors.at(-1) ?? "", /Paseo cannot disable Pi resources/);
		assert.deepEqual(readTree(s.parent).entries, []);
		await s.shutdown();
	}
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("hook-only unsupported Paseo flags run once with final cwd, then roll back without task mail", async () => {
	const cwd = join(root, "repo");
	mkdirSync(cwd);
	git(cwd, "init", "-q", "-b", "main");
	writeFileSync(join(cwd, "tracked"), "base");
	git(cwd, "add", ".");
	git(
		cwd,
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-qm",
		"base",
	);
	writeAgent("scout", agentFile({}));
	const { api, host } = paseo();
	const s = session({ multiplexer: host, cwd });
	await s.start();
	let hooks = 0;
	let destination = "";
	s.events.on("session:launch", (value) => {
		const payload = value as { args: string[]; cwd: string };
		hooks++;
		destination = payload.cwd;
		assert.ok(existsSync(destination));
		payload.args.push("--no-skills");
	});
	await assert.rejects(
		s.toolCall("delegate", { agent: "scout", task: "inspect", worktree: "hook-refusal" }),
		/Paseo cannot disable Pi resources.*outcome rolled-back/,
	);
	assert.equal(hooks, 1);
	assert.equal(existsSync(destination), false);
	assert.equal(git(cwd, "branch", "--list", "hook-refusal"), "");
	assert.deepEqual(treeCounts(readTree(s.parent)), { concurrent: 0, lifetime: 0 });
	assert.deepEqual(s.sendCalls, []);
	assert.deepEqual(api.created, []);
	await s.shutdown();
});

test("Paseo selected host refuses resume tool and picker up front", async () => {
	const { api, host } = paseo();
	const s = session({ multiplexer: host });
	await s.start();
	await assert.rejects(
		s.toolCall("delegation_resume", { id: "missing", task: "again" }),
		/Paseo cannot resume or fork.*new delegation/,
	);
	await s.command("delegate-resume", "");
	assert.equal(s.selects.length, 0);
	assert.match(s.errors.at(-1) ?? "", /Paseo cannot resume or fork/);
	assert.deepEqual(readTree(s.parent).entries, []);
	assert.deepEqual(api.created, []);
	assert.deepEqual(s.sendCalls, []);
	await s.shutdown();
});

test("Paseo source stays non-actionable from a terminal for resume, fork and picker", async () => {
	writeAgent("scout", agentFile({}));
	const { api, host } = paseo();
	const s = session({ multiplexer: host });
	await s.start();
	const launched = await s.toolCall("delegate", { agent: "scout", task: "first" });
	const id = (launched.structuredContent as { id: string }).id;
	const record = s.entries.findLast((entry) => entry.data.id === id);
	assert.ok(record);
	const sessionId = String(record.data.sessionId);
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(
		join(sessionDir, `source_${sessionId}.jsonl`),
		`${JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: root, timestamp: new Date().toISOString() })}\n`,
	);
	api.running.clear();
	await s.shutdown();
	const terminal = session({ parent: s.parent, entries: s.entries });
	await terminal.start();
	for (const tool of ["delegation_resume", "delegation_fork"]) {
		await assert.rejects(terminal.toolCall(tool, { id, task: "again" }), /Paseo cannot resume or fork.*new delegation/);
	}
	await terminal.command("delegate-resume", "");
	assert.equal(terminal.selects.length, 0);
	const completions = await terminal.completionsFor("delegate-resume", "");
	assert.equal(completions?.some((item) => item.value === id) ?? false, false);
	assert.deepEqual(terminal.sendCalls, []);
	assert.equal(terminal.tmux.opened.length, 0);
	assert.equal(readTree(s.parent).entries.length, 1);
	await terminal.shutdown();
});

test("a terminal source cannot fork into Paseo, before reservation or a managed worktree", async () => {
	writeAgent("scout", agentFile({}));
	const terminal = session();
	await terminal.start();
	const launched = await terminal.toolCall("delegate", { agent: "scout", task: "first" });
	const id = (launched.structuredContent as { id: string }).id;
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(
		join(sessionDir, `source_${id}.jsonl`),
		`${JSON.stringify({ type: "session", version: 3, id, cwd: root, timestamp: new Date().toISOString() })}\n`,
	);
	await terminal.shutdown();
	const { api, host } = paseo();
	const hosted = session({ parent: terminal.parent, entries: terminal.entries, multiplexer: host });
	await hosted.start();
	const before = readTree(terminal.parent);
	await assert.rejects(
		hosted.toolCall("delegation_fork", { id, task: "fork", worktree: "not-created" }),
		/Paseo cannot resume or fork.*new delegation/,
	);
	const after = readTree(terminal.parent);
	assert.deepEqual(
		after.entries.map((entry) => entry.id),
		before.entries.map((entry) => entry.id),
	);
	assert.deepEqual(treeCounts(after), treeCounts(before));
	// locateSession has always cached the source path; checkStorage publishes it without reserving a fork.
	assert.equal(after.entries[0].launch?.sessionPath, join(sessionDir, `source_${id}.jsonl`));
	assert.deepEqual(api.created, []);
	assert.deepEqual(hosted.sendCalls, []);
	await hosted.shutdown();
});

test("fresh delegation guidance distinguishes resources and fork history without assuming a terminal", async () => {
	writeAgent("scout", agentFile({}));
	const s = session();
	await s.start();
	const text = s.tool("delegate").description;
	assert.match(text, /no parent conversation/);
	assert.match(text, /normal Pi skills\/context files load unless disabled/);
	assert.match(text, /Forks copy history/);
	assert.doesNotMatch(text, /background terminal|sees only the task/);
	await s.shutdown();
});
