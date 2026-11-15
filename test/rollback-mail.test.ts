// A definite not-opened failure rolls back the managed worktree, but a
// before-open host mailed the task first: the real provider keeps that request
// queued in the recipient's inbox, and Squire never recalls it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { agentFile, cleanup, resetRoot, root, writeAgent } from "./harness.ts";
import { envelopes, mailSession } from "./mail-harness.ts";

type Session = ReturnType<typeof mailSession>;
/** The fields of the rolled-back attempt record this test reads. */
type Attempt = { id: string; requestId?: string; attempt: { phase: string } };
const active: Session[] = [];

const git = (cwd: string, ...args: string[]): string =>
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

beforeEach(() => {
	resetRoot();
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
});
afterEach(async () => {
	for (const session of active.splice(0).reverse()) await session.shutdown();
});
after(() => cleanup());

test("a rolled-back managed launch leaves the mailed task queued and says it was not recalled", async () => {
	const base = mkdtempSync(join(root, "rollback-mail-"));
	const source = join(base, "repo");
	mkdirSync(source);
	git(source, "init", "-q", "-b", "main");
	writeFileSync(join(source, "tracked.txt"), "committed\n");
	git(source, "add", ".");
	git(source, "commit", "-q", "-m", "base");
	const s = mailSession({ cwd: source });
	active.push(s);
	await s.start();
	s.tmux.failOpen = "known failure";
	await assert.rejects(
		s.toolCall("delegate", { agent: "scout", task: "inspect the checkout", worktree: "retry/topic" }),
		/known failure/,
	);
	const attempt = s.entries.filter((entry) => entry.data.kind === "workspace-attempt").at(-1)?.data as
		| Attempt
		| undefined;
	assert.ok(attempt);
	assert.equal(attempt.attempt.phase, "rolled-back");
	assert.equal(typeof attempt.requestId, "string");
	assert.equal(existsSync(join(base, "repo-worktrees", "retry-topic")), false);
	assert.deepEqual(s.tmux.opened, [], "no delegate window was created");
	// The real provider wrote the envelope before the open; the rollback leaves it queued.
	const queued = envelopes(attempt.id, "new");
	assert.deepEqual(
		queued.map((mail) => mail.id),
		[attempt.requestId],
	);
	assert.equal(queued[0].to, attempt.id);
	assert.equal(queued[0].body, "inspect the checkout");
	assert.deepEqual(envelopes(attempt.id, "cur"), [], "nothing claimed or recalled the request");
	assert.ok(envelopes(s.parent, "sent").some((mail) => mail.id === attempt.requestId));
	const text = (await s.toolCall("delegation_status", { id: attempt.id })).content[0].text;
	assert.match(text, /state: rolled-back — no delegate window or agent was created, and no managed worktree remains/);
	assert.match(
		text,
		new RegExp(
			`request: ${attempt.requestId} \\(the task was mailed and was not recalled; no delegate window or agent was created\\)`,
		),
	);
	assert.doesNotMatch(text, /a window may still exist|the open failed|Paseo recovery target:/);
});
