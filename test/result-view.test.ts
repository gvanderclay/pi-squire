// The model a delegation finished on, read from the delegate's session file when
// its result arrives, and the structured details the result and gone messages
// carry for the renderer. Driven through the harness: a fake delegate session
// file in the session directory and a reply on `message:inbound`.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { after, beforeEach, test } from "node:test";
import { readChildRecords } from "../src/child-tasks.ts";
import type { SessionUsage } from "../src/session-usage.ts";
import { childState } from "./child-state.ts";

import { agentDir, agentFile, cleanup, resetRoot, root, session, sessionDir, writeAgent } from "./harness.ts";

beforeEach(() => resetRoot());
after(() => cleanup());

type Session = ReturnType<typeof session>;

async function started(entries?: Session["entries"], parent?: string) {
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
	const s = session(entries === undefined ? {} : { entries, parent });
	await s.start();
	if (entries === undefined) await s.delegate("scout look into it");
	return s;
}

const delegationId = (s: Session) => (s.entries[0].data as { id: string }).id;
const requestId = (s: Session) => (s.entries[0].data as { requestId: string }).requestId;

/** A delegate session file whose lines are `lines`, as JSON. */
function writeDelegateSession(s: Session, lines: unknown[]): string {
	mkdirSync(sessionDir, { recursive: true });
	const file = join(sessionDir, `20260929T000000_${delegationId(s)}.jsonl`);
	writeFileSync(file, lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n"));
	return file;
}

const assistant = (provider: string, model: string) => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text: "hi" }], provider, model },
});

function deliver(s: Session, status = "done", body = "the answer", task?: string) {
	s.events.emit("message:inbound", {
		envelope: {
			id: `reply-${status}`,
			from: delegationId(s),
			to: s.parent,
			in_reply_to: [requestId(s)],
			status,
			ts: "",
			body,
		},
		path: "/mail/cur/reply.json",
		requests: task === undefined ? [] : [{ envelope: { id: requestId(s), body: task }, path: "/mail/sent/task.json" }],
		handled: false,
	});
}

const resultMessage = (s: Session) => {
	const found = s.sent.find((m) => /^\[delegate\] Result from/.test(String(m.message.content)));
	assert.ok(found, "a result message was sent");
	return found.message as { content: string; details?: Record<string, unknown> };
};
const firstLine = (s: Session) => resultMessage(s).content.split("\n")[0];
const statusTool = (s: Session) => s.toolCall("delegation_status", {});

const USAGE: SessionUsage = {
	turns: 2,
	input: 99_000,
	output: 9200,
	cacheRead: 1_700_000,
	cacheWrite: 1000,
	cost: 0.39,
	contextTokens: 181_000,
};
const USAGE_LINE = "Usage: 2 turns, 1.8M tokens in (1.7M cached), 9.2k out, $0.39; context at finish 181k.";
const USAGE_STATUS = `  usage: ${USAGE_LINE.slice("Usage: ".length)}`;

function writeUsageSession(s: Session): string {
	return writeDelegateSession(s, [
		{
			...assistant("alpha", "fast-model"),
			message: {
				role: "assistant",
				usage: {
					input: 89_000,
					output: 4600,
					cacheRead: 1_530_000,
					cacheWrite: 0,
					cost: { total: 0.2 },
				},
			},
		},
		{
			...assistant("alpha", "fast-model"),
			message: {
				role: "assistant",
				usage: {
					input: 10_000,
					output: 4600,
					cacheRead: 170_000,
					cacheWrite: 1000,
					cost: { total: 0.19 },
				},
			},
		},
	]);
}

test("result usage stays in the header outside the body budget; full status reads live then keeps the settled value", async () => {
	const s = await started();
	const file = writeUsageSession(s);
	const id = delegationId(s);
	for (const params of [{}, { id }]) {
		const live = await s.toolCall("delegation_status", params);
		assert.ok(live.content[0].text.includes(USAGE_STATUS), live.content[0].text);
		assert.deepEqual(
			(live.structuredContent as { delegations: { usage?: SessionUsage }[] }).delegations[0].usage,
			USAGE,
		);
	}
	const body = `START-${"x".repeat(30_000)}-END`;
	deliver(s, "done", body);
	const message = resultMessage(s);
	assert.equal(message.content.split("\n")[2], USAGE_LINE);
	assert.deepEqual(message.details?.usage, USAGE);
	assert.match(message.content, /KiB omitted here/);
	assert.ok(message.content.endsWith("-END"));
	const stored = readChildRecords(s.parent)[0];
	assert.ok("result" in stored);
	assert.deepEqual(stored.result?.usage, USAGE);
	rmSync(file); // A settled file disappearing must not lose or recompute the saved usage.
	const full = await s.toolCall("delegation_status", { id });
	assert.ok(full.content[0].text.includes(USAGE_STATUS), full.content[0].text);
	const compact = await statusTool(s);
	assert.doesNotMatch(compact.content[0].text, / {2}usage:/);
	for (const status of [full, compact])
		assert.deepEqual(
			(status.structuredContent as { delegations: { usage?: SessionUsage }[] }).delegations[0].usage,
			USAGE,
		);
	await s.shutdown();
});

