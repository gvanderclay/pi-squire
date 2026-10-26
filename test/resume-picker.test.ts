// The resume picker offers exactly the delegations `resume` would accept: the
// call-wide prerequisites (tmux, placement) once, then per record every
// check that changes nothing. The picker never kills a window or asks for trust.

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

import {
	agentDir,
	agentFile,
	cleanup,
	resetRoot,
	root,
	rosterDir,
	session,
	sessionDir,
	writeAgent,
} from "./harness.ts";

beforeEach(() => {
	resetRoot();
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "pi-squire-limits.json"), "[]");
});
after(() => cleanup());

type Session = ReturnType<typeof session>;

const AGENT = { description: "Looks things up", model: "alpha/fast-model", thinking: "low" };

function writeSession(id: string, cwd: string): void {
	mkdirSync(sessionDir, { recursive: true });
	const header = { type: "session", version: 3, id, timestamp: "2026-10-26T00:00:00.000Z", cwd };
	writeFileSync(join(sessionDir, `20261026T000000_${id}.jsonl`), `${JSON.stringify(header)}\n`);
}

/** A session with one exited, resumable delegation (its window gone, its session file there). */
async function exited(options: Parameters<typeof session>[0] = {}, agent: Record<string, string> = AGENT) {
	writeAgent("scout", agentFile(agent));
	const s = session({ ...options, ui: { select: [undefined], ...options?.ui } });
	await s.start();
	await s.delegate("scout --label one work");
	const entry = s.entries.at(-1)?.data as { id: string; windowId: string };
	writeSession(entry.id, root);
	s.tmux.windows.delete(entry.windowId);
	return { s, id: entry.id, windowId: entry.windowId };
}

/** What the picker offered, as the option list of its select. */
async function offered(s: Session): Promise<string[]> {
	const before = s.selects.length;
	await s.command("delegate-resume", "");
	return s.selects.length > before ? s.selects[before].options : [];
}

test("a resumable delegation is offered, and the picker changes nothing", async () => {
	const { s } = await exited();
	assert.equal((await offered(s)).length, 1);
	assert.deepEqual(s.tmux.killed, []);
});

test("an exited window is offered and left for the resume to kill", async () => {
	const { s, windowId } = await exited();
	s.tmux.addWindow(windowId, "scout-one");
	s.tmux.exit(windowId);
	assert.equal((await offered(s)).length, 1);
	assert.deepEqual(s.tmux.killed, [], "the picker does not kill it");
	assert.equal(s.tmux.windows.has(windowId), true);
});

test("a window still running its program, a removed agent, a missing session file and a missing directory are not offered", async () => {
	const open = await exited();
	open.s.tmux.addWindow(open.windowId, "scout-one");
	assert.deepEqual(await offered(open.s), []);

	const noAgent = await exited();
	rmSync(rosterDir, { recursive: true, force: true });
	assert.deepEqual(await offered(noAgent.s), []);

	const noFile = await exited();
	rmSync(sessionDir, { recursive: true, force: true });
	assert.deepEqual(await offered(noFile.s), []);

	const noDir = await exited();
	writeSession(noDir.id, join(root, "removed-worktree"));
	assert.deepEqual(await offered(noDir.s), []);
});

test("tmux older than 3.2 refuses with the message resume gives, and lists nothing", async () => {
	const { s, id } = await exited();
	s.tmux.versionText = "tmux 3.1c";
	await s.command("delegate-resume", "");
	assert.equal(s.selects.length, 0);
	const picker = s.errors.at(-1) ?? "";
	assert.match(picker, /tmux 3\.2 or later; this is tmux 3\.1c/);
	const tool = await s.toolCall("delegation_resume", { id, task: "again" }).then(String, (err: Error) => err.message);
	assert.equal(picker, `delegate: ${tool}`);
});

test("an invalid windowPlacement refuses with the message resume gives, and lists nothing", async () => {
	const { s, id } = await exited();
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(join(agentDir, "squire", "settings.json"), JSON.stringify({ windowPlacement: "pane" }));
	await s.command("delegate-resume", "");
	assert.equal(s.selects.length, 0);
	const tool = await s.toolCall("delegation_resume", { id, task: "again" }).then(String, (err: Error) => err.message);
	assert.match(tool, /windowPlacement must be "companion" or "current"/);
	assert.equal(s.errors.at(-1), `delegate: ${tool}`);
});

test("a record whose model and fallbacks have no credentials is not offered; a usable fallback keeps it", async () => {
	const missing: string[] = [];
	const none = await exited({ noCredentials: missing });
	missing.push("alpha/fast-model"); // the credentials go after the launch
	assert.deepEqual(await offered(none.s), []);
	const tool = await none.s
		.toolCall("delegation_resume", { id: none.id, task: "again" })
		.then(String, (err: Error) => err.message);
	assert.match(tool, /alpha\/fast-model/, "resume refuses it too");

	const gone: string[] = [];
	const fallback = await exited({ noCredentials: gone }, { ...AGENT, fallback: "beta/other-model" });
	gone.push("alpha/fast-model");
	assert.equal((await offered(fallback.s)).length, 1);
});

test("a record whose model is usage-limited with no fallback is not offered", async () => {
	const { s } = await exited();
	writeFileSync(
		join(agentDir, "pi-squire-limits.json"),
		JSON.stringify([
			{
				scope: "alpha",
				source: "reactive",
				reason: "429",
				recordedAt: Date.now(),
				clearsAt: Date.now() + 3_600_000,
				hits: 1,
				delegations: [],
			},
		]),
	);
	assert.deepEqual(await offered(s), []);
});

test("a record with a thinking level that is no longer valid is not offered", async () => {
	const { s, id } = await exited();
	(s.entries.at(-1)?.data as { thinking: string }).thinking = "bogus";
	await s.start(); // the records are rebuilt from the entries
	assert.deepEqual(await offered(s), []);
	const tool = await s.toolCall("delegation_resume", { id, task: "again" }).then(String, (err: Error) => err.message);
	assert.match(tool, /thinking/i);
});
