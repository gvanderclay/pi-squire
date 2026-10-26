// Resuming an exited delegate: `delegation_resume` and `/delegate-resume`. The
// session file is a hand-written header (and assistant message); tmux and the
// mailbox are the harness's fakes.

import assert from "node:assert/strict";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { after, beforeEach, test } from "node:test";

import {
	agentDir,
	agentFile,
	cleanup,
	type Entry,
	resetRoot,
	root,
	session,
	sessionDir,
	type ToolResult,
	writeAgent,
} from "./harness.ts";

type Session = ReturnType<typeof session>;

const LIMITS = join(agentDir, "pi-squire-limits.json");

beforeEach(() => {
	resetRoot();
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(LIMITS, "[]");
});
after(() => cleanup());

/** A delegation that started and whose window has since exited, with its session file written. */
type Exited = {
	s: Session;
	id: string;
	name: string;
	windowId: string;
	requestId: string;
	file: string;
	cwd: string;
};

const AGENT = { description: "Looks things up", model: "alpha/fast-model", thinking: "low" };

/** Write a Pi session file: its header, then one assistant message from `model` when given. */
function writeSession(file: string, id: string, cwd: string, model?: string): void {
	mkdirSync(sessionDir, { recursive: true });
	const header = { type: "session", version: 3, id, timestamp: "2026-10-26T00:00:00.000Z", cwd };
	const lines = [JSON.stringify(header)];
	if (model !== undefined) {
		const [provider, name] = model.split("/");
		lines.push(JSON.stringify({ type: "message", message: { role: "assistant", provider, model: name, content: [] } }));
	}
	writeFileSync(file, `${lines.join("\n")}\n`);
}

/**
 * Start a delegation through `/delegate`, write its session file and let its
 * window exit: `gone` removes the window, `exited` leaves it with a dead pane.
 */
async function exitedDelegate(
	options: { window?: "gone" | "exited" | "open"; model?: string; fallback?: string; cwd?: string } = {},
): Promise<Exited> {
	writeAgent(
		"scout",
		agentFile({ ...AGENT, ...(options.fallback === undefined ? {} : { fallback: options.fallback }) }),
	);
	const s = session();
	await s.start();
	await s.delegate("scout --label first look into it");
	const entry = s.entries[0].data as { id: string; windowId: string; windowName: string; requestId: string };
	const cwd = options.cwd ?? root;
	const file = join(sessionDir, `20261026T000000_${entry.id}.jsonl`);
	writeSession(file, entry.id, cwd, options.model);
	if (options.window === "exited") s.tmux.exit(entry.windowId);
	else if (options.window !== "open") s.tmux.windows.delete(entry.windowId);
	return { s, id: entry.id, name: entry.windowName, windowId: entry.windowId, requestId: entry.requestId, file, cwd };
}

const resume = (s: Session, params: Record<string, unknown>): Promise<ToolResult> =>
	s.toolCall("delegation_resume", params);

const resumeError = async (s: Session, params: Record<string, unknown>): Promise<string> => {
	try {
		await resume(s, params);
	} catch (err) {
		return (err as Error).message;
	}
	throw new Error("the resume was not refused");
};

/** The started records the session holds, in order. */
const starts = (s: Session) =>
	s.entries.filter((entry) => typeof entry.data.requestId === "string").map((entry) => entry.data);

/** A reply envelope as the mailbox emits it. */
function reply(s: Session, from: string, requestId: string, id = `reply-${requestId}`) {
	return {
		envelope: { id, from, to: s.parent, in_reply_to: [requestId], status: "done", ts: "", body: "the answer" },
		path: "/mail/cur/reply.json",
		requests: [],
		handled: false,
	};
}

const resultMessages = (s: Session) =>
	s.sent.filter((m) => /^\[delegate\] Result from/.test(String(m.message.content)));

