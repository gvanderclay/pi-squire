import type { StartedRecorded } from "./result-types.ts";
import { parseRuntimeRouting } from "./routing-record.ts";
import type { RoutingEvidence } from "./routing-types.ts";

/** Restored routed records cannot quietly become legacy records or verified results with missing evidence. */
export function validateRoutingMetadata(record: StartedRecorded): void {
	if (Object.hasOwn(record, "routing") || Object.hasOwn(record, "routingVersion")) {
		if (record.routingVersion !== 1) throw new Error("unsupported/missing routing record version; restoration blocked");
		const route = parseRuntimeRouting(record.routing);
		if (route.launchId !== record.id || route.role !== record.agent || route.selected !== record.model)
			throw new Error("routing attempt identity/model mismatch; restoration blocked");
	}
	const evidence: RoutingEvidence | undefined = record.result?.routingEvidence;
	if (evidence === undefined) return;
	if (
		!record.routing ||
		!evidence ||
		typeof evidence.complete !== "boolean" ||
		!["verified", "not-required", "unverified"].includes(evidence.independent) ||
		!Array.isArray(evidence.served) ||
		!Array.isArray(evidence.fallbacks) ||
		!Array.isArray(evidence.reasons)
	)
		throw new Error("invalid restored routing evidence; restoration blocked");
	if (
		evidence.independent === "verified" &&
		(!evidence.complete || !record.routing.independentReview || !evidence.served.length)
	)
		throw new Error("incomplete restored independent-review evidence; restoration blocked");
	if (
		evidence.served.some(
			(item) =>
				!item ||
				typeof item.model !== "string" ||
				typeof item.entryId !== "string" ||
				(item.thinking !== undefined && typeof item.thinking !== "string"),
		) ||
		evidence.reasons.some((reason) => typeof reason !== "string")
	)
		throw new Error("invalid served-model provenance; restoration blocked");
}
