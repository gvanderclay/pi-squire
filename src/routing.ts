import type { Thinking } from "./agents.ts";
import type {
	AuthorProof,
	Candidate,
	ModelPolicy,
	RouteCandidate,
	RoutingPolicy,
	RoutingRequest,
} from "./routing-types.ts";

export type ModelFact = {
	problem?: string;
	contextWindow?: number;
	input?: readonly string[];
	effectiveThinking: (requested: Thinking) => Thinking;
};
export type QuotaFact = { exhausted: boolean; pressured: boolean; observedAt?: number };
export type RoutingInputs = {
	facts: Record<string, ModelFact>;
	tools: readonly string[];
	authors: AuthorProof[];
	quota?: Record<string, QuotaFact>;
};
export type Resolution = {
	candidates: Candidate[];
	excluded: { model: string; reason: string }[];
	excludedFamilies: string[];
	independentReview: boolean;
	pool: string;
};
type Override = { model?: string; thinking?: Thinking };
type Route = { minQuality: number; candidates: RouteCandidate[] };

/** Pure eligibility/ranking: injected registry, availability, quota and provenance facts; never consumes tie state. */
export function resolveRouting(
	policy: RoutingPolicy,
	profileName: string,
	request: RoutingRequest,
	inputs: RoutingInputs,
	override?: Override,
): Resolution {
	const profile: RoutingPolicy["profiles"][string] | undefined = Object.hasOwn(policy.profiles, profileName)
		? policy.profiles[profileName]
		: undefined;
	if (!profile) throw new Error(`unknown routing profile ${profileName}`);
	const route: Route | undefined = profile.routes[request.category];
	if (!route) throw new Error(`profile ${profileName} has no ${request.category} route`);
	const independentReview: boolean = profile.independentReview === true || request.review !== undefined;
	const excludedFamilies: string[] = reviewFamilies(policy.models, request, inputs.authors, independentReview);
	const missingTools: string[] = (request.requirements?.tools ?? []).filter((tool) => !inputs.tools.includes(tool));
	if (missingTools.length) throw new Error(`routing requires unavailable role tools: ${missingTools.join(", ")}`);
	const { candidates, excluded } = eligibleCandidates(policy, route, request, inputs, excludedFamilies, override);
	if (!candidates.length)
		throw new Error(
			`no qualified route for ${profileName}/${request.category}${override?.model ? ` (explicit model ${override.model}; must be a qualified route candidate)` : ""}:\n${excluded.map((item) => `- ${item.model}: ${item.reason}`).join("\n")}`,
		);
	candidates.sort(compareCandidates);
	return { candidates, excluded, excludedFamilies, independentReview, pool: profile.pool };
}
/** Families are derived from exact served model ids in provenance inputs, never caller family assertions. */
export function reviewFamilies(
	models: Record<string, ModelPolicy>,
	request: RoutingRequest,
	authors: AuthorProof[],
	required: boolean,
): string[] {
	const sources: string[] = request.review?.authors ?? [];
	if (required && (!sources.length || authors.length !== sources.length))
		throw new Error("independent review requires known author sources: self and/or known delegation ids");
	const families: Set<string> = new Set();
	for (const [index, author] of authors.entries()) {
		if (
			!author ||
			author.source !== sources[index] ||
			typeof author.sessionId !== "string" ||
			!author.sessionId ||
			(author.leafId !== null && typeof author.leafId !== "string") ||
			!Array.isArray(author.models) ||
			!author.models.length
		)
			throw new Error("author provenance is incomplete");
		for (const model of author.models) {
			if (!Object.hasOwn(models, model)) throw new Error(`unknown author model lineage ${model}`);
			families.add(models[model].family);
		}
	}
	return [...families];
}
function eligibleCandidates(
	policy: RoutingPolicy,
	route: Route,
	request: RoutingRequest,
	inputs: RoutingInputs,
	families: string[],
	override?: Override,
): Pick<Resolution, "candidates" | "excluded"> {
	const candidates: Candidate[] = [];
	const excluded: Resolution["excluded"] = [];
	for (const entry of route.candidates) {
		if (override?.model !== undefined && override.model !== entry.model) continue;
		const metadata: ModelPolicy = policy.models[entry.model];
		const fact: ModelFact | undefined = inputs.facts[entry.model];
		const reason: string | undefined =
			candidateProblem(entry.quality, route.minQuality, metadata, fact, request, families) ??
			(inputs.quota?.[entry.model]?.exhausted ? "applicable fresh quota is exhausted" : undefined);
		if (reason || !fact) {
			excluded.push({ model: entry.model, reason: reason ?? "no registry facts" });
			continue;
		}
		const thinking: Thinking = override?.thinking ?? entry.thinking;
		candidates.push({
			...entry,
			...metadata,
			thinking,
			effectiveThinking: fact.effectiveThinking(thinking),
			pressure: inputs.quota?.[entry.model]?.pressured === true,
		});
	}
	return { candidates, excluded };
}
function candidateProblem(
	quality: number,
	floor: number,
	meta: ModelPolicy,
	fact: ModelFact | undefined,
	request: RoutingRequest,
	excludedFamilies: string[],
): string | undefined {
	if (!meta) return "missing model policy metadata";
	if (meta.data === "public-only" && !(request.data === "public" && request.safePublicContext === true))
		return "public-only model requires public data and safePublicContext attestation";
	if (excludedFamilies.includes(meta.family)) return `family ${meta.family} occurs in supplied author history`;
	if (quality < floor) return `quality ${quality} is below route floor ${floor}`;
	if (!fact || fact.problem) return fact?.problem ?? "model is not in the registry";
	return capabilityProblem(meta, fact, request);
}
function capabilityProblem(meta: ModelPolicy, fact: ModelFact, request: RoutingRequest): string | undefined {
	const requirements: RoutingRequest["requirements"] = request.requirements;
	if ((requirements?.contextTokens ?? 0) > (fact.contextWindow ?? 0)) return "insufficient or unknown context window";
	if (requirements?.input?.some((type) => !fact.input?.includes(type))) return "incompatible input";
	if (requirements?.capabilities?.some((capability) => !meta.capabilities?.includes(capability)))
		return "missing required capability";
	return undefined;
}
export function compareCandidates(a: Candidate, b: Candidate): number {
	return (a.priority ?? 0) - (b.priority ?? 0) || b.quality - a.quality || Number(a.pressure) - Number(b.pressure);
}
export function tiedFamilies(candidates: readonly Candidate[]): string[] {
	const first: Candidate | undefined = candidates[0];
	return first
		? [
				...new Set(
					candidates
						.filter((candidate) => compareCandidates(first, candidate) === 0)
						.map((candidate) => candidate.family),
				),
			]
		: [];
}
/** Family-balanced tie order; multiple endpoints for one lineage never buy it extra turns. */
export function orderRoutingTies(candidates: readonly Candidate[], turn: number): Candidate[] {
	const first: Candidate | undefined = candidates[0];
	if (!first) return [];
	const families: string[] = tiedFamilies(candidates).sort();
	const family: string = families[turn % families.length];
	const chosen: Candidate =
		candidates.find((candidate) => candidate.family === family && compareCandidates(first, candidate) === 0) ?? first;
	return [chosen, ...candidates.filter((candidate) => candidate !== chosen)];
}
