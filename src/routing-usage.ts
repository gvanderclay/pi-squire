import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { QuotaFact } from "./routing.ts";
import type { RoutingPolicy } from "./routing-types.ts";
import { scopedApplies } from "./usage.ts";

type Window = { label: string; percent: number | null; resetsAt: number | null; windowMs?: number };
type Snapshot = {
	version: 1;
	piProvider: string;
	observedAt: number | null;
	unavailable: string | null;
	windows: Window[];
};
function snapshot(value: unknown): Snapshot | undefined {
	if (!value || typeof value !== "object") return undefined;
	const entry: Partial<Snapshot> = value;
	if (entry.version !== 1 || typeof entry.piProvider !== "string" || !Array.isArray(entry.windows)) return undefined;
	if (entry.observedAt !== null && (typeof entry.observedAt !== "number" || !Number.isFinite(entry.observedAt)))
		return undefined;
	if (entry.unavailable !== null && typeof entry.unavailable !== "string") return undefined;
	if (
		entry.windows.some(
			(w) =>
				!w ||
				typeof w.label !== "string" ||
				(w.percent !== null && (typeof w.percent !== "number" || !Number.isFinite(w.percent) || w.percent < 0)) ||
				(w.resetsAt !== null && (typeof w.resetsAt !== "number" || !Number.isFinite(w.resetsAt))) ||
				(w.windowMs !== undefined && (!Number.isFinite(w.windowMs) || w.windowMs <= 0)),
		)
	)
		return undefined;
	return structuredClone(entry) as Snapshot;
}
/** Small cached snapshot adapter: never fetches, spawns, reads credentials or imports a provider's code. */
export function createRoutingUsage(pi: Pick<ExtensionAPI, "events">): {
	read(policy: RoutingPolicy, now: number): Record<string, QuotaFact>;
} {
	const snapshots: Map<string, Snapshot> = new Map();
	pi.events.on("usage-status:snapshot", (value) => {
		const found: Snapshot | undefined = snapshot(value);
		if (found) snapshots.set(found.piProvider, found);
	});
	return {
		read(policy: RoutingPolicy, now: number): Record<string, QuotaFact> {
			pi.events.emit("usage-status:request", {});
			const facts: Record<string, QuotaFact> = {};
			for (const model of Object.keys(policy.models)) {
				const provider: string = model.slice(0, model.indexOf("/"));
				if (!policy.usage?.applicableProviders.includes(provider)) continue;
				const entry: Snapshot | undefined = snapshots.get(provider);
				if (
					!entry ||
					entry.unavailable ||
					entry.observedAt === null ||
					entry.observedAt > now ||
					now - entry.observedAt > policy.usage.maxAgeMs
				)
					continue;
				const windows: Window[] = entry.windows.filter(
					(window) =>
						(window.resetsAt === null || window.resetsAt > now) &&
						(/^(?:[0-9]+[mhdw]|wk|mo)$/.test(window.label) ||
							scopedApplies(window.label, { id: model.slice(model.indexOf("/") + 1) })),
				);
				if (!windows.some((window) => window.percent !== null)) continue;
				facts[model] = {
					observedAt: entry.observedAt,
					exhausted: windows.some((w) => (w.percent ?? 0) >= 100),
					pressured: windows.some((w) => pressured(w, now)),
				};
			}
			return facts;
		},
	};
}
function pressured(window: Window, now: number): boolean {
	if (window.percent === null) return false;
	if (window.percent >= 90) return true;
	if (!window.windowMs || window.resetsAt === null) return false;
	const elapsed: number = Math.max(0, 1 - (window.resetsAt - now) / window.windowMs);
	// Dimensionless pace within this plan, not a comparison of compute budgets or raw percentages across plans.
	return window.percent > Math.max(10, elapsed * 150);
}
