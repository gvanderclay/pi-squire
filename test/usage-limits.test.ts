// Usage-limit marks: a delegate whose run ends on a usage-limit error records
// a mark in the agent directory; the parent, a separate session, then refuses
// to launch on a marked model until the mark clears. Time is a mock Date.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, type TestContext, test } from "node:test";

import { agentDir, agentFile, cleanup, resetRoot, session, writeAgent } from "./harness.ts";

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

const marks = () => JSON.parse(readFileSync(FILE, "utf8")) as { clearsAt: number; hits: number; scope: string }[];

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