test("the resume opens the session file with --session, never --session-id or --name", async () => {
	const d = await exitedDelegate();
	const launches: {
		args: string[];
		env: Record<string, string>;
		agent: string;
		cwd: string;
		toolCallId: string | undefined;
	}[] = [];
	d.s.events.on("session:launch", (payload) => launches.push(payload as (typeof launches)[number]));
	const result = await resume(d.s, { id: d.id, task: "now the second part" });
	const [, window] = d.s.tmux.opened;
	const { argv } = window;
	assert.equal(argv[argv.indexOf("--session") + 1], d.file);
	assert.ok(!argv.includes("--session-id"));
	assert.ok(!argv.includes("--name"));
	assert.equal(argv[argv.indexOf("--session-dir") + 1], sessionDir);
	assert.equal(argv[argv.indexOf("--model") + 1], "alpha/fast-model");
	assert.equal(argv[argv.indexOf("--thinking") + 1], "low");
	assert.ok(argv.includes("--no-approve"));
	assert.equal(window.name, d.name);
	assert.equal(window.cwd, realpathSync(d.cwd));
	assert.equal(window.env.PI_DELEGATE_PARENT, d.s.parent);
	assert.equal(window.env.PI_DELEGATE_AUTO_EXIT, "1");
	const prompt = argv[argv.indexOf("--append-system-prompt") + 1];
	assert.ok(prompt.endsWith("prompt.md"));
	assert.equal(launches.length, 1, "the resume emits session:launch");
	assert.deepEqual(Object.keys(launches[0]).sort(), ["agent", "args", "cwd", "env", "toolCallId"]);
	assert.match(launches[0].toolCallId ?? "", /^call-\d+$/, "the resume passes its delegation_resume call id");
	assert.equal(launches[0].agent, "scout");
	assert.equal(launches[0].cwd, realpathSync(d.cwd));
	assert.match(result.content[0].text, new RegExp(`Resumed delegation ${d.id} as `));
	assert.match(d.s.notes.join("\n"), /resumed .* as /);
});

test("the new record has its own id, the old session id, and resumedFrom; mail goes to the session", async () => {
	const d = await exitedDelegate();
	const result = await resume(d.s, { id: d.id, task: "now the second part" });
	const details = result.structuredContent as { id: string; resumedFrom: string; outcome: string };
	assert.equal(details.outcome, "started");
	assert.equal(details.resumedFrom, d.id);
	assert.notEqual(details.id, d.id);
	const [, record] = starts(d.s);
	assert.equal(record.id, details.id);
	assert.equal(record.resumedFrom, d.id);
	assert.equal(record.sessionId, d.id);
	assert.equal(record.name, d.name);
	assert.equal(record.windowName, d.name);
	assert.equal(d.s.sendCalls.at(-1)?.to, d.id);
	assert.equal(d.s.sendCalls.at(-1)?.body, "now the second part");
	assert.notEqual(record.requestId, d.requestId);
});

test("the resume mails the task only after its window opened, and a failed send kills that window", async () => {
	const d = await exitedDelegate();
	const openAtSend: number[] = [];
	d.s.events.on("message:send", (data) => {
		openAtSend.push(d.s.tmux.opened.length);
		(data as { error?: string }).error = "mailbox: refused";
	});
	const error = await resumeError(d.s, { id: d.id, task: "now the second part" });
	assert.match(error, /could not send the task to .*mailbox: refused/);
	assert.deepEqual(openAtSend, [2], "the resumed window was open when the task was sent");
	const [, window] = d.s.tmux.opened;
	assert.ok(d.s.tmux.killed.includes(window.windowId), "the window with no task is killed");
	assert.equal(starts(d.s).length, 1, "no resumed delegation is recorded");
});

test("a resumed delegation the poll had not yet seen go is never reported closed without a result", async (t: TestContext) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	// The window is gone but no tick has run, so the old record is still counted as running.
	const d = await exitedDelegate();
	await resume(d.s, { id: d.id, task: "carry on" });
	t.mock.timers.tick(5000);
	for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
	const gone = d.s.sent.filter((m) => /closed without a result/.test(String(m.message.content)));
	assert.deepEqual(gone, []);
	// A late reply to the old request still reaches the parent.
	d.s.events.emit("message:inbound", reply(d.s, d.id, d.requestId));
	assert.equal(resultMessages(d.s).length, 1);
});

