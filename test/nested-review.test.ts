// Regressions for ticket 03 review M1 (effective-role wording) and L1
// (durable child-task health before any launch/resume effects).
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import type { Delegation } from "../src/results.ts";
import { agentDir, agentFile, cleanup, resetRoot, root, sessionDir, writeAgent } from "./harness.ts";
import { envelopes, mailSession, request, scan } from "./mail-harness.ts";

type Session = ReturnType<typeof mailSession>;
const active: Session[] = [];
function instance(parent?: string): Session {
	const session = mailSession(parent ? { parent } : {});
	active.push(session);
	return session;
}
function settings(maxDepth: number): void {
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(join(agentDir, "squire", "settings.json"), JSON.stringify({ maxDepth }));
}
beforeEach(() => {
	resetRoot();
	writeAgent("coordinator", agentFile({ allow_nested_delegation: "[worker]" }));
	writeAgent("worker", agentFile({}));
});
afterEach(async () => {
	for (const session of active.splice(0)) await session.shutdown();
});
after(() => cleanup());

async function coordinator(start = true): Promise<{ parent: Session; child: Session }> {
	const parent = instance();
	await parent.start();
	await parent.toolCall("delegate", { agent: "coordinator", task: "coordinate" });
	const child = instance(parent.entries[0].data.id as string);
	if (start) {
		await child.start();
		scan(child);
	}
	return { parent, child };
}
function stateFile(session: Session): string {
	return join(agentDir, "squire", "child-tasks", `${encodeURIComponent(session.parent)}.json`);
}
function corrupt(session: Session): void {
	mkdirSync(join(agentDir, "squire", "child-tasks"), { recursive: true });
	writeFileSync(stateFile(session), "null");
}
const section = async (session: Session): Promise<string> =>
	(await session.prepare()).systemPromptOptions.sections.squire_delegate_task;

test("default-depth leaf preserves exact launch and takeover wording even with a nesting opt-in", async () => {
	// Missing maxDepth means 1, so the opted-in coordinator is effectively a leaf.
	const { parent, child } = await coordinator();
	const guidance = await section(child);
	assert.match(
		guidance,
		/Your final message reaches the session that started you automatically, so put your findings there;/,
	);
	assert.doesNotMatch(guidance, /children finish|intermediate runs/);
	const argv = parent.tmux.opened[0].argv;
	const launchPrompt = readFileSync(argv[argv.indexOf("--append-system-prompt") + 1], "utf8");
	assert.ok(
		launchPrompt.endsWith(guidance.replace("You are a delegate. ", "")),
		"per-run leaf paragraph is identical to the launch paragraph",
	);
	assert.equal(
		child.userMessages[0].text,
		`[delegate] Your task, from the session that started you (${parent.parent}). Your final message this turn goes back to it automatically.\n\ncoordinate`,
	);
});

test("leaf with no grant uses leaf wording below the depth limit", async () => {
	settings(2);
	const parent = instance();
	await parent.start();
	await parent.toolCall("delegate", { agent: "worker", task: "work" });
	const child = instance(parent.entries[0].data.id as string);
	await child.start();
	scan(child);
	assert.doesNotMatch(await section(child), /children finish|intermediate runs/);
	assert.match(child.userMessages[0].text, /Your final message this turn goes back to it automatically/);
	assert.doesNotMatch(child.userMessages[0].text, /child tasks/);
});

test("coordinator guidance and takeover share the current grant and grammatical final-report wording", async () => {
	settings(2);
	const { parent, child } = await coordinator();
	const guidance = await section(child);
	assert.match(
		guidance,
		/children finish.*intermediate runs send no task report\. Message .* before your final task report/,
	);
	assert.doesNotMatch(guidance, /report\. message|before then/);
	assert.match(child.userMessages[0].text, /after your child tasks finish and you process their outcomes/);
	writeAgent("coordinator", agentFile({}));
	assert.doesNotMatch(await section(child), /children finish|intermediate runs/);
	request(parent, child.parent, "new leaf task");
	scan(child);
	assert.match(child.userMessages.at(-1)?.text ?? "", /Your final message this turn goes back to it automatically/);
	assert.doesNotMatch(child.userMessages.at(-1)?.text ?? "", /child tasks/);
	writeAgent("coordinator", agentFile({ allow_nested_delegation: "[worker]" }));
	assert.match(await section(child), /intermediate runs send no task report/);
	request(parent, child.parent, "new coordinator task");
	scan(child);
	assert.match(child.userMessages.at(-1)?.text ?? "", /after your child tasks finish/);
});