test("missing session usage adds neither a result line nor a full status line", async () => {
	const s = await started();
	deliver(s);
	assert.doesNotMatch(resultMessage(s).content, /^Usage:/m);
	assert.equal(Object.hasOwn(resultMessage(s).details ?? {}, "usage"), false);
	const full = await s.toolCall("delegation_status", { id: delegationId(s) });
	assert.doesNotMatch(full.content[0].text, / {2}usage:/);
	await s.shutdown();
});

for (const source of ["local", "transcript"] as const) {
	test(`stored usage survives ${source} restoration without reading the session again`, async () => {
		const s = await started();
		const file = writeUsageSession(s);
		deliver(s);
		await s.shutdown();
		rmSync(file);
		if (source === "transcript") rmSync(join(agentDir, "squire", "child-tasks", `${s.parent}.json`));
		const reopened = await started(s.entries, s.parent);
		const full = await reopened.toolCall("delegation_status", { id: delegationId(s) });
		assert.ok(full.content[0].text.includes(USAGE_STATUS), full.content[0].text);
		assert.deepEqual(
			(full.structuredContent as { delegations: { usage?: SessionUsage }[] }).delegations[0].usage,
			USAGE,
		);
		await reopened.shutdown();
	});
}

for (const source of ["local", "terminal", "start"] as const) {
	for (const usage of [null, "wrong", {}, { ...USAGE, turns: -1 }, { ...USAGE, cost: null }]) {
		test(`malformed ${source} usage ${JSON.stringify(usage)} blocks restoration`, async () => {
			const s = await started();
			deliver(s);
			await s.shutdown();
			const path = join(agentDir, "squire", "child-tasks", `${s.parent}.json`);
			const entries = structuredClone(s.entries);
			if (source === "local") {
				const saved = JSON.parse(readFileSync(path, "utf8"));
				saved.state.records[0].result.usage = usage;
				writeFileSync(path, JSON.stringify(saved));
			} else {
				rmSync(path);
				const result = { ...(entries[1].data.result as Record<string, unknown>), usage };
				if (source === "terminal") entries[1].data.result = result;
				else {
					entries[0].data.result = result;
					entries.splice(1);
				}
			}
			const reopened = await started(entries, s.parent);
			assert.ok(
				reopened.errors.some((error) => error.includes("invalid delegation usage")),
				reopened.errors.join("\n"),
			);
			await assert.rejects(reopened.toolCall("delegate", { agent: "scout", task: "new work" }), /restoration failed/);
			await reopened.shutdown();
		});
	}
}

test("a delegate that finished on another model is named launched → finished in the text, details and status", async () => {
	const s = await started();
	writeDelegateSession(s, [
		{ type: "session", id: delegationId(s) },
		assistant("alpha", "fast-model"),
		{ type: "model_change", provider: "beta", modelId: "slow-model" },
		assistant("beta", "slow-model"),
		{ type: "message", message: { role: "user", content: "later" } },
	]);
	deliver(s);
	assert.equal(
		firstLine(s),
		`[delegate] Result from scout (alpha/fast-model → beta/slow-model), delegation ${delegationId(s)}, request ${requestId(s)}.`,
	);
	const details = resultMessage(s).details;
	assert.equal(details?.model, "alpha/fast-model");
	assert.equal(details?.finishedModel, "beta/slow-model");
	const status = await statusTool(s);
	assert.match(status.content[0].text, /scout \(alpha\/fast-model → beta\/slow-model, thinking low\)/);
	const delegation = (status.details as { delegations: Record<string, unknown>[] }).delegations[0];
	assert.equal(delegation.model, "alpha/fast-model");
	assert.equal(delegation.finishedModel, "beta/slow-model");
});

test("the finishing model survives a resume", async () => {
	const s = await started();
	writeDelegateSession(s, [assistant("beta", "slow-model")]);
	deliver(s);
	await s.shutdown();
	const resumed = await started(s.entries, s.parent);
	assert.match((await statusTool(resumed)).content[0].text, /alpha\/fast-model → beta\/slow-model/);
});

