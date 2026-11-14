import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { type SessionUsage, sessionUsage, usageText, validateSessionUsage } from "../src/session-usage.ts";
import { cleanup, resetRoot, root } from "./harness.ts";

beforeEach(resetRoot);
after(cleanup);

const file: string = join(root, "usage.jsonl");
type Counts = { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: { total: number } };
const first: Counts = { input: 89_000, output: 4600, cacheRead: 1_530_000, cacheWrite: 0, cost: { total: 0.2 } };
const last: Counts = { input: 10_000, output: 4600, cacheRead: 170_000, cacheWrite: 1000, cost: { total: 0.19 } };
const total: SessionUsage = {
	turns: 2,
	input: 99_000,
	output: 9200,
	cacheRead: 1_700_000,
	cacheWrite: 1000,
	cost: 0.39,
	contextTokens: 181_000,
};

function assistant(usage: unknown): object {
	return { type: "message", message: { role: "assistant", usage } };
}
function write(lines: unknown[]): void {
	writeFileSync(file, lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n"));
}

test("sessionUsage sums the whole file across branches, and context excludes the last output", () => {
	write([
		{ ...assistant(first), id: "abandoned", parentId: "root" },
		{ ...assistant(last), id: "active", parentId: "root" },
		{ type: "message", message: { role: "user", content: "later" } },
	]);
	assert.deepEqual(sessionUsage(file), total);
	assert.equal(usageText(total), "2 turns, 1.8M tokens in (1.7M cached), 9.2k out, $0.39; context at finish 181k.");
});

test("sessionUsage counts compaction, branch summaries, standalone and separate nested tool model work once", () => {
	const usage: Counts = { input: 10, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.1 } };
	write([
		{
			type: "message",
			message: { role: "assistant", content: [{ type: "toolCall", id: "nested", name: "model" }], usage },
		},
		{ type: "message", message: { role: "toolResult", toolCallId: "nested", usage, details: { usage } } },
		{ type: "compaction", usage },
		{ type: "branch_summary", usage },
		{ type: "usage", kind: "future-billed-operation", usage },
		{ type: "message", message: { role: "user", usage } },
		{ type: "custom", usage },
	]);
	assert.deepEqual(sessionUsage(file), {
		turns: 1,
		input: 50,
		output: 10,
		cacheRead: 15,
		cacheWrite: 20,
		cost: 0.5,
		contextTokens: 17,
	});
});

test("a failed or aborted last request does not reset context at finish", () => {
	const zero: Counts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
	for (const stopReason of ["error", "aborted"]) {
		write([
			assistant(first),
			assistant(last),
			{ type: "message", message: { role: "assistant", stopReason, usage: zero } },
		]);
		assert.deepEqual(sessionUsage(file), { ...total, turns: 3 });
	}
	// A zero-usage message with no stop reason is skipped for context too.
	write([assistant(last), assistant(zero)]);
	assert.equal(sessionUsage(file)?.contextTokens, 181_000);
});

test("usage text rounds across units, marks tiny costs and names earlier work", () => {
	const base: SessionUsage = { turns: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0 };
	assert.match(usageText({ ...base, input: 999_949 }), /^1 turn, 999\.9k tokens in/);
	assert.match(usageText({ ...base, input: 999_950 }), /^1 turn, 1M tokens in/);
	assert.match(usageText({ ...base, input: 999.6 }), /^1 turn, 1k tokens in/);
	assert.match(usageText({ ...base, input: 999 }), /^1 turn, 999 tokens in/);
	assert.match(usageText({ ...base, cost: 0.002 }), /, <\$0\.01;/);
	assert.match(usageText({ ...base, cost: 0 }), /, \$0\.00;/);
	assert.match(usageText({ ...base, cost: 0.005 }), /, \$0\.01;/);
	assert.equal(
		usageText(total, true),
		`${usageText(total)} Counts the whole session, including work before this delegation.`,
	);
});

test("non-assistant billed entries give totals without inventing turns or context", () => {
	write([{ type: "compaction", usage: last }]);
	assert.deepEqual(sessionUsage(file), { turns: 0, ...last, cost: 0.19, contextTokens: 0 });
});

test("one missing or malformed cost makes the total unknown, but zero is known", () => {
	for (const cost of [undefined, null, {}, { total: -1 }, { total: "1" }]) {
		write([assistant({ ...first, cost }), assistant(last)]);
		const { cost: omitted, ...unknown } = total;
		assert.equal(omitted, 0.39);
		assert.deepEqual(sessionUsage(file), unknown);
		assert.equal(usageText(unknown).includes("$"), false);
	}
	write([assistant({ ...last, cost: { total: 0 } })]);
	assert.equal(sessionUsage(file)?.cost, 0);
	assert.match(usageText(sessionUsage(file) as SessionUsage), /\$0\.00/);
});

test("malformed lines and invalid counts are skipped without hiding valid usage", () => {
	write([
		"{truncated",
		null,
		[],
		3,
		{},
		assistant(null),
		assistant({}),
		assistant({ ...last, input: -1 }),
		assistant({ ...last, output: "5" }),
		assistant({ ...last, cacheRead: null }),
		assistant({ ...last, cacheWrite: null }),
		assistant(last),
		"{last line truncated",
	]);
	assert.deepEqual(sessionUsage(file), { turns: 1, ...last, cost: 0.19, contextTokens: 181_000 });
});

test("empty, missing and non-usage files give no report", () => {
	assert.equal(sessionUsage(join(root, "missing.jsonl")), undefined);
	assert.equal(sessionUsage(undefined), undefined);
	write([]);
	assert.equal(sessionUsage(file), undefined);
	write(["{broken", { type: "message", message: { role: "assistant" } }]);
	assert.equal(sessionUsage(file), undefined);
});

test("stored usage validates optional fields and refuses malformed numbers and shapes", () => {
	validateSessionUsage(undefined);
	validateSessionUsage(total);
	for (const value of [
		null,
		[],
		"usage",
		{},
		{ ...total, turns: -1 },
		{ ...total, turns: 1.5 },
		{ ...total, contextTokens: NaN },
		{ ...total, input: Infinity },
		{ ...total, output: -1 },
		{ ...total, cacheRead: "3" },
		{ ...total, cacheWrite: undefined },
		{ ...total, cost: null },
		{ ...total, cost: Infinity },
	])
		assert.throws(() => validateSessionUsage(value), /invalid delegation usage/);
});
