import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { clearMarks, type Mark, recordProactive } from "../src/limits.ts";
import { agentModels, chooseModel, fallbackNote, modelIds, modelProblem } from "../src/model-choice.ts";
import type { Proactive } from "../src/usage.ts";
import { testAgent } from "./delegate-fixtures.ts";

const root = mkdtempSync(join(tmpdir(), "squire-model-choice-"));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
beforeEach(() => writeFileSync(join(root, "pi-squire-limits.json"), "[]"));
after(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	rmSync(root, { recursive: true, force: true });
});

const catalog = [
	{ provider: "alpha", id: "paid", cost: { input: 1, output: 1 } },
	{ provider: "alpha", id: "zero", cost: { input: 0, output: 0 } },
	{ provider: "alpha", id: "model-free", cost: { input: 1, output: 1 } },
	{ provider: "beta", id: "other", cost: { input: 1, output: 1 } },
	{ provider: "gamma", id: "last", cost: { input: 1, output: 1 } },
];
function registry(noAuth: readonly string[] = []): ModelRegistry {
	return {
		find: (provider: string, id: string) => catalog.find((model) => model.provider === provider && model.id === id),
		getAll: () => catalog,
		hasConfiguredAuth: (model: { provider: string }) => !noAuth.includes(model.provider),
	} as unknown as ModelRegistry;
}
function quota(overrides: Partial<Proactive> = {}): Proactive {
	return { check: async () => ({}), recheck: async () => [], errors: () => [], clear: () => {}, ...overrides };
}
const own = ["alpha/paid", "beta/other", "gamma/last"];
const agent = testAgent({ model: own[0], fallback: own.slice(1) });
const until = Date.parse("2999-01-01T00:00:00.000Z");
const untilText = new Date(until).toISOString();

test("agent model order uses its own model or the parent before fallbacks", () => {
	assert.deepEqual(agentModels(agent, "parent/model"), own);
	assert.deepEqual(agentModels(testAgent({ fallback: ["beta/other"] }), "parent/model"), [
		"parent/model",
		"beta/other",
	]);
	assert.deepEqual(agentModels(testAgent({ fallback: ["beta/other"] }), undefined), ["beta/other"]);
	assert.deepEqual(agentModels(testAgent(), undefined), []);
	assert.deepEqual(modelIds(undefined), []);
	assert.deepEqual(
		modelIds(registry(["alpha"])),
		catalog.map((model) => `${model.provider}/${model.id}`),
	);
});

test("model validation distinguishes malformed ids, unknown models and missing auth", () => {
	for (const value of ["alpha", "/paid", "alpha/"]) {
		assert.equal(modelProblem(value, registry()), `--model takes provider/id, got ${JSON.stringify(value)}`);
	}
	assert.equal(modelProblem("alpha/paid", registry()), undefined);
	assert.equal(
		modelProblem("alpha/paid", registry(["alpha"])),
		'no credentials for model "alpha/paid"; log in to the provider "alpha" (/login), then try again',
	);
	assert.equal(
		modelProblem("alpha/pai", registry()),
		'unknown model "alpha/pai"; close matches: alpha/paid, alpha/zero',
	);
	assert.equal(modelProblem("zzzzzzzz/qqqqqqqqqqqq", registry()), 'unknown model "zzzzzzzz/qqqqqqqqqqqq"');
});

test("implicit selection retains fallback order while explicit selection has no rest", async () => {
	assert.deepEqual(await chooseModel(undefined, agent, registry(), quota(), own), {
		model: "alpha/paid",
		skipped: [],
		notices: [],
		rest: ["beta/other", "gamma/last"],
	});
	assert.deepEqual(await chooseModel("beta/other", agent, registry(), quota(), own), {
		model: "beta/other",
		skipped: [],
		notices: [],
		rest: [],
	});
	assert.deepEqual(await chooseModel(undefined, agent, registry(), quota(), own, ["gamma/last", "beta/other"]), {
		model: "gamma/last",
		skipped: [],
		notices: [],
		rest: ["beta/other"],
	});
});

test("unknown implicit patterns pass through unchanged without registry or quota checks", async () => {
	const unused = quota({
		check: async () => {
			throw new Error("unexpected check");
		},
	});
	assert.deepEqual(await chooseModel(undefined, agent, registry(), unused, ["alpha/*", "beta/other"]), {
		model: "alpha/*",
		skipped: [],
		notices: [],
		rest: ["beta/other"],
	});
	await assert.rejects(chooseModel("alpha/*", agent, registry(), unused, own), /unknown model "alpha\/\*"/);
});

test("missing credentials skip an implicit candidate but refuse an explicit one", async () => {
	const reason = modelProblem("alpha/paid", registry(["alpha"]));
	assert.deepEqual(await chooseModel(undefined, agent, registry(["alpha"]), quota(), own), {
		model: "beta/other",
		skipped: [{ model: "alpha/paid", why: `unavailable (${reason})`, reason }],
		notices: [],
		rest: ["gamma/last"],
	});
	await assert.rejects(chooseModel("alpha/paid", agent, registry(["alpha"]), quota(), own), {
		message: reason,
	});
});