test("a delegate that finished on its launch model shows the launch model alone", async () => {
	const s = await started();
	writeDelegateSession(s, [assistant("alpha", "fast-model")]);
	deliver(s);
	assert.match(firstLine(s), /^\[delegate\] Result from scout \(alpha\/fast-model\), delegation/);
	assert.match((await statusTool(s)).content[0].text, /scout \(alpha\/fast-model, thinking low\)/);
});

test("with no session file, or one with no assistant message or bad lines, the launch model shows alone", async (t: TestContext) => {
	await t.test("no file", async () => {
		const s = await started();
		deliver(s);
		assert.match(firstLine(s), /\(alpha\/fast-model\), delegation/);
		assert.equal(resultMessage(s).details?.finishedModel, undefined);
	});
	await t.test("no assistant message, one unparseable line", async () => {
		resetRoot();
		const s = await started();
		writeDelegateSession(s, ["{not json", { type: "message", message: { role: "user", content: "x" } }]);
		deliver(s);
		assert.match(firstLine(s), /\(alpha\/fast-model\), delegation/);
	});
});

test("a bad line after the last assistant message does not hide it", async () => {
	const s = await started();
	writeDelegateSession(s, [assistant("beta", "slow-model"), "{truncated"]);
	deliver(s);
	assert.match(firstLine(s), /\(alpha\/fast-model → beta\/slow-model\)/);
});

test("a result message carries the details its view is drawn from", async () => {
	const s = await started();
	const file = writeDelegateSession(s, [assistant("alpha", "fast-model")]);
	deliver(s, "failed", "line one\nline two");
	assert.deepEqual(resultMessage(s).details, {
		kind: "result",
		status: "failed",
		name: `scout-${delegationId(s).slice(0, 8)}`,
		agent: "scout",
		model: "alpha/fast-model",
		finishedModel: "alpha/fast-model",
		id: delegationId(s),
		requestId: requestId(s),
		envelopePath: "/mail/cur/reply.json",
		sessionPath: file,
		cwd: root,
		sessionDir,
		// The harness root is a temporary directory outside any Git checkout.
		workspace: { mode: "inherited", cwd: root, git: { kind: "non-git" } },
		task: { note: `[delegate] The task ${requestId(s)} has no copy in sent/; only its id is known.` },
		body: "line one\nline two",
		workspaceSnapshot: { kind: "non-git" },
	});
});

test("emitted completion messages preserve long results and errors without quoting long tasks", async (t) => {
	for (const status of ["done", "failed", "stopped"]) {
		await t.test(status, async () => {
			resetRoot();
			const s = await started();
			const file = writeDelegateSession(s, [assistant("alpha", "fast-model")]);
			const task = "Inspect every checkout and report the failing command.\n".repeat(80);
			// 120 findings is about 11.7 KB, inside the 16 KiB result body budget, so the body arrives whole.
			const body = [
				"# Checkout findings",
				...Array.from(
					{ length: 120 },
					(_, index) =>
						`Finding ${index}: src/module-${index}.ts failed its assertion; retain the command output and repair advice.`,
				),
				"Error: verification failed\nCommand: pnpm check\nExit status: 1\nNext action: repair the reported assertion.",
			].join("\n");
			deliver(s, status, body, task);
			const message = resultMessage(s);
			assert.equal(message.content.split("\n\n").slice(1).join("\n\n"), body);
			assert.equal(message.details?.body, body);
			assert.match(message.content, new RegExp(`^Status: ${status}$`, "m"));
			assert.match(message.content, /^Task: \/mail\/sent\/task.json$/m);
			assert.doesNotMatch(message.content, /Task, quoted|> Inspect|Task cut|^Workspace:/m);
			assert.ok(message.content.includes(`Working directory: ${root}`));
			assert.ok(message.content.includes("Checkout when the result arrived: not a Git checkout"));
			assert.ok(message.content.includes("Envelope: /mail/cur/reply.json"));
			assert.ok(message.content.includes(`Delegate session: ${file}`));
			const taskDetails = message.details?.task as { text: string; path: string };
			assert.ok(taskDetails.text.startsWith(task.slice(0, 100)));
			assert.match(taskDetails.text, /Task cut at 2 KiB/);
			assert.equal(taskDetails.path, "/mail/sent/task.json");
			assert.deepEqual(message.details?.workspaceSnapshot, { kind: "non-git" });
		});
	}
});