test("the resumed run's reply, from the old session id, makes the new record done and not the old one", async () => {
	const d = await exitedDelegate();
	await resume(d.s, { id: d.id, task: "again" });
	const [, record] = starts(d.s) as { id: string; requestId: string }[];
	d.s.events.emit("message:inbound", reply(d.s, d.id, record.requestId));
	const [message] = resultMessages(d.s);
	assert.match(
		String(message.message.content),
		new RegExp(`delegation ${record.id} \\(resumed from ${d.id}\\), request`),
	);
	assert.match(String(message.message.content), new RegExp(`Delegate session: ${d.file.replaceAll(".", "\\.")}`));
	const results = d.s.entries.filter((entry) => "result" in entry.data);
	assert.deepEqual(
		results.map((entry) => entry.data.id),
		[record.id],
	);
	const status = (await d.s.toolCall("delegation_status", {})).structuredContent as {
		delegations: { id: string; state: string; resumedFrom?: string }[];
	};
	const byId = Object.fromEntries(status.delegations.map((item) => [item.id, item]));
	assert.equal(byId[record.id].state, "done");
	assert.equal(byId[record.id].resumedFrom, d.id);
	assert.notEqual(byId[d.id].state, "done");
});

test("a late reply to the old request settles the old record only, also after a restore", async () => {
	const d = await exitedDelegate();
	await resume(d.s, { id: d.id, task: "again" });
	const [, record] = starts(d.s) as { id: string; requestId: string; windowId: string; windowName: string }[];
	const restored = session({ parent: d.s.parent, entries: structuredClone(d.s.entries) as Entry[] });
	restored.tmux.addWindow(record.windowId, record.windowName);
	await restored.start();
	restored.events.emit("message:inbound", reply(restored, d.id, d.requestId, "late"));
	assert.equal(resultMessages(restored).length, 1);
	const results = restored.entries.filter((entry) => "result" in entry.data && !("requestId" in entry.data));
	assert.deepEqual(
		results.map((entry) => entry.data.id),
		[d.id],
	);
	const status = (await restored.toolCall("delegation_status", { id: record.id })).structuredContent as {
		delegations: { state: string }[];
	};
	assert.equal(status.delegations[0].state, "running");
	// The restored resumed record still recognises its own reply.
	restored.events.emit("message:inbound", reply(restored, d.id, record.requestId, "second"));
	assert.equal(resultMessages(restored).length, 2);
});

test("status words resumed from and resumed as", async () => {
	const d = await exitedDelegate();
	const { id } = (await resume(d.s, { id: d.id, task: "again" })).structuredContent as { id: string };
	const text = (await d.s.toolCall("delegation_status", {})).content[0].text;
	assert.match(text, new RegExp(`  resumed from ${d.id}\\n`));
	assert.match(text, new RegExp(`  resumed as ${id}\\n`));
});

test("refused: an older record of a resumed chain, naming the newest", async () => {
	const d = await exitedDelegate();
	const { id } = (await resume(d.s, { id: d.id, task: "again" })).structuredContent as { id: string };
	assert.match(
		await resumeError(d.s, { id: d.id, task: "once more" }),
		new RegExp(`resume its newest delegation ${id}`),
	);
});

test("refused: an unknown id and a workspace attempt", async () => {
	const d = await exitedDelegate();
	assert.match(await resumeError(d.s, { id: "nope", task: "x" }), /no delegation "nope"; known: /);
	const attempt = {
		kind: "workspace-attempt",
		id: "attempt-1",
		parentId: "p",
		agent: "scout",
		model: "alpha/fast-model",
		thinking: "low",
		sessionDir,
		plan: {},
		attempt: { phase: "rolled-back", resources: { kind: "none" }, cause: "x" },
	};
	const s = session({ entries: [{ customType: "delegate", data: attempt }] });
	await s.start();
	assert.match(await resumeError(s, { id: "attempt-1", task: "x" }), /is a workspace attempt/);
	assert.equal(s.tmux.opened.length, 0);
});

test("refused: a running delegation, a still-open window after a result, and an unaskable tmux", async () => {
	const running = await exitedDelegate({ window: "open" });
	assert.match(await resumeError(running.s, { id: running.id, task: "x" }), /is running; send it a message/);

	// A result arrived but the window stays open: its Pi may still be running.
	running.s.events.emit("message:inbound", reply(running.s, running.id, running.requestId));
	assert.match(await resumeError(running.s, { id: running.id, task: "x" }), /window .* is still open/);

	const unknown = await exitedDelegate();
	unknown.s.tmux.failList = "no server running";
	assert.match(await resumeError(unknown.s, { id: unknown.id, task: "x" }), /could not ask tmux/);
	for (const d of [running, unknown]) assert.equal(d.s.tmux.opened.length, 1, "nothing was opened");
	assert.equal(unknown.s.sendCalls.length, 1, "no task was mailed");
});

