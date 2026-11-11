import { mkdtempSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "./agents.ts";
import { type ProvenanceEntry, ROUTING_ATTEMPT, readActiveBranch } from "./routing-provenance.ts";
import { parseRuntimeRouting } from "./routing-record.ts";
import type { RoutingRecord, RoutingRequest } from "./routing-types.ts";

export type RoutingSource = { path: string; sessionId: string };

/** Pi evaluates --fork asynchronously. Give it the checked bytes, never the mutable original path. */
export function snapshotRoutingSource(agent: Agent, source: RoutingSource, request: RoutingRequest): string {
	if (statSync(source.path).size > 64 * 1024 * 1024) throw new Error("session provenance exceeds 64 MiB; unknown");
	const directory: string = mkdtempSync(join(tmpdir(), "pi-squire-source-"));
	const path: string = join(directory, "source.jsonl");
	try {
		writeFileSync(path, readFileSync(source.path), { mode: 0o600, flag: "wx" });
		assertRoutingSource(agent, { ...source, path }, request);
		// Like prompt files, keep it until OS cleanup: openWindow may return before Pi has copied it.
		return path;
	} catch (error) {
		rmSync(path, { force: true });
		rmdirSync(directory);
		throw error;
	}
}
const STATE_ONLY: ReadonlySet<string> = new Set([
	"model_change",
	"thinking_level_change",
	"session_info",
	"label",
	"usage",
	"custom",
]);
const isAttempt = (entry: ProvenanceEntry): boolean => entry.type === "custom" && entry.customType === ROUTING_ATTEMPT;

/** Legacy formats remain on their old path unless the file itself contains routed history. */
function hasRoutingHistory(path: string): boolean {
	return readFileSync(path, "utf8")
		.split("\n")
		.some((line) => {
			try {
				return isAttempt(JSON.parse(line) as ProvenanceEntry);
			} catch {
				// A damaged routing marker is not permission to drop back to legacy.
				return line.includes(ROUTING_ATTEMPT);
			}
		});
}

/**
 * Inspect the actual source, not a named delegation's possibly older record.
 * All persisted attempts bind the profile; only active ancestry is model context.
 * Fork callers validate a private snapshot before using it as the copy source.
 */
export function assertRoutingSource(agent: Agent, source: RoutingSource, request: RoutingRequest | undefined): void {
	if (!agent.routingProfile && !hasRoutingHistory(source.path)) return;
	const branch: ReturnType<typeof readActiveBranch> = readActiveBranch(source.path);
	if (branch.sessionId !== source.sessionId) throw new Error("routed source session identity mismatch");
	const attempts: Map<string, RoutingRecord> = new Map();
	for (const entry of branch.history.filter(isAttempt)) {
		if (!agent.routingProfile)
			throw new Error("routing_profile removed; resume/fork refused to discard persisted routing guarantees");
		const route: RoutingRecord = parseRuntimeRouting(entry.data);
		if (route.profile !== agent.routingProfile || route.role !== agent.name)
			throw new Error("routing_profile changed; resume/fork refused to discard persisted routing guarantees");
		attempts.set(entry.id, route);
	}
	if (request?.data === "public") assertPublicHistory(branch, attempts);
}
/** A branch summary imports context from its abandoned source as well as its parent ancestry. */
function assertPublicHistory(
	branch: ReturnType<typeof readActiveBranch>,
	attempts: ReadonlyMap<string, RoutingRecord>,
): void {
	const pending: ProvenanceEntry[][] = [branch.entries];
	const checked: Set<string> = new Set();
	while (pending.length) {
		const entries: ProvenanceEntry[] = pending.pop() ?? [];
		assertPublicAncestry(entries, attempts);
		for (const entry of entries) {
			if (entry.type !== "branch_summary" || checked.has(entry.id)) continue;
			checked.add(entry.id);
			pending.push(summarySource(entry, branch.history));
		}
	}
}
function summarySource(summary: ProvenanceEntry, history: ProvenanceEntry[]): ProvenanceEntry[] {
	const index: number = history.findIndex((entry) => entry.id === summary.id);
	const earlier: Map<string, ProvenanceEntry> = new Map(history.slice(0, index).map((entry) => [entry.id, entry]));
	const path: ProvenanceEntry[] = [];
	const seen: Set<string> = new Set();
	let id: unknown = summary.fromId;
	while (id !== null) {
		if (typeof id !== "string" || seen.has(id)) refusePublic();
		const entry: ProvenanceEntry | undefined = earlier.get(id);
		if (!entry) refusePublic();
		seen.add(id);
		path.unshift(entry);
		id = entry.parentId;
	}
	return path;
}
function assertPublicAncestry(entries: ProvenanceEntry[], attempts: ReadonlyMap<string, RoutingRecord>): void {
	let attested = false;
	for (const entry of entries) {
		const route: RoutingRecord | undefined = attempts.get(entry.id);
		if (route) {
			if (route.request.data !== "public" || route.request.safePublicContext !== true) refusePublic();
			attested = true;
		} else if (!attested && !STATE_ONLY.has(entry.type)) refusePublic();
	}
	if (!attested) refusePublic();
}
function refusePublic(): never {
	throw new Error("inherited session context is private/unknown, not public-attested; public resume/fork refused");
}