test("a completion for a legacy launch keeps missing-task and unknown-checkout diagnostics", async () => {
	const s = await started();
	const legacy = structuredClone(s.entries.slice(0, 1));
	delete legacy[0].data.cwd;
	delete legacy[0].data.sessionDir;
	delete legacy[0].data.workspace;
	await s.shutdown();
	rmSync(join(agentDir, "squire", "child-tasks", `${encodeURIComponent(s.parent)}.json`));
	const resumed = await started(legacy, s.parent);
	const body = "Error: the old task could not complete.\nNo launch directory was recorded.";
	deliver(resumed, "failed", body);
	const message = resultMessage(resumed);
	assert.ok(
		message.content.includes(`[delegate] The task ${requestId(resumed)} has no copy in sent/; only its id is known.`),
	);
	assert.match(message.content, /Working directory: unknown \(not recorded\)/);
	assert.match(message.content, /Checkout when the result arrived: Git state unknown/);
	assert.ok(message.content.endsWith(`\n\n${body}`));
	assert.equal(message.details?.cwd, undefined);
	assert.equal(message.details?.workspace, undefined);
	const snapshot = message.details?.workspaceSnapshot as { kind: string; reason: string };
	assert.equal(snapshot.kind, "unknown");
	assert.ok(message.content.includes(snapshot.reason));
});

test("recovery replays saved legacy result text without rewriting it or filling a missing snapshot", async () => {
	const s = await started();
	deliver(s, "done", "The saved answer.", "The original task.");
	const path = join(agentDir, "squire", "child-tasks", `${encodeURIComponent(s.parent)}.json`);
	await s.shutdown();
	const state = childState(JSON.parse(readFileSync(path, "utf8"))) as {
		outcomes: { content: string; delivered?: boolean; details: Record<string, unknown> }[];
	};
	const outcome = state.outcomes[0];
	const legacyContent = resultMessage(s).content.replace(
		"Task: /mail/sent/task.json",
		"Task, quoted from /mail/sent/task.json:\n> The original task.",
	);
	outcome.content = legacyContent;
	outcome.delivered = false;
	delete outcome.details.workspaceSnapshot;
	writeFileSync(path, JSON.stringify(state));
	const resumed = await started(s.entries, s.parent);
	await new Promise((resolve) => setImmediate(resolve));
	const message = resultMessage(resumed);
	assert.equal(message.content, legacyContent);
	assert.equal(message.details?.workspaceSnapshot, undefined);
	assert.deepEqual(message.details?.task, { text: "The original task.", path: "/mail/sent/task.json" });
	assert.equal(message.details?.body, "The saved answer.");
});

test("a gone message carries details of kind gone with the finishing model", async (t: TestContext) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const s = await started();
	writeDelegateSession(s, [assistant("beta", "slow-model")]);
	s.tmux.windows.clear();
	for (let i = 0; i < 4; i++) {
		t.mock.timers.tick(5000);
		for (let j = 0; j < 3; j++) await new Promise((resolve) => setImmediate(resolve));
	}
	const gone = s.sent.find((m) => /closed without a result/.test(String(m.message.content)));
	assert.ok(gone);
	const message = gone.message as { content: string; details?: Record<string, unknown> };
	assert.match(message.content, /\(scout, alpha\/fast-model → beta\/slow-model\)/);
	assert.equal(message.details?.kind, "gone");
	assert.equal(message.details?.finishedModel, "beta/slow-model");
	assert.equal(message.details?.name, `scout-${delegationId(s).slice(0, 8)}`);
});

test("result and gone messages name the recorded cwd, and a legacy record's cwd as unknown", async (t: TestContext) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const s = await started();
	deliver(s);
	assert.ok(resultMessage(s).content.includes(`Working directory: ${root}`), resultMessage(s).content);
	assert.equal(resultMessage(s).details?.cwd, root);

	const legacy = structuredClone(s.entries.slice(0, 1));
	delete legacy[0].data.cwd;
	delete legacy[0].data.sessionDir;
	await s.shutdown();
	// Deliberately simulate pre-durable legacy records, not overwrite newer local facts.
	rmSync(join(agentDir, "squire", "child-tasks", `${encodeURIComponent(s.parent)}.json`));
	const resumed = await started(legacy, s.parent);
	resumed.tmux.windows.clear();
	for (let j = 0; j < 4; j++) {
		t.mock.timers.tick(5000);
		for (let k = 0; k < 3; k++) await new Promise((resolve) => setImmediate(resolve));
	}
	const gone = resumed.sent.find((m) => /closed without a result/.test(String(m.message.content)));
	assert.ok(gone);
	const message = gone.message as { content: string; details?: Record<string, unknown> };
	assert.match(message.content, /Working directory: unknown \(not recorded\)/);
	assert.ok(!message.content.includes(`Working directory: ${root}`), message.content);
	assert.equal(message.details?.cwd, undefined);
});
