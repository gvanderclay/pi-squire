import { createHash } from "node:crypto";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Agent, Thinking } from "./agents.ts";
import { candidateProblem, modelProblem, type Skipped } from "./model-choice.ts";
import { locateSession, sessionIdOf } from "./result-sessions.ts";
import type { StartedRecorded } from "./results.ts";
import { type ModelFact, type QuotaFact, resolveRouting } from "./routing.ts";
import { routingMarkPolicy } from "./routing-availability.ts";
import { parseRoutingRequest, readRoutingPolicy } from "./routing-policy.ts";
import { type ActiveBranch, authorProof, type ProvenanceEntry, readActiveBranch } from "./routing-provenance.ts";
import type { AuthorProof, RoutingPolicy, RoutingRecord, RoutingRequest } from "./routing-types.ts";
import { createRoutingUsage } from "./routing-usage.ts";
import { toolMatches } from "./tool-names.ts";
import type { Proactive } from "./usage.ts";

export type RoutedChoice = {
	model: string;
	thinking: string;
	rest: string[];
	skipped: Skipped[];
	notices: string[];
	routing: RoutingRecord;
};
export type RouteOptions = { model?: string; thinking?: Thinking };
export function createRoutingDispatch(
	pi: Pick<ExtensionAPI, "events" | "getAllTools">,
	find: (id: string, ctx: ExtensionContext) => StartedRecorded | undefined,
	tools: (agent: Agent) => string[],
	proactive: Proactive,
): { choose(agent: Agent, request: unknown, ctx: ExtensionContext, options: RouteOptions): Promise<RoutedChoice> } {
	const usage: ReturnType<typeof createRoutingUsage> = createRoutingUsage(pi);
	return {
		async choose(agent: Agent, value: unknown, ctx: ExtensionContext, options: RouteOptions): Promise<RoutedChoice> {
			if (!agent.routingProfile) throw new Error("role has no routing_profile; routed dispatch refused");
			const request: RoutingRequest = parseRoutingRequest(value);
			const policy: RoutingPolicy = readRoutingPolicy(getAgentDir());
			const authors: AuthorProof[] = (request.review?.authors ?? []).map((source) => proof(source, ctx, policy, find));
			const facts: Record<string, ModelFact> = registryFacts(policy, ctx);
			const quota: Record<string, QuotaFact> = usage.read(policy, Date.now());
			const selectedTools: string[] = requiredTools(agent, tools, request, pi.getAllTools());
			const preliminary = resolveRouting(
				policy,
				agent.routingProfile,
				request,
				{ facts, tools: selectedTools, authors },
				options,
			);
			const notices: string[] = [];
			for (const candidate of preliminary.candidates) {
				const problem = await candidateProblem(
					candidate.model,
					ctx.modelRegistry,
					proactive,
					notices,
					quota[candidate.model] === undefined,
					routingMarkPolicy(
						candidate.model.slice(0, candidate.model.indexOf("/")),
						policy.usage?.applicableProviders ?? [],
					),
				);
				facts[candidate.model].problem = problem?.reason;
			}
			const resolved: ReturnType<typeof resolveRouting> = resolveRouting(
				policy,
				agent.routingProfile,
				request,
				{ facts, tools: selectedTools, authors, quota },
				options,
			);
			const selected: (typeof resolved.candidates)[number] = resolved.candidates[0];
			const routing: RoutingRecord = {
				version: 1,
				policyVersion: policy.version,
				policyDigest: createHash("sha256").update(JSON.stringify(policy)).digest("hex"),
				profile: agent.routingProfile,
				role: agent.name,
				pool: resolved.pool,
				request,
				independentReview: resolved.independentReview,
				authors,
				excludedFamilies: resolved.excludedFamilies,
				models: policy.models,
				usageProviders: policy.usage?.applicableProviders ?? [],
				candidates: resolved.candidates,
				excluded: resolved.excluded,
				observations: observe(facts, quota, selectedTools),
				selected: selected.model,
				reason: "qualified route preview; tie is admitted at dispatch",
			};
			return routedChoice(routing, resolved.excluded, notices);
		},
	};
}
function observe(
	facts: Record<string, ModelFact>,
	quota: Record<string, QuotaFact>,
	tools: string[],
): NonNullable<RoutingRecord["observations"]> {
	return {
		at: Date.now(),
		quota,
		tools,
		models: Object.fromEntries(
			Object.entries(facts).map(([model, { problem, contextWindow, input }]) => [
				model,
				{ problem, contextWindow, input },
			]),
		),
	};
}

function routedChoice(
	routing: RoutingRecord,
	excluded: { model: string; reason: string }[],
	notices: string[],
): RoutedChoice {
	const selected: RoutingRecord["candidates"][number] = routing.candidates[0];
	return {
		model: selected.model,
		thinking: selected.effectiveThinking,
		rest: routing.candidates.slice(1).map((candidate) => candidate.model),
		skipped: excluded.map((item) => ({ ...item, why: item.reason })),
		notices,
		routing,
	};
}

function requiredTools(
	agent: Agent,
	tools: (agent: Agent) => string[],
	request: RoutingRequest,
	known: ReturnType<ExtensionAPI["getAllTools"]>,
): string[] {
	const selected: string[] = tools(agent);
	// Requirement names must be literal and registered selection patterns must actually cover them.
	return (request.requirements?.tools ?? []).filter(
		(name) =>
			known.some((tool) => tool.name === name && tool.exposure !== "hidden") &&
			selected.some((pattern) => toolMatches(pattern, name)),
	);
}
function registryFacts(policy: RoutingPolicy, ctx: ExtensionContext): Record<string, ModelFact> {
	const facts: Record<string, ModelFact> = {};
	for (const name of Object.keys(policy.models)) {
		const slash: number = name.indexOf("/");
		const provider: string = name.slice(0, slash);
		const id: string = name.slice(slash + 1);
		const model: ReturnType<typeof ctx.modelRegistry.find> = ctx.modelRegistry.find(provider, id);
		const problem: string | undefined =
			modelProblem(name, ctx.modelRegistry) ??
			(model?.api === "pi-virtual" ? "virtual/opaque models are not eligible routing candidates" : undefined);
		facts[name] = {
			problem,
			contextWindow: model?.contextWindow,
			input: model?.input,
			effectiveThinking: (requested: Thinking): Thinking => (model ? clampThinkingLevel(model, requested) : "off"),
		};
	}
	return facts;
}
function proof(
	source: string,
	ctx: ExtensionContext,
	policy: RoutingPolicy,
	find: (id: string, ctx: ExtensionContext) => StartedRecorded | undefined,
): AuthorProof {
	if (source === "self") {
		const branch: ActiveBranch = {
			sessionId: ctx.sessionManager.getSessionId(),
			leafId: ctx.sessionManager.getLeafId(),
			entries: ctx.sessionManager.getBranch() as ProvenanceEntry[],
		};
		return authorProof(source, branch, policy.models);
	}
	const record: StartedRecorded | undefined = find(source, ctx);
	if (!record)
		throw new Error(`unknown author source ${source}; use self or a known delegation id, not a model family`);
	const path: string | undefined = locateSession(record, ctx.sessionManager.getSessionDir());
	if (!path) throw new Error(`author ${source}: session provenance unavailable`);
	const branch: ActiveBranch = readActiveBranch(path);
	if (branch.sessionId !== sessionIdOf(record)) throw new Error(`author ${source}: session identity mismatch`);
	return authorProof(source, branch, policy.models);
}
