import { isThinking } from "./agents.ts";
import { reviewFamilies } from "./routing.ts";
import { parseRoutingPolicy, parseRoutingRequest } from "./routing-policy.ts";
import type { RoutingRecord } from "./routing-types.ts";

/** Validate a restored frozen attempt. Bad routed metadata disables fallback, never uses the legacy chain. */
export function parseRuntimeRouting(value: unknown): RoutingRecord {
	const route: RoutingRecord = value as RoutingRecord;
	if (
		route?.version !== 1 ||
		route.policyVersion !== 1 ||
		typeof route.launchId !== "string" ||
		!route.launchId ||
		typeof route.profile !== "string" ||
		typeof route.role !== "string" ||
		typeof route.policyDigest !== "string" ||
		!Array.isArray(route.candidates) ||
		!route.candidates.length ||
		!Array.isArray(route.usageProviders) ||
		route.usageProviders.some((provider) => typeof provider !== "string") ||
		!Array.isArray(route.authors) ||
		!Array.isArray(route.excludedFamilies)
	)
		throw new Error("invalid frozen routing record");
	assertSelection(route);
	parseRoutingRequest(route.request);
	const policy = parseRoutingPolicy({
		version: 1,
		models: route.models,
		profiles: {
			[route.profile]: {
				pool: route.pool,
				routes: {
					[route.request.category]: {
						minQuality: 0,
						candidates: route.candidates.map(({ model, thinking, quality, priority }) => ({
							model,
							thinking,
							quality,
							...(priority === undefined ? {} : { priority }),
						})),
					},
				},
			},
		},
	});
	for (const candidate of route.candidates) {
		if (
			candidate.family !== policy.models[candidate.model].family ||
			!isThinking(candidate.effectiveThinking) ||
			route.excludedFamilies.includes(candidate.family)
		)
			throw new Error("frozen routing lineage/effort constraint mismatch");
		if (
			policy.models[candidate.model].data === "public-only" &&
			!(route.request.data === "public" && route.request.safePublicContext === true)
		)
			throw new Error("public-only frozen candidate without attestation");
	}
	if (
		typeof route.independentReview !== "boolean" ||
		(route.independentReview &&
			(!route.request.review?.authors.length || route.authors.length !== route.request.review.authors.length))
	)
		throw new Error("incomplete frozen review provenance");
	const excluded: string[] = reviewFamilies(route.models, route.request, route.authors, route.independentReview);
	if (JSON.stringify(excluded) !== JSON.stringify(route.excludedFamilies))
		throw new Error("frozen author family exclusions mismatch");
	return structuredClone(route);
}
function assertSelection(route: RoutingRecord): void {
	if (
		typeof route.selected !== "string" ||
		!route.candidates.some((candidate) => candidate.model === route.selected) ||
		typeof route.reason !== "string"
	)
		throw new Error("missing frozen route selection/reason");
}
