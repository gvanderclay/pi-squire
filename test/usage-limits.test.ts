// Usage-limit marks: a delegate whose run ends on a usage-limit error records
// a mark in the agent directory; the parent, a separate session, then refuses
// to launch on a marked model until the mark clears. Time is a mock Date.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, type TestContext, test } from "node:test";

import type { ClaudeReading } from "../src/usage.ts";
import { FakeUsage, win } from "./fake-usage.ts";
import { agentDir, agentFile, cleanup, type RunFailure, resetRoot, session, writeAgent } from "./harness.ts";

const FILE = join(agentDir, "pi-squire-limits.json");
const START = Date.parse("2026-10-03T12:00:00.000Z");
const GO_LIMIT = '429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}';
const EXTRA = [
	{ provider: "opencode-go", id: "paid" },
	{ provider: "opencode-go", id: "space-free" },
	{ provider: "opencode-go", id: "zero", cost: { input: 0, output: 0 } },
];
const AGENT = { description: "Does it", thinking: "low" };

beforeEach(() => {
	resetRoot();
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(FILE, "[]");
	writeAgent("paid", agentFile({ ...AGENT, model: "opencode-go/paid" }));
	writeAgent("free", agentFile({ ...AGENT, model: "opencode-go/space-free" }));
	writeAgent("zero", agentFile({ ...AGENT, model: "opencode-go/zero" }));
	writeAgent("plain", agentFile({ ...AGENT, model: "alpha/fast-model" }));
});
after(() => cleanup());

/** A delegate in its own session ends one run on `errorMessage` for `model`. */
async function fail(errorMessage: string, model = "paid", id = "delegation-1") {
	const delegate = session({ parentEnv: "parent-x", parent: id, extraModels: EXTRA });
	delete process.env.PI_DELEGATE_PARENT;
	await delegate.start();
	await delegate.run("error", { errorMessage, provider: "opencode-go", model });
}

/** A fresh parent session, as another Pi session on the machine. */
const parent = () => session({ extraModels: EXTRA });

const marks = () =>
	JSON.parse(readFileSync(FILE, "utf8")) as { clearsAt: number; hits: number; scope: string; source: string }[];

function clock(t: TestContext) {
	t.mock.timers.enable({ apis: ["Date"], now: START });
	return (ms: number) => t.mock.timers.tick(ms);
}

test("a delegate's usage limit blocks the next launch on the provider, naming the clear time", async (t) => {
	clock(t);
	await fail(GO_LIMIT);
	const p = parent();
	await p.start();
	await assert.rejects(
		p.toolCall("delegate", { agent: "paid", task: "t" }),
		/opencode-go\/paid is usage-limited \(provider opencode-go\) until 2026-10-03T12:05:00\.000Z: 429: .*GoUsageLimitError.*\/delegate-clear/s,
	);
	await p.delegate("paid t");
	assert.match(p.errors.join("\n"), /usage-limited/);
	assert.deepEqual(p.tmux.opened, []);
	await p.delegate("plain t"); // another provider is untouched
	assert.equal(p.tmux.opened.length, 1);
});

test("the mark records its shape, delegation id and hit count", async (t) => {
	clock(t);
	await fail(GO_LIMIT, "paid", "delegation-9");
	assert.deepEqual(JSON.parse(readFileSync(FILE, "utf8")), [
		{
			scope: "opencode-go",
			reason: GO_LIMIT,
			recordedAt: START,
			clearsAt: START + 5 * 60_000,
			source: "reactive",
			hits: 1,
			delegations: ["delegation-9"],
		},
	]);
});

test("a free model still launches after a provider-wide limit", async (t) => {
	clock(t);
	await fail(GO_LIMIT);
	const p = parent();
	await p.delegate("free t");
	await p.delegate("zero t"); // free by registry cost
	assert.equal(p.tmux.opened.length, 2);
});

test("a free model's own limit marks only that model", async (t) => {
	clock(t);
	await fail(GO_LIMIT, "space-free");
	assert.equal(marks()[0].scope, "opencode-go/space-free");
	await fail('429: {"type":"FreeUsageLimitError"}', "paid", "d2");
	assert.deepEqual(
		marks()
			.map((mark) => mark.scope)
			.sort(),
		["opencode-go/paid", "opencode-go/space-free"],
	);
	const p = parent();
	await p.delegate("free t");
	assert.match(p.errors.join("\n"), /model opencode-go\/space-free/);
	await p.delegate("zero t");
	assert.equal(p.tmux.opened.length, 1);
});

test("overloaded and 5xx errors record no mark", async (t) => {
	clock(t);
	await fail('529: {"type":"overloaded_error","message":"Overloaded"}');
	await fail("503: service unavailable rate_limit_error");
	await fail("boom");
	assert.deepEqual(marks(), []);
	const p = parent();
	await p.delegate("paid t");
	assert.equal(p.tmux.opened.length, 1);
});

test("a stopped run records no mark", async (t) => {
	clock(t);
	const delegate = session({ parentEnv: "parent-x", extraModels: EXTRA });
	delete process.env.PI_DELEGATE_PARENT;
	await delegate.start();
	await delegate.run("stopped");
	assert.deepEqual(marks(), []);
});

test("a plain 429 marks for 5 minutes, then 10 after it expired", async (t) => {
	const tick = clock(t);
	await fail("429: slow down");
	assert.equal(marks()[0].clearsAt, START + 5 * 60_000);
	tick(5 * 60_000 + 1);
	await fail("429: slow down");
	assert.equal(marks()[0].hits, 2);
	assert.equal(marks()[0].clearsAt, Date.now() + 10 * 60_000);
});