test("corrupt root and coordinator facts refuse inherited, cwd and managed launches before effects", async () => {
	settings(2);
	const rootSession = instance();
	const { child } = await coordinator(false);
	const cwd = join(root, "existing");
	mkdirSync(cwd, { recursive: true });
	for (const session of [rootSession, child]) {
		corrupt(session);
		await session.start();
		let hooks = 0;
		session.events.on("session:launch", () => {
			hooks++;
		});
		for (const workspace of [{}, { cwd }, { worktree: "must-not-create" }]) {
			await assert.rejects(
				session.toolCall("delegate", { agent: "worker", task: "go", ...workspace }),
				/child tasks were unreadable/,
			);
		}
		await session.delegate("worker command bypass");
		assert.equal(session.tmux.opened.length, 0);
		assert.equal(session.entries.length, 0, "no workspace attempt or launched task recorded");
		assert.equal(envelopes(session.parent, "sent").length, 0);
		assert.equal(hooks, 0);
		assert.equal(readFileSync(stateFile(session), "utf8"), "null", "corrupt state was not erased by admission");
	}
});

test("a newly failing storage write refuses before a child exists and blocks subsequent launches", async () => {
	const session = instance();
	await session.start();
	mkdirSync(stateFile(session), { recursive: true }); // atomic replacement cannot rename a file onto a directory
	await assert.rejects(session.toolCall("delegate", { agent: "worker", task: "first" }), /EISDIR|directory/i);
	await assert.rejects(
		session.toolCall("delegate", { agent: "worker", task: "again", cwd: root }),
		/child task storage failed/,
	);
	assert.equal(session.tmux.opened.length, 0);
	assert.equal(envelopes(session.parent, "sent").length, 0);
	assert.equal(session.entries.length, 0);
});

async function resumeFixture(nested: boolean): Promise<{ owner: Session; record: Delegation }> {
	const owner = nested ? (await coordinator()).child : instance();
	await owner.start();
	await owner.toolCall("delegate", { agent: "worker", task: "first" });
	const record = owner.entries.at(-1)?.data as unknown as Delegation;
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(
		join(sessionDir, `worker_${record.id}.jsonl`),
		`${JSON.stringify({ type: "session", version: 3, id: record.id, timestamp: "", cwd: root })}\n`,
	);
	return { owner, record };
}

test("corrupt facts refuse root and nested resumes before killing an exited window or sending another task", async () => {
	settings(2);
	for (const nested of [false, true]) {
		const { owner, record } = await resumeFixture(nested);
		await owner.shutdown();
		corrupt(owner);
		const reopened = instance(owner.parent);
		reopened.entries.push(...owner.entries);
		reopened.tmux.windows.set(record.windowId, { name: record.windowName, exited: true, session: "test" });
		await reopened.start();
		const mailed = envelopes(owner.parent, "sent").length;
		await assert.rejects(
			reopened.toolCall("delegation_resume", { id: record.id, task: "again" }),
			/child tasks were unreadable/,
		);
		await reopened.command("delegate-resume", `${record.id} command bypass`);
		assert.match(reopened.errors.join("\n"), /child tasks were unreadable/);
		assert.equal(reopened.tmux.killed.length, 0);
		assert.equal(reopened.tmux.opened.length, 0);
		assert.equal(envelopes(owner.parent, "sent").length, mailed);
	}
});

test("a new preflight write failure refuses resume before killing its exited window", async () => {
	const { owner, record } = await resumeFixture(false);
	owner.tmux.exit(record.windowId);
	// The normal fact file's parent directory becomes inaccessible as a directory.
	const file = stateFile(owner);
	const temporary = `${file}.${process.pid}.tmp`;
	mkdirSync(temporary); // blocks the atomic snapshot write, without mutating recorded facts
	const mailed = envelopes(owner.parent, "sent").length;
	await assert.rejects(owner.toolCall("delegation_resume", { id: record.id, task: "again" }), /EISDIR|directory/i);
	assert.equal(owner.tmux.killed.length, 0);
	assert.equal(owner.tmux.opened.length, 1, "only the original worker exists");
	assert.equal(envelopes(owner.parent, "sent").length, mailed);
});

test("invalid maxDepth cannot leave a taken-over task seen but unprompted; admission still refuses", async () => {
	settings(2);
	const { parent, child } = await coordinator(false);
	writeFileSync(join(agentDir, "squire", "settings.json"), JSON.stringify({ maxDepth: "bad" }));
	await assert.rejects(child.start(), /invalid maxDepth/);
	scan(child);
	assert.equal(child.userMessages.length, 1, "role lookup failure still prompts the owned task");
	assert.match(child.userMessages[0].text, /Your final message this turn goes back to it automatically/);
	assert.doesNotMatch(child.userMessages[0].text, /child tasks/);
	const path = join(agentDir, "squire", "task-replies", `${encodeURIComponent(child.parent)}.json`);
	const state = JSON.parse(readFileSync(path, "utf8")) as { requests: { id: string; seen: boolean }[] };
	assert.equal(state.requests.length, 1);
	assert.equal(state.requests[0].seen, true);
	assert.doesNotMatch(child.errors.join("\n"), /Task ownership was not recorded/);
	await assert.rejects(child.toolCall("delegate", { agent: "worker", task: "still refused" }), /invalid maxDepth/);
	assert.equal(child.tmux.opened.length, 0);
	assert.equal(envelopes(child.parent, "sent").length, 0);
	assert.equal(envelopes(parent.parent, "sent").length, 1);
});
