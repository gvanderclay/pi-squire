import { type RoutingInputs, resolveRouting } from "../src/routing.ts";
import { parseRoutingPolicy } from "../src/routing-policy.ts";
import type { RoutingPolicy, RoutingRecord } from "../src/routing-types.ts";

export const MODEL_A = "alpha/route-a";
export const MODEL_B = "beta/route-b";
export const MODEL_D = "gateway/public-model";
export const MODELS = [
	{
		provider: "alpha",
		id: "route-a",
		api: "anthropic-messages",
		reasoning: true,
		contextWindow: 200000,
		input: ["text", "image"] as ("text" | "image")[],
	},
	{
		provider: "beta",
		id: "route-b",
		api: "openai-responses",
		reasoning: true,
		contextWindow: 200000,
		input: ["text"] as ("text" | "image")[],
	},
	{
		provider: "gateway",
		id: "public-model",
		api: "openai-completions",
		reasoning: true,
		contextWindow: 64000,
		input: ["text"] as ("text" | "image")[],
	},
];
export function policy(): RoutingPolicy {
	const peers = [
		{ model: MODEL_A, thinking: "high", quality: 2 },
		{ model: MODEL_B, thinking: "max", quality: 2 },
	];
	const routes = {
		standard: { minQuality: 2, candidates: peers },
		bounded: {
			minQuality: 1,
			candidates: [{ model: MODEL_D, thinking: "max", quality: 2 }, ...peers.map((c) => ({ ...c, priority: 1 }))],
		},
	};
	return parseRoutingPolicy({
		version: 1,
		models: {
			[MODEL_A]: { family: "anthropic", data: "any", capabilities: ["code"] },
			[MODEL_B]: { family: "openai", data: "any", capabilities: ["code"] },
			[MODEL_D]: { family: "deepseek", data: "public-only", capabilities: ["code"] },
			"alpha/fast-model": { family: "anthropic", data: "any" },
			"beta/other-model": { family: "openai", data: "any" },
		},
		profiles: { worker: { pool: "coding", routes }, reviewer: { pool: "coding", independentReview: true, routes } },
	});
}
export function inputs(): RoutingInputs {
	return {
		facts: Object.fromEntries(
			MODELS.map((m) => [
				`${m.provider}/${m.id}`,
				{ contextWindow: m.contextWindow, input: m.input, effectiveThinking: (level) => level },
			]),
		),
		tools: ["read", "bash"],
		authors: [],
	};
}
export function frozenRoute(): RoutingRecord {
	const p = policy();
	const request = { category: "standard", data: "private" } as const;
	const resolved = resolveRouting(p, "worker", request, inputs());
	return {
		version: 1,
		policyVersion: 1,
		policyDigest: "fixture",
		profile: "worker",
		role: "worker",
		pool: "coding",
		request,
		models: p.models,
		usageProviders: [],
		candidates: resolved.candidates,
		authors: [],
		excludedFamilies: [],
		independentReview: false,
		selected: MODEL_A,
		reason: "fixture",
		launchId: "launch-fixture",
	};
}