test("a stated reset time sets the clear time", async (t) => {
	clock(t);
	await fail("429: rate limited, try again in 30 minutes");
	assert.equal(marks()[0].clearsAt, START + 30 * 60_000);
	await fail('429: {"resets_at":"2026-10-03T14:00:00Z"}', "paid", "d2");
	assert.equal(marks()[0].clearsAt, Date.parse("2026-10-03T14:00:00Z"));
	await fail(`429: {"resetsAt":${(START + 3 * 3600_000) / 1000}}`, "paid", "d3");
	assert.equal(marks()[0].clearsAt, START + 3 * 3600_000);
	await fail("429: retry after 90 seconds", "paid", "d4");
	assert.equal(marks()[0].clearsAt, START + 90_000);
});

test("the launch succeeds once the clock passes the clear time", async (t) => {
	const tick = clock(t);
	await fail("429: try again in 30 minutes");
	const p = parent();
	await p.delegate("paid t");
	assert.deepEqual(p.tmux.opened, []);
	tick(30 * 60_000 + 1);
	await p.delegate("paid t");
	assert.equal(p.tmux.opened.length, 1);
});

test("an explicit model is refused, not substituted", async (t) => {
	clock(t);
	await fail(GO_LIMIT);
	const p = parent();
	await p.start();
	await p.delegate("plain --model opencode-go/paid t");
	assert.match(p.errors.join("\n"), /opencode-go\/paid is usage-limited/);
	await assert.rejects(
		p.toolCall("delegate", { agent: "plain", task: "t", model: "opencode-go/paid" }),
		/usage-limited/,
	);
	assert.deepEqual(p.tmux.opened, []);
});

test("a corrupt marks file does not break launching", async (t) => {
	clock(t);
	for (const text of ["{not json", '{"a":1}', '[1,{"scope":"opencode-go"}]']) {
		writeFileSync(FILE, text);
		const p = parent();
		await p.delegate("paid t");
		assert.equal(p.tmux.opened.length, 1, text);
	}
});

test("marks expired for over 24 hours are dropped when read", async (t) => {
	const tick = clock(t);
	await fail("429: x");
	tick(25 * 3600_000);
	await fail("429: x");
	assert.equal(marks()[0].hits, 1);
});

test("the cooldown stops doubling at 6 hours", async (t) => {
	const tick = clock(t);
	for (let hit = 1; hit < 9; hit++) {
		await fail("429: x");
		tick(marks()[0].clearsAt - Date.now() + 1);
	}
	await fail("429: x");
	assert.equal(marks()[0].hits, 9);
	assert.equal(marks()[0].clearsAt, Date.now() + 6 * 3600_000);
});

test("a mark keeps only the last 10 delegation ids", async (t) => {
	clock(t);
	for (let n = 1; n <= 12; n++) await fail("429: x", "paid", `d${n}`);
	const [mark] = JSON.parse(readFileSync(FILE, "utf8")) as { delegations: string[] }[];
	assert.deepEqual(
		mark.delegations,
		Array.from({ length: 10 }, (_, i) => `d${i + 3}`),
	);
});

test("the reason is cut to 300 characters", async (t) => {
	clock(t);
	await fail(`429: ${"x".repeat(1000)}`);
	const [mark] = JSON.parse(readFileSync(FILE, "utf8")) as { reason: string }[];
	assert.equal(mark.reason.length, 300);
});

for (const message of [
	'{"error":{"type":"usage_limit_reached"}}',
	"The usage limit reached for this plan",
	'{"type":"rate_limit_error","message":"slow"}',
	'429: {"type":"rate_limit_error"}',
]) {
	test(`Codex/Claude wording records a mark: ${message}`, async (t) => {
		clock(t);
		await fail(message);
		assert.deepEqual(
			marks().map((mark) => mark.scope),
			["opencode-go"],
		);
	});
}

for (const missing of ["provider", "model"]) {
	test(`a failure without ${missing} records nothing`, async (t) => {
		clock(t);
		const delegate = session({ parentEnv: "parent-x", extraModels: EXTRA });
		delete process.env.PI_DELEGATE_PARENT;
		await delegate.start();
		const fields = { errorMessage: GO_LIMIT, provider: "opencode-go", model: "paid", [missing]: undefined };
		await delegate.run("error", fields);
		assert.deepEqual(marks(), []);
		const p = parent();
		await p.delegate("paid t");
		assert.equal(p.tmux.opened.length, 1);
	});
}

test("a model free only by registry cost is marked alone", async (t) => {
	clock(t);
	await fail(GO_LIMIT, "zero");
	assert.equal(marks()[0].scope, "opencode-go/zero");
	const p = parent();
	await p.delegate("paid t");
	assert.equal(p.tmux.opened.length, 1);
	await p.delegate("zero t");
	assert.match(p.errors.join("\n"), /model opencode-go\/zero/);
});

/** A delegate whose run sees `response` headers, then fails on `message`. */
async function failWith(response: NonNullable<RunFailure["response"]>, message = GO_LIMIT) {
	const delegate = session({ parentEnv: "parent-x", parent: "delegation-1", extraModels: EXTRA });
	delete process.env.PI_DELEGATE_PARENT;
	await delegate.start();
	await delegate.run("error", { errorMessage: message, provider: "opencode-go", model: "paid", response });
	return delegate;
}

test("retry-after seconds set the clear time when the text states none", async (t) => {
	clock(t);
	await failWith({ status: 429, headers: { "Retry-After": "120" } });
	assert.equal(marks()[0].clearsAt, START + 120_000);
});

