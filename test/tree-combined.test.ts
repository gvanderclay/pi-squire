// Merge-seam regressions for 03b ceiling + 04 accounting + 05 routed trust.
// Released mail, isolated loopback trust and one shared FakeTmux; no models.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { parseArgs } from "@earendil-works/pi-coding-agent";
import type { Delegation } from "../src/results.ts";
import { readTree, treeCounts } from "../src/tree-registry.ts";
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

type Session = ReturnType<typeof mailSession>;
const active: Session[] = [];
function instance(options: SessionOptions = {}): Session {
	const s = mailSession(options);
	active.push(s);
	return s;
}
async function launch(parent: Session, agent: string, cwd?: string): Promise<Delegation> {
	const result = await parent.toolCall("delegate", { agent, task: "work", ...(cwd ? { cwd } : {}) });
	return parent.entries.findLast(({ data }) => data.id === (result.details as { id: string }).id)!.data as Delegation;
}
async function tree(options: SessionOptions = {}): Promise<{ owner: Session; coordinator: Session }> {
	const owner = instance(options);
	await owner.start();
	const record = await launch(owner, "coordinator");
	const coordinator = instance({
		parent: record.id,
		tmux: owner.tmux,
		activeTools: ["read", "delegate", "delegation_status", "delegation_close", "delegation_resume"],
	});
	await coordinator.start();
	scan(coordinator);
	return { owner, coordinator };
}
function target(name: string): string {
	const cwd = join(root, name);
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "settings.json"), "{}");
	return cwd;
}
function header(record: Delegation, cwd: string): void {
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(
		join(sessionDir, `date_${record.id}.jsonl`),
		`${JSON.stringify({ type: "session", id: record.id, cwd })}\n`,
	);
}
beforeEach(() => {
	resetRoot();
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(join(agentDir, "squire", "settings.json"), JSON.stringify({ maxDepth: 2, maxConcurrentDelegates: 2 }));
	writeAgent(
		"coordinator",
		agentFile({ model: "alpha/fast-model", allow_nested_delegation: "[worker]", auto_exit: "false" }),
	);
	writeAgent("worker", agentFile({ model: "alpha/fast-model", tools: "read,write", auto_exit: "false" }));
});
afterEach(async () => {
	for (const s of active.splice(0).reverse()) await s.shutdown();
});
after(cleanup);

test("routed trust, final hook ceiling and shared cap accounting compose on launch and resume", async () => {
	const { owner, coordinator } = await tree({ ui: { select: ["Do not trust", "Trust (this session only)"] } });
	let hooks = 0;
	coordinator.events.on("session:launch", (payload: unknown) => {
		hooks++;
		(payload as { args: string[] }).args.push("--tools", "read,write,child_only");
	});
	const record = await launch(coordinator, "worker", target("combined-launch"));
	assert.equal(owner.selects.length, 1);
	assert.equal(coordinator.selects.length, 0);
	assert.match(owner.selects[0].title, /Agent chain: coordinator → worker/);
	assert.deepEqual(parseArgs([...owner.tmux.opened.at(-1)!.argv]).tools, ["read", "mcp__"]);
	assert.ok(owner.tmux.opened.at(-1)!.argv.includes("--no-approve"));
	assert.deepEqual(treeCounts(readTree(owner.parent)), { concurrent: 2, lifetime: 2 });
	const worker = instance({ parent: record.id, tmux: owner.tmux });
	await worker.start();
	scan(worker);
	await worker.run();
	scan(coordinator);
	assert.deepEqual(treeCounts(readTree(owner.parent)), { concurrent: 1, lifetime: 2 });
	header(record, target("combined-resume"));
	owner.tmux.exit(record.windowId);
	await coordinator.toolCall("delegation_resume", { id: record.id, task: "continue" });
	assert.equal(owner.selects.length, 2);
	assert.equal(coordinator.selects.length, 0);
	assert.deepEqual(parseArgs([...owner.tmux.opened.at(-1)!.argv]).tools, ["read", "mcp__"]);
	assert.ok(owner.tmux.opened.at(-1)!.argv.includes("--approve"));
	assert.deepEqual(treeCounts(readTree(owner.parent)), { concurrent: 2, lifetime: 3 });
	const mail = envelopes(coordinator.parent, "sent").length;
	await assert.rejects(launch(coordinator, "worker"), /maxConcurrentDelegates.*count 2, limit 2/);
	assert.equal(hooks, 2);
	assert.equal(envelopes(coordinator.parent, "sent").length, mail);
	assert.equal(envelopes(owner.parent, "cur").filter((message) => message.in_reply_to.length).length, 0);
});

test("post-hook ceiling refusal precedes dispatch and refunds launch/resume reservations", async () => {
	const { owner, coordinator } = await tree();
	let malformed = true;
	coordinator.events.on("session:launch", (payload: unknown) => {
		if (malformed) (payload as { args: string[] }).args.push("--tools");
	});
	await assert.rejects(launch(coordinator, "worker"), /nested tool ceiling/);
	assert.deepEqual(treeCounts(readTree(owner.parent)), { concurrent: 1, lifetime: 1 });
	assert.equal(readTree(owner.parent).entries.at(-1)?.phase, "not-started");
	malformed = false;
	const record = await launch(coordinator, "worker");
	header(record, root);
	owner.tmux.windows.delete(record.windowId);
	malformed = true;
	await assert.rejects(
		coordinator.toolCall("delegation_resume", { id: record.id, task: "continue" }),
		/nested tool ceiling/,
	);
	assert.deepEqual(treeCounts(readTree(owner.parent)), { concurrent: 1, lifetime: 2 });
	assert.equal(readTree(owner.parent).entries.at(-1)?.phase, "not-started");
	assert.equal(owner.tmux.opened.length, 2);
});