test("refused: a missing session file, a header without a cwd and a missing working directory", async () => {
	const missing = await exitedDelegate();
	rmSync(missing.file);
	assert.match(await resumeError(missing.s, { id: missing.id, task: "x" }), /no session file for session .* was found/);

	const headless = await exitedDelegate();
	writeFileSync(headless.file, `${JSON.stringify({ type: "session", id: headless.id })}\n`);
	assert.match(await resumeError(headless.s, { id: headless.id, task: "x" }), /could not read a working directory/);

	const gone = await exitedDelegate({ cwd: join(root, "removed-worktree") });
	const message = await resumeError(gone.s, { id: gone.id, task: "x" });
	assert.match(message, /removed-worktree, which no longer exists, so it is not resumable/);
	for (const d of [missing, headless, gone]) {
		assert.equal(d.s.tmux.opened.length, 1);
		assert.equal(d.s.sendCalls.length, 1);
	}
});

test("refused: an agent no longer in the roster", async () => {
	const d = await exitedDelegate();
	rmSync(join(root, "agent", "squire", "agents", "scout"), { recursive: true });
	writeAgent("other", agentFile(AGENT));
	assert.match(await resumeError(d.s, { id: d.id, task: "x" }), /agent "scout" is no longer in the roster/);
});

test("refused: a concurrent resume of the same delegation, and the guard is released afterwards", async () => {
	const d = await exitedDelegate();
	const first = resume(d.s, { id: d.id, task: "one" });
	const second = resumeError(d.s, { id: d.id, task: "two" });
	const [done, refusal] = await Promise.all([
		first.then(
			() => "ok",
			(err: Error) => err.message,
		),
		second,
	]);
	assert.equal(done, "ok");
	assert.match(refusal, /already being resumed|resume its newest/);
	assert.equal(d.s.tmux.opened.length, 2, "one resume opened one window");

	// A failed resume releases the guard.
	const failing = await exitedDelegate();
	failing.s.tmux.failOpen = "no space";
	assert.match(await resumeError(failing.s, { id: failing.id, task: "x" }), /could not open window .* no space/);
	failing.s.tmux.failOpen = undefined;
	await resume(failing.s, { id: failing.id, task: "x again" });
	assert.equal(starts(failing.s).length, 2);
});

test("an exited window of the delegate is killed first; a window that only shares its name is ignored", async () => {
	const exited = await exitedDelegate({ window: "exited" });
	await resume(exited.s, { id: exited.id, task: "again" });
	assert.deepEqual(exited.s.tmux.killed, [exited.windowId]);

	const foreign = await exitedDelegate();
	foreign.s.tmux.addWindow("@99", foreign.name);
	await resume(foreign.s, { id: foreign.id, task: "again" });
	assert.deepEqual(foreign.s.tmux.killed, []);
	assert.ok(foreign.s.tmux.windows.has("@99"));
});

test("without a model it continues where the delegate finished, and moves on past a marked model", async () => {
	const d = await exitedDelegate({ model: "alpha/deep-model", fallback: "beta/other-model" });
	const { model } = (await resume(d.s, { id: d.id, task: "again" })).structuredContent as { model: string };
	assert.equal(model, "alpha/deep-model", "finishedModel, not the agent's default");
	const argv = d.s.tmux.opened[1].argv;
	assert.equal(argv[argv.indexOf("--model") + 1], "alpha/deep-model");

	const marked = await exitedDelegate({ model: "alpha/deep-model", fallback: "beta/other-model" });
	const now = Date.now();
	writeFileSync(
		LIMITS,
		JSON.stringify([
			{
				scope: "alpha/deep-model",
				reason: "limit",
				recordedAt: now,
				clearsAt: now + 3_600_000,
				source: "reactive",
				hits: 1,
				delegations: [],
			},
		]),
	);
	const result = await resume(marked.s, { id: marked.id, task: "again" });
	const details = result.structuredContent as { model: string; skipped: { model: string }[] };
	assert.equal(details.model, "beta/other-model");
	assert.deepEqual(
		details.skipped.map((item) => item.model),
		["alpha/deep-model"],
	);
	assert.match(result.content[0].text, /Used fallback beta\/other-model because alpha\/deep-model is usage-limited/);
	assert.equal(marked.s.tmux.opened[1].env.PI_DELEGATE_FALLBACK, undefined);
});

