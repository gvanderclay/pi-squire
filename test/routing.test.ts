import assert from "node:assert/strict";
import { test } from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { parse, parseResume } from "../src/delegate-request.ts";
import { orderRoutingTies, resolveRouting } from "../src/routing.ts";
import { parseRoutingPolicy, parseRoutingRequest } from "../src/routing-policy.ts";
import { createRoutingUsage } from "../src/routing-usage.ts";
import { inputs, MODEL_A, MODEL_B, MODEL_D, policy } from "./routing-fixtures.ts";

test("strict policy/request parsers reject unknown versions, fields, models, efforts and incomplete metadata", () => {
	const p = policy();
	for (const invalid of [
		{ ...p, version: 2 },
		{ ...p, typo: true },
		{
			...p,
			profiles: {
				wrong: {
					pool: "coding",
					routes: { standard: { minQuality: 1, candidates: [{ model: "sonnet", thinking: "high", quality: 1 }] } },
				},
			},
		},
	])
		assert.throws(() => parseRoutingPolicy(invalid));
	assert.throws(
		() => parseRoutingPolicy({ ...p, models: { [MODEL_A]: { family: "anthropic", data: "sometimes" } } }),
		/data/,
	);
	for (const value of [
		undefined,
		{},
		{ category: "standard" },
		{ category: "cheap", data: "private" },
		{ category: "standard", data: "unknown", safePublicContext: true },
		{ category: "standard", data: "private", review: { families: ["anthropic"] } },
	])
		assert.throws(() => parseRoutingRequest(value));
	const clone = parseRoutingPolicy(p);
	clone.models[MODEL_A].family = "changed";
	assert.equal(p.models[MODEL_A].family, "anthropic");
});

test("pure routing preserves peer quality, priority and candidate-specific clamping", () => {
	const p = policy();
	const facts = inputs();
	facts.facts[MODEL_B].effectiveThinking = () => "xhigh";
	const resolved = resolveRouting(p, "worker", { category: "standard", data: "private" }, facts);
	assert.deepEqual(
		resolved.candidates.map((c) => [c.model, c.thinking, c.effectiveThinking]),
		[
			[MODEL_A, "high", "high"],
			[MODEL_B, "max", "xhigh"],
		],
	);
	assert.deepEqual(
		Array.from({ length: 4 }, (_, turn) => orderRoutingTies(resolved.candidates, turn)[0].family),
		["anthropic", "openai", "anthropic", "openai"],
	);
	for (const data of ["private", "public", "unknown"] as const) {
		const result = resolveRouting(p, "worker", { category: "bounded", data }, facts);
		assert.ok(result.candidates.every((c) => c.model !== MODEL_D));
	}
	const publicRoute = resolveRouting(
		p,
		"worker",
		{ category: "bounded", data: "public", safePublicContext: true },
		facts,
	);
	for (let turn = 0; turn < 6; turn++) assert.equal(orderRoutingTies(publicRoute.candidates, turn)[0].model, MODEL_D);
});

test("genuine family ties rotate independently of candidate input order", () => {
	const candidates = resolveRouting(policy(), "worker", { category: "standard", data: "private" }, inputs()).candidates;
	const families = Array.from(
		{ length: 6 },
		(_, turn) => orderRoutingTies(turn % 2 ? candidates.toReversed() : candidates, turn)[0].family,
	);
	assert.deepEqual(families, ["anthropic", "openai", "anthropic", "openai", "anthropic", "openai"]);
	for (const turn of [0, 1, 2, 3])
		assert.equal(
			orderRoutingTies(candidates, turn)[0].family,
			orderRoutingTies(candidates.toReversed(), turn)[0].family,
		);
});

test("hard input/context/tool/capability/floor constraints apply even to explicit overrides", () => {
	const p = policy();
	const facts = inputs();
	for (const request of [
		{ category: "standard", data: "private", requirements: { input: ["image"] } },
		{ category: "standard", data: "private", requirements: { contextTokens: 300000 } },
		{ category: "standard", data: "private", requirements: { tools: ["edit"] } },
		{ category: "standard", data: "private", requirements: { capabilities: ["vision"] } },
	] as const)
		assert.throws(() => resolveRouting(p, "worker", parseRoutingRequest(request), facts, { model: MODEL_B }));
	p.profiles.worker.routes.standard!.minQuality = 3;
	assert.throws(
		() => resolveRouting(p, "worker", { category: "standard", data: "private" }, facts),
		/below route floor/,
	);
	assert.throws(
		() => resolveRouting(policy(), "worker", { category: "deep", data: "private" }, facts),
		/no deep route/,
	);
});

