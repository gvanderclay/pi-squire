import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { routedMark } from "./routing-availability.ts";
import { ROUTING_ENV } from "./routing-launch.ts";
import { type ProvenanceEntry, ROUTING_ATTEMPT, ROUTING_FALLBACK, servedModels } from "./routing-provenance.ts";
import { parseRuntimeRouting } from "./routing-record.ts";
import type { Candidate, RoutingRecord } from "./routing-types.ts";

export { parseRuntimeRouting } from "./routing-record.ts";

type Failure = { model: string; reason: string; raw?: string };
type Runtime = {
	active(): boolean;
	failure(value: Failure | undefined): void;
};
export function registerRoutingRuntime(pi: ExtensionAPI, isChild: () => boolean): Runtime {
	let active = false;
	let route: RoutingRecord | undefined;
	let failure: Failure | undefined;
	pi.on("session_start", (_event, ctx) => {
		if (!isChild()) return;
		const entries: ProvenanceEntry[] = ctx.sessionManager.getBranch() as ProvenanceEntry[];
		const saved: ProvenanceEntry | undefined = entries.findLast(
			(entry) => entry.type === "custom" && entry.customType === ROUTING_ATTEMPT,
		);
		const raw: string | undefined = process.env[ROUTING_ENV];
		active = raw !== undefined || saved !== undefined;
		try {
			route = saved ? parseRuntimeRouting(saved.data) : undefined;
			if (raw !== undefined) route = parseRuntimeRouting(JSON.parse(raw));
			if (!route) return;
			if (
				!entries.some(
					(entry) =>
						entry.customType === ROUTING_ATTEMPT &&
						(entry.data as RoutingRecord | undefined)?.launchId === route?.launchId,
				)
			)
				pi.appendEntry(ROUTING_ATTEMPT, route);
		} catch (error) {
			route = undefined;
			ctx.ui.notify(`delegate: routed fallback blocked: ${String((error as Error).message)}`, "error");
		}
	});
	pi.on("agent_before_settle", async (_event, ctx) => {
		const from: Failure | undefined = failure;
		failure = undefined;
		if (!active || !route || !from || /policy|safety|refus|not allowed/i.test(from.raw ?? from.reason)) return;
		const next: string | undefined = await switchRouted(pi, ctx, route, from);
		if (!next) return;
		return {
			continue: true,
			entries: [
				{
					type: "custom_message",
					customType: "delegate",
					content: `[delegate] ${from.reason}; switched to eligible fallback ${next}. Continue the same task.`,
					display: true,
				},
			],
		};
	});
	return {
		active: () => active,
		failure: (value: Failure | undefined): void => {
			failure = value;
		},
	};
}
async function switchRouted(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	route: RoutingRecord,
	from: Failure,
): Promise<string | undefined> {
	const branch: ProvenanceEntry[] = ctx.sessionManager.getBranch() as ProvenanceEntry[];
	const boundary: number = branch.findIndex(
		(entry) =>
			entry.customType === ROUTING_ATTEMPT && (entry.data as RoutingRecord | undefined)?.launchId === route.launchId,
	);
	if (boundary < 0 || !route.candidates.some((item) => item.model === from.model)) return undefined;
	const tried: Set<string> = new Set(servedModels(branch.slice(boundary + 1)).map((item) => item.model));
	tried.add(from.model);
	tried.add(route.selected);
	for (const entry of branch.slice(boundary + 1))
		if (entry.customType === ROUTING_FALLBACK) {
			tried.add((entry.data as { to: string }).to);
			tried.add((entry.data as { from: string }).from);
		}
	for (const candidate of route.candidates) {
		if (tried.has(candidate.model) || !eligibleNow(candidate, route, ctx)) continue;
		const slash: number = candidate.model.indexOf("/");
		const model = ctx.modelRegistry.find(candidate.model.slice(0, slash), candidate.model.slice(slash + 1));
		if (!model || !(await pi.setModel(model))) continue;
		pi.setThinkingLevel(candidate.thinking);
		pi.appendEntry(ROUTING_FALLBACK, {
			from: from.model,
			to: candidate.model,
			reason: (from.raw ?? from.reason).slice(0, 4096),
			requestedThinking: candidate.thinking,
			effectiveThinking: pi.getThinkingLevel(),
		});
		return candidate.model;
	}
	return undefined;
}
function eligibleNow(candidate: Candidate, route: RoutingRecord, ctx: ExtensionContext): boolean {
	const slash: number = candidate.model.indexOf("/");
	const provider: string = candidate.model.slice(0, slash);
	const id: string = candidate.model.slice(slash + 1);
	const model = ctx.modelRegistry.find(provider, id);
	if (
		!model ||
		model.api === "pi-virtual" ||
		!ctx.modelRegistry.hasConfiguredAuth(model) ||
		routedMark(ctx.modelRegistry, provider, id, route.usageProviders)
	)
		return false;
	const requirements = route.request.requirements;
	if ((requirements?.contextTokens ?? 0) > (model.contextWindow ?? 0)) return false;
	if (requirements?.input?.some((input) => !model.input.includes(input))) return false;
	return !route.excludedFamilies.includes(candidate.family);
}