test("retry-after as an HTTP date", async (t) => {
	clock(t);
	await failWith({ status: 429, headers: { "retry-after": "Sat, 03 Oct 2026 13:00:00 GMT" } });
	assert.equal(marks()[0].clearsAt, Date.parse("2026-10-03T13:00:00Z"));
});

test("the latest future anthropic-ratelimit reset wins, past ones are ignored", async (t) => {
	clock(t);
	await failWith({
		status: 429,
		headers: {
			"anthropic-ratelimit-unified-reset": "2026-10-03T14:00:00Z",
			"anthropic-ratelimit-tokens-reset": "2026-10-03T13:00:00Z",
			"anthropic-ratelimit-requests-reset": "2026-10-03T11:00:00Z",
		},
	});
	assert.equal(marks()[0].clearsAt, Date.parse("2026-10-03T14:00:00Z"));
});

test("the longer of the x-ratelimit-reset durations wins", async (t) => {
	clock(t);
	await failWith({ status: 429, headers: { "x-ratelimit-reset-requests": "1s", "x-ratelimit-reset-tokens": "6m0s" } });
	assert.equal(marks()[0].clearsAt, START + 6 * 60_000);
});

test("a header reset beats the time in the error text", async (t) => {
	clock(t);
	await failWith(
		{ status: 429, headers: { "retry-after": "120" } },
		"429: usage limit reached, try again in 30 minutes",
	);
	assert.equal(marks()[0].clearsAt, START + 120_000);
});

test("headers of a 2xx response leave the ticket-02 clear time", async (t) => {
	clock(t);
	await failWith({ status: 200, headers: { "retry-after": "120" } });
	assert.equal(marks()[0].clearsAt, START + 5 * 60_000);
});

test("a 2xx response after the 429 overwrites it, so no header reset applies", async (t) => {
	clock(t);
	await failWith([
		{ status: 429, headers: { "retry-after": "120" } },
		{ status: 200, headers: {} },
	]);
	assert.equal(marks()[0].clearsAt, START + 5 * 60_000);
});

test("past and unparseable header values are ignored", async (t) => {
	clock(t);
	await failWith({
		status: 429,
		headers: {
			"retry-after": "garbage",
			"anthropic-ratelimit-requests-reset": "2026-10-03T11:00:00Z",
			"x-ratelimit-reset-requests": "soon",
		},
	});
	assert.equal(marks()[0].clearsAt, START + 5 * 60_000);
});

test("a millisecond duration and a mixed-case header name are read", async (t) => {
	clock(t);
	await failWith({ status: 429, headers: { "X-RateLimit-Reset-Requests": "500ms" } });
	assert.equal(marks()[0].clearsAt, START + 500);
	writeFileSync(FILE, "[]");
	await failWith({ status: 429, headers: { "Anthropic-RateLimit-Tokens-Reset": "2026-10-03T12:10:00Z" } });
	assert.equal(marks()[0].clearsAt, Date.parse("2026-10-03T12:10:00Z"));
});

test("headers from an earlier run do not leak into a later run's mark", async (t) => {
	clock(t);
	const delegate = await failWith({ status: 429, headers: { "retry-after": "120" } });
	writeFileSync(FILE, "[]");
	await delegate.run("error", { errorMessage: GO_LIMIT, provider: "opencode-go", model: "paid" });
	assert.equal(marks()[0].clearsAt, START + 5 * 60_000);
});

const FB = (fallback: string) => agentFile({ ...AGENT, model: "opencode-go/paid", fallback });