test("availability/exhaustion filter before tie and advisory pressure only breaks otherwise meaningful ties", () => {
	const p = policy();
	const facts = inputs();
	facts.facts[MODEL_A].problem = "no auth";
	assert.equal(
		resolveRouting(p, "worker", { category: "standard", data: "private" }, facts).candidates[0].model,
		MODEL_B,
	);
	delete facts.facts[MODEL_A].problem;
	facts.quota = { [MODEL_A]: { exhausted: true, pressured: true } };
	assert.throws(
		() => resolveRouting(p, "worker", { category: "standard", data: "private" }, facts, { model: MODEL_A }),
		/quota is exhausted/,
	);
	facts.quota[MODEL_A].exhausted = false;
	const resolved = resolveRouting(p, "worker", { category: "standard", data: "private" }, facts);
	assert.equal(orderRoutingTies(resolved.candidates, 0)[0].model, MODEL_B);
});

test("independent review excludes every actual author family and explicit override never restores a fallback chain", () => {
	const p = policy();
	const request = parseRoutingRequest({ category: "standard", data: "private", review: { authors: ["self"] } });
	assert.throws(() => resolveRouting(p, "reviewer", request, inputs()), /known author sources/);
	const facts = inputs();
	facts.authors = [{ source: "self", sessionId: "parent", leafId: "leaf", models: [MODEL_A], families: ["anthropic"] }];
	assert.deepEqual(
		resolveRouting(p, "reviewer", request, facts).candidates.map((c) => c.model),
		[MODEL_B],
	);
	assert.throws(() => resolveRouting(p, "reviewer", request, facts, { model: MODEL_A }), /author history/);
	assert.deepEqual(
		resolveRouting(p, "worker", { category: "standard", data: "private" }, inputs(), {
			model: MODEL_B,
			thinking: "low",
		}).candidates.map((c) => [c.model, c.thinking]),
		[[MODEL_B, "low"]],
	);
	facts.authors[0].families.push("openai");
	facts.authors[0].models.push(MODEL_B);
	assert.throws(() => resolveRouting(p, "reviewer", request, facts), /no qualified route/);
});

test("cached usage snapshot adapter requires fresh account applicability; unknown is never zero/exhausted", () => {
	const events = createEventBus();
	const adapter = createRoutingUsage({ events });
	const p = policy();
	const now = 1000000;
	const emit = (overrides = {}) =>
		events.emit("usage-status:snapshot", {
			version: 1,
			provider: "codex",
			piProvider: "beta",
			observedAt: now,
			windows: [{ label: "7d", percent: 100, resetsAt: now + 100000 }],
			unavailable: null,
			...overrides,
		});
	emit();
	assert.deepEqual(adapter.read(p, now), {});
	p.usage = { maxAgeMs: 1000, applicableProviders: ["beta"] };
	assert.equal(adapter.read(p, now)[MODEL_B].exhausted, true);
	assert.deepEqual(adapter.read(p, now + 1001), {});
	emit({ observedAt: now + 1 });
	assert.deepEqual(adapter.read(p, now), {});
	emit({ unavailable: "no data", observedAt: null, windows: [] });
	assert.deepEqual(adapter.read(p, now), {});
	emit({ windows: [{ label: "reset", percent: 100, resetsAt: now - 1 }] });
	assert.deepEqual(adapter.read(p, now), {});
});

test("slash launch and resume accept the same routing JSON, retaining the verbatim task", () => {
	const json = JSON.stringify({ category: "bounded", data: "unknown" });
	const quoted = JSON.stringify(json);
	assert.deepEqual(parse(`worker --routing ${quoted} do --not parse task`), {
		parsed: { agent: "worker", routing: JSON.parse(json), task: "do --not parse task" },
	});
	assert.deepEqual(parseResume(`old-id --routing ${quoted} go`), {
		request: { id: "old-id", routing: JSON.parse(json), task: "go" },
	});
	assert.ok("error" in parse("worker --routing garbage go"));
});
