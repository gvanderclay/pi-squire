import { readFileSync, statSync } from "node:fs";
import { Value } from "typebox/value";
import { reviewFamilies } from "./routing.ts";
import { parseRuntimeRouting } from "./routing-record.ts";
import { RoutingEvidenceSchema } from "./routing-schema.ts";
import type { AuthorProof, ModelPolicy, RoutingEvidence, RoutingRecord, ServedModel } from "./routing-types.ts";

export const ROUTING_ATTEMPT = "delegate-routing-attempt";
export const ROUTING_FALLBACK = "delegate-routing-fallback";
export type ProvenanceEntry = {
	id: string;
	parentId: string | null;
	type: string;
	fromId?: unknown;
	message?: { role?: string; provider?: string; model?: string; thinkingLevel?: string; api?: string };
	customType?: string;
	data?: unknown;
};
export type ActiveBranch = { sessionId: string; leafId: string | null; entries: ProvenanceEntry[] };
/** Read-only v2/v3 walk. Never SessionManager.open(): it can migrate/rewrite files. Corruption is not absence. */
export function readActiveBranch(path: string): ActiveBranch & { history: ProvenanceEntry[] } {
	if (statSync(path).size > 64 * 1024 * 1024) throw new Error("session provenance exceeds 64 MiB; unknown");
	const rows: unknown[] = readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as unknown);
	const header: { type?: unknown; id?: unknown; version?: unknown } = rows.shift() as object;
	if (header?.type !== "session" || typeof header.id !== "string" || ![2, 3].includes(header.version as number))
		throw new Error("unsupported or missing session header; provenance unknown");
	const entries: Map<string, ProvenanceEntry> = new Map();
	let leaf: string | null = null;
	for (const raw of rows) {
		const entry: ProvenanceEntry = raw as ProvenanceEntry;
		if (
			!entry ||
			typeof entry.type !== "string" ||
			typeof entry.id !== "string" ||
			(entry.parentId !== null && typeof entry.parentId !== "string") ||
			entries.has(entry.id)
		)
			throw new Error("invalid/duplicate session entry; provenance unknown");
		entries.set(entry.id, entry);
		leaf = entry.id;
	}
	const branch: ProvenanceEntry[] = [];
	const seen: Set<string> = new Set();
	for (let id: string | null = leaf; id !== null; ) {
		const entry: ProvenanceEntry | undefined = entries.get(id);
		if (!entry || seen.has(id)) throw new Error("broken/cyclic session branch; provenance unknown");
		seen.add(id);
		branch.unshift(entry);
		id = entry.parentId;
	}
	return { sessionId: header.id, leafId: leaf, entries: branch, history: [...entries.values()] };
}
export function servedModels(entries: readonly ProvenanceEntry[]): ServedModel[] {
	const served: ServedModel[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const message: NonNullable<ProvenanceEntry["message"]> = entry.message;
		if (
			typeof message.provider !== "string" ||
			!message.provider ||
			typeof message.model !== "string" ||
			!message.model ||
			message.api === "pi-virtual"
		)
			throw new Error("assistant physical model provenance is unknown");
		served.push({
			model: `${message.provider}/${message.model}`,
			entryId: entry.id,
			...(typeof message.thinkingLevel === "string" ? { thinking: message.thinkingLevel } : {}),
		});
	}
	return served;
}
export function authorProof(source: string, branch: ActiveBranch, models: Record<string, ModelPolicy>): AuthorProof {
	const served: ServedModel[] = servedModels(branch.entries);
	if (!served.length) throw new Error(`author ${source} has no served assistant provenance`);
	const unknown: ServedModel | undefined = served.find((item) => !Object.hasOwn(models, item.model));
	if (unknown)
		throw new Error(
			`author ${source}: unknown lineage for actual model ${unknown.model}; add exact physical metadata to routing.models`,
		);
	return {
		source,
		sessionId: branch.sessionId,
		leafId: branch.leafId,
		models: [...new Set(served.map((item) => item.model))],
		families: [...new Set(served.map((item) => models[item.model].family))],
	};
}
/** Only messages after this attempt's marker count as review work; inherited fork/resume context is not a review. */
export function routingEvidence(route: RoutingRecord, path: string | undefined): RoutingEvidence {
	const evidence: RoutingEvidence = {
		served: [],
		fallbacks: [],
		complete: false,
		independent: route.independentReview ? "unverified" : "not-required",
		reasons: [],
	};
	try {
		parseRuntimeRouting(route);
		if (!path || !route.launchId) throw new Error("attempt session/boundary unavailable");
		const branch: ActiveBranch = readActiveBranch(path);
		const index: number = branch.entries.findIndex(
			(entry) =>
				entry.type === "custom" &&
				entry.customType === ROUTING_ATTEMPT &&
				(entry.data as { launchId?: unknown } | undefined)?.launchId === route.launchId,
		);
		if (index < 0) throw new Error("attempt marker is absent on the active branch");
		if (JSON.stringify(branch.entries[index].data) !== JSON.stringify(route))
			throw new Error("attempt metadata does not match the recorded dispatch");
		const excluded: string[] = reviewFamilies(route.models, route.request, route.authors, route.independentReview);
		if (JSON.stringify(excluded) !== JSON.stringify(route.excludedFamilies))
			throw new Error("author exclusions are incomplete");
		const later: number = branch.entries.findIndex(
			(entry, at) => at > index && entry.type === "custom" && entry.customType === ROUTING_ATTEMPT,
		);
		const attempt: ProvenanceEntry[] = branch.entries.slice(index + 1, later < 0 ? undefined : later);
		evidence.served = servedModels(attempt);
		evidence.fallbacks = fallbackHistory(attempt);
		if (!evidence.served.length) throw new Error("attempt has no served assistant messages");
		const outside: ServedModel | undefined = evidence.served.find(
			(item) => !route.candidates.some((candidate) => candidate.model === item.model),
		);
		if (outside) throw new Error(`actual model ${outside.model} was outside the frozen route`);
		if (evidence.served.some((item) => !item.thinking))
			throw new Error("actual effective thinking provenance is incomplete");
		if (evidence.served.some((item) => route.excludedFamilies.includes(route.models[item.model]?.family)))
			throw new Error("served history overlaps an author family");
		evidence.complete = true;
		if (route.independentReview) evidence.independent = "verified";
	} catch (error) {
		evidence.reasons.push(String((error as Error).message));
	}
	return evidence;
}
function fallbackHistory(entries: ProvenanceEntry[]): RoutingEvidence["fallbacks"] {
	const observations: unknown[] = entries
		.filter((entry) => entry.type === "custom" && entry.customType === ROUTING_FALLBACK)
		.map((entry) => entry.data);
	if (!Value.Check(RoutingEvidenceSchema.properties.fallbacks, observations))
		throw new Error("invalid fallback provenance");
	return observations;
}