test("empty model lists refuse with the agent path", async () => {
	await assert.rejects(chooseModel(undefined, testAgent(), registry(), quota(), []), {
		message: "agent worker names no model and this session has none; add model to /agents/worker.md, or pass one",
	});
});

test("persisted provider and returned model marks produce precise skip details", async () => {
	recordProactive("alpha", "quota used up", until);
	assert.deepEqual(await chooseModel(undefined, agent, registry(), quota(), own), {
		model: "beta/other",
		skipped: [
			{
				model: "alpha/paid",
				why: `usage-limited until ${untilText}`,
				reason: `usage-limited (provider alpha) until ${untilText}: quota used up`,
			},
		],
		notices: [],
		rest: ["gamma/last"],
	});
	clearMarks("all");
	const mark: Mark = {
		scope: "alpha/paid",
		reason: "model quota",
		recordedAt: Date.now(),
		clearsAt: until,
		source: "proactive",
		hits: 1,
		delegations: [],
	};
	assert.deepEqual(
		(
			await chooseModel(
				undefined,
				agent,
				registry(),
				quota({
					check: async (_models, provider) => (provider === "alpha" ? { mark } : {}),
				}),
				own,
			)
		).skipped,
		[
			{
				model: "alpha/paid",
				why: `usage-limited until ${untilText}`,
				reason: `usage-limited (model alpha/paid) until ${untilText}: model quota`,
			},
		],
	);
});

test("quota notices are deduplicated across skipped candidates", async () => {
	const result = await chooseModel(
		undefined,
		agent,
		registry(),
		quota({
			check: async (_models, provider) => ({
				notice: "quota reading notice",
				mark: provider === "alpha" ? recordProactive("alpha", "quota", until) : undefined,
			}),
		}),
		own,
	);
	assert.equal(result.model, "beta/other");
	assert.deepEqual(result.notices, ["quota reading notice"]);
});

test("an active mark is rechecked before a fresh check and can clear early", async () => {
	recordProactive("alpha", "quota", until);
	const calls: string[] = [];
	const result = await chooseModel(
		undefined,
		agent,
		registry(),
		quota({
			recheck: async () => {
				calls.push("recheck");
				clearMarks("alpha");
				return ["quota reset", "quota reset"];
			},
			check: async () => {
				calls.push("check");
				return { notice: "quota reset" };
			},
		}),
		own,
	);
	assert.equal(result.model, "alpha/paid");
	assert.deepEqual(result.notices, ["quota reset"]);
	assert.deepEqual(calls, ["recheck", "check"]);
});

test("an uncleared mark prevents another proactive check", async () => {
	recordProactive("alpha", "quota", until);
	const calls: string[] = [];
	const result = await chooseModel(
		undefined,
		agent,
		registry(),
		quota({
			recheck: async (_models, provider) => {
				calls.push(`recheck ${provider}`);
				return [];
			},
			check: async (_models, provider) => {
				calls.push(`check ${provider}`);
				return {};
			},
		}),
		own,
	);
	assert.equal(result.model, "beta/other");
	assert.deepEqual(calls, ["recheck alpha", "check beta"]);
});

test("provider marks do not cover free models, which never request proactive checks", async () => {
	recordProactive("alpha", "quota", until);
	const unused = quota({
		check: async () => {
			throw new Error("unexpected check");
		},
		recheck: async () => {
			throw new Error("unexpected recheck");
		},
	});
	for (const model of ["alpha/zero", "alpha/model-free"]) {
		assert.equal((await chooseModel(model, agent, registry(), unused, own)).model, model);
	}
});

test("an explicit marked model is never substituted, but suggests open agent models", async () => {
	recordProactive("alpha", "quota", until);
	await assert.rejects(chooseModel("alpha/paid", agent, registry(), quota(), own), {
		message: `alpha/paid is usage-limited (provider alpha) until ${untilText}: quota. Omit model to launch worker on beta/other (also open: gamma/last), or clear marks with /delegate-clear.`,
	});
	await assert.rejects(chooseModel("alpha/paid", agent, registry(), quota(), ["alpha/paid"]), {
		message: `alpha/paid is usage-limited (provider alpha) until ${untilText}: quota. Clear marks with /delegate-clear.`,
	});
});

test("all unavailable candidates are listed in order", async () => {
	recordProactive("alpha", "quota", until);
	const reason = modelProblem("beta/other", registry(["beta"]));
	await assert.rejects(chooseModel(undefined, agent, registry(["beta"]), quota(), ["alpha/paid", "beta/other"]), {
		message: `no model is available for agent worker:\n- alpha/paid: usage-limited (provider alpha) until ${untilText}: quota\n- beta/other: ${reason}\nClear marks with /delegate-clear.`,
	});
});

test("fallback wording uses concise skip reasons and remains empty without skips", () => {
	assert.equal(fallbackNote({ model: "alpha/paid", skipped: [] }), "");
	assert.equal(
		fallbackNote({
			model: "beta/other",
			skipped: [
				{ model: "alpha/paid", why: "usage-limited until tomorrow", reason: "long reason" },
				{ model: "gamma/last", why: "unavailable (no credentials)", reason: "another long reason" },
			],
		}),
		"Used fallback beta/other because alpha/paid is usage-limited until tomorrow; gamma/last is unavailable (no credentials).",
	);
});