test("a marked model launches on the first fallback that is not marked, and says so", async (t) => {
	clock(t);
	writeAgent("fb", FB("opencode-go/zero, beta/other-model"));
	await fail(GO_LIMIT);
	await fail('429: {"type":"FreeUsageLimitError"}', "zero", "d2");
	const p = parent();
	await p.start();
	const result = await p.toolCall("delegate", { agent: "fb", task: "t" });
	const argv = p.tmux.opened[0].argv;
	assert.equal(argv[argv.indexOf("--model") + 1], "beta/other-model");
	const text = result.content[0].text;
	assert.match(
		text,
		/Used fallback beta\/other-model because opencode-go\/paid is usage-limited until 2026-10-03T12:05:00\.000Z; opencode-go\/zero is usage-limited until /,
	);
	assert.deepEqual(
		(result.details as { skipped: { model: string }[] }).skipped.map((item) => item.model),
		["opencode-go/paid", "opencode-go/zero"],
	);
	await p.delegate("fb t");
	assert.match(p.notes.join("\n"), /Used fallback beta\/other-model because/);
	const status = (await p.toolCall("delegation_status", {})).content[0].text;
	assert.match(status, /fb \(beta\/other-model, thinking/);
	assert.doesNotMatch(status, /fb \(opencode-go\/paid/);
	assert.match(
		p.tool("delegate").description,
		/default opencode-go\/paid, fallback opencode-go\/zero, fallback beta\/other-model, thinking/,
	);
});

test("an unmarked model gets no fallback note, and an agent without fallbacks is refused as before", async (t) => {
	clock(t);
	writeAgent("fb", FB("beta/other-model"));
	const p = parent();
	await p.start();
	const result = await p.toolCall("delegate", { agent: "fb", task: "t" });
	assert.doesNotMatch(result.content[0].text, /fallback/);
	await fail(GO_LIMIT);
	await assert.rejects(
		p.toolCall("delegate", { agent: "paid", task: "t" }),
		/^Error: opencode-go\/paid is usage-limited/,
	);
});

test("with every candidate marked or unusable the call is refused, one line each", async (t) => {
	clock(t);
	writeAgent("fb", FB("opencode-go/space-free, alpha/deep-model"));
	await fail("429: try again in 30 minutes");
	await fail("429: try again in 30 minutes", "space-free", "d2");
	const p = session({ extraModels: EXTRA, noCredentials: ["alpha/deep-model"] });
	await p.start();
	await p.toolCall("delegate", { agent: "fb", task: "t" }).then(
		() => assert.fail("launched"),
		(err: Error) => {
			const lines = err.message.split("\n");
			assert.match(
				lines[1],
				/^- opencode-go\/paid: usage-limited \(provider opencode-go\) until 2026-10-03T12:30:00\.000Z/,
			);
			assert.match(
				lines[2],
				/^- opencode-go\/space-free: usage-limited \(model opencode-go\/space-free\) until 2026-10-03T12:30:00/,
			);
			assert.match(lines[3], /^- alpha\/deep-model: no credentials/);
		},
	);
	assert.deepEqual(p.tmux.opened, []);
});

test("a fallback without credentials is skipped for the next one", async (t) => {
	clock(t);
	writeAgent("fb", FB("alpha/deep-model, beta/other-model"));
	await fail(GO_LIMIT);
	const p = session({ extraModels: EXTRA, noCredentials: ["alpha/deep-model"] });
	await p.delegate("fb t");
	const argv = p.tmux.opened[0].argv;
	assert.equal(argv[argv.indexOf("--model") + 1], "beta/other-model");
	assert.match(p.notes.join("\n"), /alpha\/deep-model is unavailable \(no credentials/);
});

test("an explicit model that is marked is refused even when the agent has fallbacks", async (t) => {
	clock(t);
	writeAgent("fb", FB("beta/other-model"));
	await fail(GO_LIMIT);
	const p = parent();
	await p.start();
	await assert.rejects(p.toolCall("delegate", { agent: "fb", task: "t", model: "opencode-go/paid" }), /usage-limited/);
	await p.delegate("fb --model opencode-go/paid t");
	assert.deepEqual(p.tmux.opened, []);
});

// Seeing marks: the result line and delegation_status

/** The `failed` or `done` reply the mailbox would deliver for the parent's first delegation. */
function reply(s: ReturnType<typeof parent>, status: string) {
	const requestId = (s.sendCalls[0].envelope as { id: string }).id;
	const id = (s.entries[0].data as { id: string }).id;
	return {
		envelope: {
			id: `reply-${status}`,
			from: id,
			to: s.parent,
			in_reply_to: [requestId],
			status,
			ts: "",
			body: "the answer",
		},
		path: "/mail/cur/reply.json",
		requests: [],
		handled: false,
	};
}

/** The delegation id of the parent's first delegation. */
const firstId = (s: ReturnType<typeof parent>) => (s.entries[0].data as { id: string }).id;

const resultOf = (s: ReturnType<typeof parent>) =>
	String(s.sent.find((m) => /^\[delegate\] Result from/.test(String(m.message.content)))?.message.content);

test("a failed reply from a delegate that hit a usage limit carries the limit line after Status", async (t) => {
	clock(t);
	const p = parent();
	await p.start();
	await p.delegate("plain t");
	await fail(GO_LIMIT, "paid", firstId(p));
	p.scan.queue.push(reply(p, "failed"));
	p.events.emit("message:scan", {});
	const lines = resultOf(p).split("\n");
	assert.equal(lines[1], "Status: failed");
	assert.equal(
		lines[2],
		"Usage limit: the delegate hit a usage limit on provider opencode-go; it is marked until 2026-10-03T12:05:00.000Z and later delegations skip it.",
	);
});

test("a failed reply with no matching mark has no limit line", async (t) => {
	clock(t);
	const p = parent();
	await p.start();
	await p.delegate("plain t");
	await fail(GO_LIMIT, "paid", "someone-else");
	p.scan.queue.push(reply(p, "failed"));
	p.events.emit("message:scan", {});
	const requestId = (p.sendCalls[0].envelope as { id: string }).id;
	assert.equal(
		resultOf(p),
		[
			`[delegate] Result from plain (alpha/fast-model), delegation ${firstId(p)}, request ${requestId}.`,
			"Status: failed",
			`[delegate] The task ${requestId} has no copy in sent/; only its id is known.`,
			"Envelope: /mail/cur/reply.json",
			`Delegate session: ${firstId(p)}`,
			"",
			"the answer",
		].join("\n"),
	);
});

test("a failed reply after the mark expired says it was marked, not that it is", async (t) => {
	const tick = clock(t);
	const p = parent();
	await p.start();
	await p.delegate("plain t");
	await fail(GO_LIMIT, "paid", firstId(p));
	tick(10 * 60_000); // past clearsAt (5 min), well inside the 24 h history window
	p.scan.queue.push(reply(p, "failed"));
	p.events.emit("message:scan", {});
	const lines = resultOf(p).split("\n");
	assert.equal(lines[1], "Status: failed");
	assert.equal(
		lines[2],
		"Usage limit: the delegate hit a usage limit on provider opencode-go; it was marked until 2026-10-03T12:05:00.000Z.",
	);
});

test("delegation_status lists active marks, in the details too, until they clear", async (t) => {
	const tick = clock(t);
	await fail(GO_LIMIT);
	const p = parent();
	await p.start();
	const result = await p.toolCall("delegation_status", {});
	assert.match(
		result.content[0].text,
		/^No delegations are recorded in this session\.\n\nUsage-limit marks:\n- opencode-go \(reactive\) until 2026-10-03T12:05:00\.000Z: 429: .*GoUsageLimitError/s,
	);
	assert.deepEqual((result.details as { marks: unknown[] }).marks, [
		{ scope: "opencode-go", source: "reactive", reason: GO_LIMIT, clearsAt: "2026-10-03T12:05:00.000Z" },
	]);
	tick(5 * 60_000);
	const after = await p.toolCall("delegation_status", {});
	assert.equal(after.content[0].text, "No delegations are recorded in this session.");
	assert.deepEqual((after.details as { marks: unknown[] }).marks, []);
});

const GO_MARK = "opencode-go";

test("/delegate-clear <provider> removes the mark and the next delegation launches", async (t) => {
	clock(t);
	await fail(GO_LIMIT);
	await fail(GO_LIMIT, "space-free", "delegation-2");
	const p = parent();
	await p.start();
	await p.command("delegate-clear", GO_MARK);
	assert.deepEqual(p.notes.slice(-1), ["delegate-clear: cleared opencode-go, opencode-go/space-free."]);
	assert.deepEqual(marks(), []);
	await p.delegate("paid t");
	assert.deepEqual(p.errors, []);
});

test("/delegate-clear provider/model clears the model and its provider mark, not siblings", async (t) => {
	clock(t);
	await fail(GO_LIMIT);
	await fail(GO_LIMIT, "space-free", "delegation-2");
	const p = parent();
	await p.start();
	await p.command("delegate-clear", "opencode-go/space-free");
	assert.deepEqual(p.notes.slice(-1), ["delegate-clear: cleared opencode-go, opencode-go/space-free."]);
	await fail('429: {"type":"FreeUsageLimitError"}', "zero", "delegation-3");
	await p.command("delegate-clear", "opencode-go/paid");
	assert.deepEqual(
		marks().map((m) => m.scope),
		["opencode-go/zero"],
	);
});

test("/delegate-clear opencode does not clear opencode-go", async (t) => {
	clock(t);
	const mark = (scope: string) => ({
		scope,
		reason: GO_LIMIT,
		recordedAt: START,
		clearsAt: START + 5 * 60_000,
		source: "reactive",
		hits: 1,
		delegations: [],
	});
	writeFileSync(FILE, JSON.stringify([mark("opencode"), mark("opencode/m"), mark("opencode-go")]));
	const p = parent();
	await p.start();
	await p.command("delegate-clear", "opencode");
	assert.deepEqual(p.notes.slice(-1), ["delegate-clear: cleared opencode, opencode/m."]);
	assert.deepEqual(
		marks().map((m) => m.scope),
		["opencode-go"],
	);
	await p.delegate("paid t");
	assert.match(p.errors.join("\n"), /opencode-go\/paid is usage-limited/);
});

test("/delegate-clear all removes every mark", async (t) => {
	clock(t);
	await fail(GO_LIMIT);
	await fail(GO_LIMIT, "plain", "delegation-2");
	const p = parent();
	await p.start();
	await p.command("delegate-clear", "all");
	assert.deepEqual(marks(), []);
});

test("/delegate-clear with nothing or nonsense changes nothing and lists the marks", async (t) => {
	clock(t);
	const p = parent();
	await p.start();
	await p.command("delegate-clear", "");
	assert.deepEqual(p.notes.slice(-1), ["delegate-clear: no usage-limit marks are active."]);
	await fail(GO_LIMIT);
	const before = readFileSync(FILE, "utf8");
	await p.command("delegate-clear", "nonsense");
	await p.command("delegate-clear");
	assert.equal(readFileSync(FILE, "utf8"), before);
	assert.deepEqual(p.notes.slice(-2), [
		'delegate-clear: no active mark matches "nonsense". Active marks: opencode-go until 2026-10-03T12:05:00.000Z. Use all, a provider or provider/model.',
		"delegate-clear: name a mark to clear. Active marks: opencode-go until 2026-10-03T12:05:00.000Z. Use all, a provider or provider/model.",
	]);
});

test("a hit after a clear starts at 5 minutes, not an escalated cooldown", async (t) => {
	const tick = clock(t);
	await fail(GO_LIMIT);
	tick(5 * 60_000);
	await fail(GO_LIMIT, "paid", "delegation-2");
	assert.equal(marks()[0].hits, 2);
	const p = parent();
	await p.start();
	await p.command("delegate-clear", GO_MARK);
	await fail(GO_LIMIT, "paid", "delegation-3");
	assert.equal(marks()[0].hits, 1);
	assert.equal(marks()[0].clearsAt, Date.now() + 5 * 60_000);
});

test("/delegate-clear completes all and the active scopes, and is absent in a delegate", async (t) => {
	clock(t);
	await fail(GO_LIMIT);
	const p = parent();
	await p.start();
	const complete = (prefix: string) => p.completionsFor("delegate-clear", prefix);
	assert.deepEqual(
		(await complete(""))?.map((c) => c.value),
		["all", GO_MARK],
	);
	assert.deepEqual(
		(await complete("op"))?.map((c) => c.value),
		[GO_MARK],
	);
	assert.equal(await complete("zz"), null);
	const child = session({ parentEnv: "parent-x", parent: "delegation-9" });
	await child.start();
	delete process.env.PI_DELEGATE_PARENT;
	assert.ok(!child.commands().includes("delegate-clear"));
	assert.ok(p.commands().includes("delegate-clear"));
});

// --- Proactive OpenCode Go check (ticket 07), through the fake usage client.

const RESET = START + 3 * 3_600_000;
const withUsage = (usage = new FakeUsage()) => ({ usage, p: session({ extraModels: EXTRA, usage }) });
const call = (p: ReturnType<typeof session>, agent: string) => p.toolCall("delegate", { agent, task: "t" });

test("a Go window at 100% launches on the fallback and records a proactive mark", async (t) => {
	clock(t);
	writeAgent("fb", agentFile({ ...AGENT, model: "opencode-go/paid", fallback: "alpha/fast-model" }));
	const { usage, p } = withUsage();
	usage.go = { ok: true, windows: [win("5h", 100, RESET), win("wk", 10)] };
	await p.start();
	const result = await call(p, "fb");
	assert.match(result.content[0].text, /Used fallback alpha\/fast-model because opencode-go\/paid is usage-limited/);
	assert.deepEqual(
		marks().map((m) => [m.scope, m.clearsAt]),
		[["opencode-go", RESET]],
	);
	const status = await p.toolCall("delegation_status", {});
	assert.match(
		status.content[0].text,
		/opencode-go \(proactive\) until 2026-10-03T15:00:00\.000Z: Go 5h window at 100%/,
	);
});

test("a rate-limited Go window blocks; with no fallback the launch is refused", async (t) => {
	clock(t);
	const { usage, p } = withUsage();
	usage.go = { ok: true, windows: [win("wk", null, null, true)] };
	await p.start();
	await assert.rejects(call(p, "paid"), /opencode-go\/paid is usage-limited .*Go wk window rate-limited/s);
	assert.equal(marks()[0].clearsAt, START + 5 * 60_000); // no reset time: the cooldown
	assert.equal(marks()[0].source, "proactive");
});

test("Go windows below 100% let the agent's model launch", async (t) => {
	clock(t);
	const { usage, p } = withUsage();
	usage.go = { ok: true, windows: [win("5h", 99, RESET), win("wk", 40), win("mo", 0)] };
	await p.start();
	assert.match((await call(p, "paid")).content[0].text, /\(opencode-go\/paid,/);
	assert.deepEqual(marks(), []);
});

test("free Go models and other providers never trigger a read", async (t) => {
	clock(t);
	const { usage, p } = withUsage();
	await p.start();
	await call(p, "free");
	await call(p, "zero");
	await call(p, "plain");
	assert.equal(usage.calls.length, 0);
});

test("readings are reused for 60 seconds, then read again", async (t) => {
	const tick = clock(t);
	const { usage, p } = withUsage();
	usage.go = { ok: true, windows: [win("5h", 10)] };
	await p.start();
	await call(p, "paid");
	tick(59_000);
	await call(p, "paid");
	assert.equal(usage.calls.length, 1);
	tick(2_000);
	await call(p, "paid");
	assert.equal(usage.calls.length, 2);
	assert.equal(usage.calls[0].key, "fake-key-opencode-go");
});

test("a candidate that already has an active mark is skipped without a read", async (t) => {
	clock(t);
	await fail(GO_LIMIT);
	const { usage, p } = withUsage();
	await p.start();
	await assert.rejects(call(p, "paid"), /usage-limited/);
	assert.equal(usage.calls.length, 0);
});

test("a failed reading fails open, says so in the result and the notice, and shows in delegation_status", async (t) => {
	clock(t);
	const { usage, p } = withUsage();
	usage.go = { ok: false, reason: "HTTP 503" };
	await p.start();
	const result = await call(p, "paid");
	const line = "Could not read opencode-go quota: HTTP 503; launched without a proactive check.";
	assert.ok(result.content[0].text.includes(line));
	await p.delegate("paid t");
	assert.ok(p.notes.at(-1)?.includes(line));
	assert.equal(p.tmux.opened.length, 2);
	const status = await p.toolCall("delegation_status", {});
	assert.match(
		status.content[0].text,
		/Usage-limit marks:\n- could not read opencode-go quota at 2026-10-03T12:00:00\.000Z: HTTP 503/,
	);
	assert.deepEqual((status.details as { readingErrors: unknown }).readingErrors, [
		{ provider: "opencode-go", reason: "HTTP 503", at: "2026-10-03T12:00:00.000Z" },
	]);
	assert.deepEqual((status.details as { marks: unknown }).marks, []);
});

test("a mark file that cannot be written still blocks this launch and never throws", async (t) => {
	clock(t);
	rmSync(FILE);
	mkdirSync(FILE); // a directory where the marks file belongs: reads and writes fail
	t.after(() => rmSync(FILE, { recursive: true }));
	writeAgent("fb", agentFile({ ...AGENT, model: "opencode-go/paid", fallback: "alpha/fast-model" }));
	const { usage, p } = withUsage();
	usage.go = { ok: true, windows: [win("5h", 100, RESET)] };
	await p.start();
	const result = await call(p, "fb");
	assert.match(result.content[0].text, /Used fallback alpha\/fast-model because opencode-go\/paid is usage-limited/);
	await assert.rejects(call(p, "paid"), /opencode-go\/paid is usage-limited/);
});

test("a later successful reading clears the provider's reading error", async (t) => {
	const tick = clock(t);
	const { usage, p } = withUsage();
	usage.go = { ok: false, reason: "HTTP 503" };
	await p.start();
	await call(p, "paid");
	usage.go = { ok: true, windows: [win("5h", 10)] };
	tick(61_000);
	await call(p, "paid");
	const status = await p.toolCall("delegation_status", {});
	assert.deepEqual((status.details as { readingErrors: unknown }).readingErrors, []);
	assert.doesNotMatch(status.content[0].text, /could not read/);
});

test("/delegate-clear drops the cached reading, so the next launch reads afresh", async (t) => {
	const tick = clock(t);
	writeAgent("fb", agentFile({ ...AGENT, model: "opencode-go/paid", fallback: "alpha/fast-model" }));
	const { usage, p } = withUsage();
	usage.go = { ok: true, windows: [win("5h", 100, RESET)] };
	await p.start();
	await call(p, "fb");
	assert.equal(marks()[0].source, "proactive");
	await p.command("delegate-clear", GO_MARK);
	usage.go = { ok: true, windows: [win("5h", 20)] };
	tick(5_000);
	assert.match((await call(p, "fb")).content[0].text, /\(opencode-go\/paid,/);
	assert.equal(usage.calls.length, 2);
	assert.deepEqual(marks(), []);
});

const CLAUDE_EXTRA = [
	{ provider: "anthropic", id: "claude-opus-4" },
	{ provider: "anthropic", id: "claude-sonnet-4" },
];
const OAUTH = ["anthropic/claude-opus-4", "anthropic/claude-sonnet-4"];
const claudeSession = (oauth = OAUTH) => {
	const usage = new FakeUsage();
	return { usage, p: session({ extraModels: CLAUDE_EXTRA, oauth, usage }) };
};
const cache = (over: Partial<Extract<ClaudeReading, { ok: true }>> = {}): ClaudeReading => ({
	ok: true,
	fiveHour: win("5h", 10),
	sevenDay: win("7d", 10),
	scoped: null,
	fetchedAt: START,
	...over,
});

test("a Claude 5h window at 100% skips an OAuth candidate for its fallback, with a provider mark", async (t) => {
	clock(t);
	writeAgent("cl", agentFile({ ...AGENT, model: "anthropic/claude-opus-4", fallback: "alpha/fast-model" }));
	const { usage, p } = claudeSession();
	usage.claude = cache({ fiveHour: win("5h", 100, RESET) });
	await p.start();
	const result = await call(p, "cl");
	assert.match(
		result.content[0].text,
		/Used fallback alpha\/fast-model because anthropic\/claude-opus-4 is usage-limited/,
	);
	assert.deepEqual(
		marks().map((m) => [m.scope, m.clearsAt, m.source]),
		[["anthropic", RESET, "proactive"]],
	);
});

test("a Claude window at 100% whose reset has passed is stale: the launch goes ahead, no mark", async (t) => {
	clock(t);
	writeAgent("cl", agentFile({ ...AGENT, model: "anthropic/claude-opus-4" }));
	const { usage, p } = claudeSession();
	usage.claude = cache({ fiveHour: win("5h", 100, START - 1000) });
	await p.start();
	await call(p, "cl");
	assert.equal(p.tmux.opened.length, 1);
	assert.deepEqual(marks(), []);
});

test("a scoped Opus week at 100% blocks only the Opus candidate", async (t) => {
	clock(t);
	writeAgent("opus", agentFile({ ...AGENT, model: "anthropic/claude-opus-4" }));
	writeAgent("sonnet", agentFile({ ...AGENT, model: "anthropic/claude-sonnet-4" }));
	const { usage, p } = claudeSession();
	usage.claude = cache({ scoped: win("Opus", 100, RESET) });
	await p.start();
	await assert.rejects(call(p, "opus"), /anthropic\/claude-opus-4 is usage-limited \(model anthropic\/claude-opus-4\)/);
	assert.deepEqual(
		marks().map((m) => m.scope),
		["anthropic/claude-opus-4"],
	);
	await call(p, "sonnet");
	assert.equal(p.tmux.opened.length, 1);
});

test("a non-OAuth anthropic candidate makes no cache read", async (t) => {
	clock(t);
	writeAgent("opus", agentFile({ ...AGENT, model: "anthropic/claude-opus-4" }));
	const { usage, p } = claudeSession([]);
	usage.claude = cache({ fiveHour: win("5h", 100, RESET) });
	await p.start();
	await call(p, "opus");
	assert.equal(usage.claudeReads, 0);
	assert.equal(usage.claudeRefreshes, 0);
	assert.deepEqual(marks(), []);
});

test("a stale cache starts one background refresh per 5 minutes and the launch does not wait", async (t) => {
	const tick = clock(t);
	writeAgent("opus", agentFile({ ...AGENT, model: "anthropic/claude-opus-4" }));
	const { usage, p } = claudeSession();
	usage.claude = cache({ fetchedAt: START - 6 * 60_000 });
	await p.start();
	await call(p, "opus");
	assert.equal(usage.claudeRefreshes, 1);
	tick(4 * 60_000);
	await call(p, "opus");
	assert.equal(usage.claudeRefreshes, 1);
	tick(60_000);
	await call(p, "opus");
	assert.equal(usage.claudeRefreshes, 2);
	tick(10 * 60_000);
	usage.claude = cache({ fetchedAt: Date.now() });
	await call(p, "opus");
	assert.equal(usage.claudeRefreshes, 2);
});

test("a refresh that throws never blocks a launch", async (t) => {
	clock(t);
	writeAgent("opus", agentFile({ ...AGENT, model: "anthropic/claude-opus-4" }));
	const { usage, p } = claudeSession();
	usage.claude = cache({ fetchedAt: null });
	usage.refreshClaude = () => {
		throw new Error("boom");
	};
	await p.start();
	await call(p, "opus");
	assert.equal(p.tmux.opened.length, 1);
});

test("a missing Claude cache fails open and shows as a reading error", async (t) => {
	clock(t);
	writeAgent("opus", agentFile({ ...AGENT, model: "anthropic/claude-opus-4" }));
	const { usage, p } = claudeSession();
	usage.claude = { ok: false, reason: "cache unreadable: ENOENT" };
	await p.start();
	const result = await call(p, "opus");
	assert.ok(
		result.content[0].text.includes(
			"Could not read anthropic quota: cache unreadable: ENOENT; launched without a proactive check.",
		),
	);
	const status = await p.toolCall("delegation_status", {});
	assert.deepEqual((status.details as { readingErrors: unknown }).readingErrors, [
		{ provider: "anthropic", reason: "cache unreadable: ENOENT", at: "2026-10-03T12:00:00.000Z" },
	]);
});

// --- Early clearing (ticket 09): a re-check clears a mark only after the quota reset since it.

const H = 3_600_000;
/** A Go reading whose 5h window began `agoMs` before now (so it resets 5h after that). */
const goCycle = (agoMs: number, percent = 10) => ({
	ok: true as const,
	windows: [
		win("5h", percent, START + 6 * H - agoMs + 5 * H, false, 5 * H),
		win("wk", 10, START + 6 * H + 3 * 24 * H, false, 7 * 24 * H),
	],
});
const CLEARED = "Cleared the usage-limit mark on opencode-go: its quota has reset since the mark was recorded.";

async function markedGo(t: TestContext) {
	const tick = clock(t);
	writeAgent("fb", agentFile({ ...AGENT, model: "opencode-go/paid", fallback: "alpha/fast-model" }));
	await fail(`${GO_LIMIT} try again in 10 hours`);
	tick(6 * H);
	const { usage, p } = withUsage();
	await p.start();
	return { usage, p, tick };
}

test("a reading whose window began after the mark clears it and launches on the agent's model", async (t) => {
	const { usage, p } = await markedGo(t);
	usage.go = goCycle(1 * H);
	const result = await call(p, "fb");
	assert.ok(result.content[0].text.includes(CLEARED));
	assert.ok(!result.content[0].text.includes("Used fallback"));
	assert.deepEqual(marks(), []);
	assert.equal(p.tmux.opened.length, 1);
});

test("a window cycle that began before the mark leaves it and uses the fallback", async (t) => {
	const { usage, p } = await markedGo(t);
	usage.go = goCycle(6 * H + 30 * 60_000);
	const result = await call(p, "fb");
	assert.match(result.content[0].text, /Used fallback alpha\/fast-model/);
	assert.ok(!result.content[0].text.includes("Cleared"));
	assert.equal(marks().length, 1);
});

test("headroom without a reset time leaves the mark", async (t) => {
	const { usage, p } = await markedGo(t);
	usage.go = { ok: true, windows: [win("5h", 10), win("wk", 10)] };
	const result = await call(p, "fb");
	assert.match(result.content[0].text, /Used fallback/);
	assert.equal(marks().length, 1);
});

test("a reset window does not clear the mark while another window is at 100%", async (t) => {
	const { usage, p } = await markedGo(t);
	const reading = goCycle(1 * H);
	usage.go = { ok: true, windows: [reading.windows[0], win("wk", 100, START + 7 * H, false, 7 * 24 * H)] };
	await call(p, "fb");
	assert.equal(marks().length, 1);
});

test("launches within 10 minutes make one re-check; a later one makes another", async (t) => {
	const { usage, p, tick } = await markedGo(t);
	usage.go = goCycle(6 * H + 30 * 60_000);
	await call(p, "fb");
	tick(2 * 60_000);
	await call(p, "fb");
	assert.equal(usage.calls.length, 1);
	tick(9 * 60_000);
	await call(p, "fb");
	assert.equal(usage.calls.length, 2);
});

test("a failed re-check keeps the mark, shows the error, and adds no fail-open note", async (t) => {
	const { usage, p } = await markedGo(t);
	usage.go = { ok: false, reason: "HTTP 503" };
	const result = await call(p, "fb");
	assert.match(result.content[0].text, /Used fallback/);
	assert.ok(!result.content[0].text.includes("Could not read"));
	assert.equal(marks().length, 1);
	const status = await p.toolCall("delegation_status", {});
	assert.deepEqual((status.details as { readingErrors: unknown }).readingErrors, [
		{ provider: "opencode-go", reason: "HTTP 503", at: new Date(START + 6 * H).toISOString() },
	]);
});

test("a model-scoped Claude mark is cleared only by its scoped window resetting", async (t) => {
	const tick = clock(t);
	writeAgent("opus", agentFile({ ...AGENT, model: "anthropic/claude-opus-4" }));
	const { usage, p } = claudeSession();
	usage.claude = cache({ scoped: win("Opus", 100, START + 12 * H, false, 7 * 24 * H) });
	await p.start();
	await assert.rejects(call(p, "opus"), /usage-limited/);
	tick(6 * H);
	const now = START + 6 * H;
	// Only the 5h window reset: the scoped mark stays.
	usage.claude = cache({
		fetchedAt: now,
		fiveHour: win("5h", 5, now + 4 * H, false, 5 * H),
		scoped: win("Opus", 50, now + 24 * H, false, 7 * 24 * H),
	});
	await assert.rejects(call(p, "opus"), /usage-limited/);
	assert.equal(marks().length, 1);
	tick(11 * 60_000);
	const later = now + 11 * 60_000;
	usage.claude = cache({
		fetchedAt: later,
		scoped: win("Opus", 5, later + 7 * 24 * H - H, false, 7 * 24 * H),
	});
	const result = await call(p, "opus");
	assert.ok(result.content[0].text.includes("Cleared the usage-limit mark on anthropic/claude-opus-4:"));
	assert.deepEqual(marks(), []);
});
