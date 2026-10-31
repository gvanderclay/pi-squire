import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { agentDir, agentFile, cleanup, resetRoot, root, sessionDir, writeAgent } from "./harness.ts";
import { mailSession, scan } from "./mail-harness.ts";

type Session = ReturnType<typeof mailSession>;
const active: Session[] = [];
beforeEach(() => {
	resetRoot();
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(join(agentDir, "squire", "settings.json"), JSON.stringify({ maxDepth: 2 }));
	writeAgent("coordinator", agentFile({ allow_nested_delegation: "[worker]" }));
	writeAgent("worker", agentFile({}));
});
afterEach(async () => {
	for (const session of active.splice(0)) await session.shutdown();
});
after(() => cleanup());
async function coordinator(): Promise<Session> {
	const parent = mailSession();
	active.push(parent);
	await parent.start();
	await parent.toolCall("delegate", { agent: "coordinator", task: "coordinate" });
	const child = mailSession({ parent: parent.entries[0].data.id as string });
	active.push(child);
	await child.start();
	scan(child);
	return child;
}
const protectedDirectory = (name: string): string => {
	const cwd = join(root, name);
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "settings.json"), "{}");
	return cwd;
};
function git(cwd: string, args: string[]): void {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
}

test("managed-worktree trust canceled at root refuses before creation or unattended UI", async () => {
	const session = await coordinator();
	const source = protectedDirectory("untrusted-source");
	git(source, ["init", "-q"]);
	git(source, ["add", ".pi/settings.json"]);
	git(source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]);
	await assert.rejects(
		session.toolCall("delegate", {
			agent: "worker",
			task: "go",
			worktree: "nested-trust",
			worktree_source: source,
		}),
		/trust question.*cancelled/,
	);
	assert.equal(session.selects.length, 0);
	assert.equal(session.tmux.opened.length, 0);
	const branch = spawnSync("git", ["show-ref", "--verify", "refs/heads/nested-trust"], { cwd: source });
	assert.notEqual(branch.status, 0, "no branch was created");
});

test("resume trust canceled at root opens no unattended UI", async () => {
	const session = await coordinator();
	await session.toolCall("delegate", { agent: "worker", task: "go" });
	const record = session.entries[0].data as { id: string; windowId: string };
	const cwd = protectedDirectory("untrusted-resume");
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(
		join(sessionDir, `worker_${record.id}.jsonl`),
		`${JSON.stringify({ type: "session", version: 3, id: record.id, cwd, timestamp: "" })}\n`,
	);
	session.tmux.windows.delete(record.windowId);
	await assert.rejects(
		session.toolCall("delegation_resume", { id: record.id, task: "again" }),
		/trust question.*cancelled/,
	);
	assert.equal(session.selects.length, 0);
	assert.equal(session.tmux.opened.length, 1, "only the original launch opened a window");
});

test("saved nested trust decisions retain explicit approval/denial flags without UI", async () => {
	const session = await coordinator();
	for (const decision of [true, false]) {
		const cwd = protectedDirectory(`decided-${String(decision)}`);
		new ProjectTrustStore(agentDir).setMany([{ path: realpathSync(cwd), decision }]);
		await session.toolCall("delegate", { agent: "worker", task: "go", cwd });
		assert.ok(session.tmux.opened.at(-1)?.argv.includes(decision ? "--approve" : "--no-approve"));
	}
	assert.equal(session.selects.length, 0);
});