test("an explicit model is used alone and never substituted", async () => {
	const d = await exitedDelegate({ model: "alpha/deep-model", fallback: "beta/other-model" });
	const now = Date.now();
	writeFileSync(
		LIMITS,
		JSON.stringify([
			{
				scope: "beta/other-model",
				reason: "limit",
				recordedAt: now,
				clearsAt: now + 3_600_000,
				source: "reactive",
				hits: 1,
				delegations: [],
			},
		]),
	);
	assert.match(
		await resumeError(d.s, { id: d.id, task: "x", model: "beta/other-model" }),
		/beta\/other-model is usage-limited/,
	);
	assert.equal(d.s.tmux.opened.length, 1);
	assert.match(await resumeError(d.s, { id: d.id, task: "x", thinking: "loud" }), /unknown thinking level/);
	const ok = await resume(d.s, { id: d.id, task: "x", model: "alpha/fast-model", thinking: "high", auto_exit: false });
	assert.deepEqual(
		(({ model, thinking, autoExit }) => ({ model, thinking, autoExit }))(ok.structuredContent as never),
		{ model: "alpha/fast-model", thinking: "high", autoExit: false },
	);
	const { argv, env } = d.s.tmux.opened[1];
	assert.equal(argv[argv.indexOf("--model") + 1], "alpha/fast-model");
	assert.equal(env.PI_DELEGATE_AUTO_EXIT, "0");
});

test("the fallbacks after the chosen model are passed on for the delegate's own limit handling", async () => {
	const d = await exitedDelegate({ model: "alpha/deep-model", fallback: "beta/other-model, alpha/deep-model" });
	await resume(d.s, { id: d.id, task: "again" });
	assert.equal(d.s.tmux.opened[1].env.PI_DELEGATE_FALLBACK, "beta/other-model");
});

test("old records without sessionId match replies, find sessions and usage-limit marks by id", async () => {
	const d = await exitedDelegate({ window: "open" });
	const now = Date.now();
	writeFileSync(
		LIMITS,
		JSON.stringify([
			{
				scope: "alpha",
				reason: "limit",
				recordedAt: now,
				clearsAt: now + 3_600_000,
				source: "reactive",
				hits: 1,
				delegations: [d.id],
			},
		]),
	);
	assert.equal(starts(d.s)[0].sessionId, undefined);
	d.s.events.emit("message:inbound", {
		...reply(d.s, d.id, d.requestId),
		envelope: { ...reply(d.s, d.id, d.requestId).envelope, status: "failed" },
	});
	const [message] = resultMessages(d.s);
	assert.match(String(message.message.content), /Usage limit: the delegate hit a usage limit on provider alpha/);
	assert.match(String(message.message.content), new RegExp(`Delegate session: ${d.file.replaceAll(".", "\\.")}`));
	assert.doesNotMatch(String(message.message.content), /resumed from/);
});

test("a resumed record's marks are matched by session id", async () => {
	const d = await exitedDelegate();
	await resume(d.s, { id: d.id, task: "again" });
	const [, record] = starts(d.s) as { id: string; requestId: string }[];
	const now = Date.now();
	writeFileSync(
		LIMITS,
		JSON.stringify([
			{
				scope: "alpha",
				reason: "limit",
				recordedAt: now,
				clearsAt: now + 3_600_000,
				source: "reactive",
				hits: 1,
				delegations: [d.id],
			},
		]),
	);
	d.s.events.emit("message:inbound", {
		...reply(d.s, d.id, record.requestId),
		envelope: { ...reply(d.s, d.id, record.requestId).envelope, status: "failed" },
	});
	assert.match(String(resultMessages(d.s)[0].message.content), /Usage limit: the delegate hit a usage limit/);
});

test("a delegate killed mid-turn is resumable, and its gone message points to delegation_resume", async (t: TestContext) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const d = await exitedDelegate({ window: "open" });
	d.s.tmux.windows.clear();
	t.mock.timers.tick(5000);
	for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
	const gone = d.s.sent.filter((m) => /closed without a result/.test(String(m.message.content)));
	assert.equal(gone.length, 1);
	assert.match(String(gone[0].message.content), /call delegation_resume with this delegation's id/);
	// The session file has no final assistant message: no last-turn guard stops the resume.
	const result = await resume(d.s, { id: d.id, task: "carry on" });
	assert.equal((result.structuredContent as { resumedFrom: string }).resumedFrom, d.id);
});

test("the resumed delegate's window is named like the first and the tool is registered as documented", async () => {
	const d = await exitedDelegate();
	assert.ok(d.s.tools().includes("delegation_resume"));
	const tool = d.s.tool("delegation_resume");
	assert.deepEqual(tool.annotations, {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true,
	});
	assert.deepEqual((tool.parameters as { required: string[] }).required.sort(), ["id", "task"]);
	assert.match(d.s.tool("delegate").description, /delegation_resume/);
	assert.ok(d.s.commands().includes("delegate-resume"));
});

test("/delegate-resume parses flags and the task, and reports refusals", async () => {
	const d = await exitedDelegate();
	await d.s.command(
		"delegate-resume",
		`${d.id} --model alpha/deep-model --thinking high --no-auto-exit  do it   twice `,
	);
	assert.deepEqual(d.s.errors, []);
	const { argv, env } = d.s.tmux.opened[1];
	assert.equal(argv[argv.indexOf("--model") + 1], "alpha/deep-model");
	assert.equal(argv[argv.indexOf("--thinking") + 1], "high");
	assert.equal(env.PI_DELEGATE_AUTO_EXIT, "0");
	assert.equal(d.s.sendCalls.at(-1)?.body, "do it   twice");
	assert.match(d.s.notes.join("\n"), new RegExp(`delegate: resumed ${d.id} as `));

	const fail = async (args: string) => {
		d.s.errors.length = 0;
		await d.s.command("delegate-resume", args);
		return d.s.errors.join("\n");
	};
	// No arguments now opens the resume picker, not a usage error (`test/new-delegate.test.ts`).
	assert.equal(await fail(""), "");
	assert.match(await fail("--model x task"), /the first argument is the delegation id/);
	assert.match(await fail(`${d.id}`), /a task is required after the id and flags/);
	assert.match(await fail(`${d.id} --cwd /tmp task`), /unknown flag --cwd/);
	assert.match(await fail(`${d.id} --model`), /--model needs a value; usage: \/delegate-resume/);
	assert.match(await fail(`${d.id} task`), /already was resumed|was already resumed/);
	assert.equal(d.s.tmux.opened.length, 2);
});

test("/delegate-resume completes resumable ids, flags, models and thinking levels", async () => {
	const d = await exitedDelegate();
	await d.s.start();
	const again = await exitedDelegate();
	const ids = (await d.s.completionsFor("delegate-resume", ""))?.map((item) => item.value);
	assert.deepEqual(ids, [d.id]);
	assert.deepEqual(await d.s.completionsFor("delegate-resume", "zzz"), null);
	await resume(again.s, { id: again.id, task: "again" });
	const newest = (await again.s.completionsFor("delegate-resume", ""))?.map((item) => item.value) ?? [];
	assert.ok(!newest.includes(again.id), "an id that was resumed is no longer offered");
	assert.equal(newest.length, 1);
	assert.deepEqual(
		(await d.s.completionsFor("delegate-resume", `${d.id} --`))?.map((item) => item.label),
		["--model", "--thinking", "--auto-exit", "--no-auto-exit"],
	);
	assert.deepEqual(
		(await d.s.completionsFor("delegate-resume", `${d.id} --model alpha/f`))?.map((item) => item.value),
		[`${d.id} --model alpha/fast-model`],
	);
	assert.deepEqual(
		(await d.s.completionsFor("delegate-resume", `${d.id} --thinking hi`))?.map((item) => item.label),
		["high"],
	);
});
