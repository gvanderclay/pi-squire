// Counts delegated tasks (launch ids), not stable sessions or registry cap charges.
import { isStarted, type Recorded, sessionIdOf } from "./results.ts";
import type { TmuxWindow } from "./tmux.ts";
import type { VisibleFact, VisibleFacts } from "./tree-view.ts";
import { windowState } from "./windows.ts";

type Outcome = "done" | "failed" | "stopped" | "missing" | "running" | "unknown";
function outcome(fact: VisibleFact, windows: TmuxWindow[] | undefined): Outcome {
	const record: Recorded | undefined = fact.semantic;
	if (!record || !isStarted(record) || record.accountingOnly) return "unknown";
	if (record.result) {
		const status: string = record.result.status;
		return status === "done" || status === "failed" || status === "stopped" ? status : "unknown";
	}
	if (record.closed || record.gone) return "missing";
	if (fact.entry?.finished || fact.entry?.closed || fact.entry?.closing || fact.entry?.gone) return "unknown";
	return windowState(windows, record) === "open" ? "running" : "unknown";
}

function below(facts: VisibleFact[], sessionId: string): VisibleFact[] {
	const sessions: Set<string> = new Set([sessionId]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const { record } of facts) {
			if (!isStarted(record) || !record.identity || !sessions.has(record.identity.parent)) continue;
			const id: string = sessionIdOf(record);
			if (!sessions.has(id)) {
				sessions.add(id);
				changed = true;
			}
		}
	}
	return facts.filter(({ record }) => isStarted(record) && record.identity && sessions.has(record.identity.parent));
}

export function taskSummary(view: VisibleFacts, sessionId: string, windows: TmuxWindow[] | undefined): string {
	const descendants: VisibleFact[] = below(view.facts, sessionId);
	if (!descendants.length) return view.complete ? "" : "tasks: coverage unavailable";
	const counts: Map<Outcome, number> = new Map();
	const seen: Set<string> = new Set();
	for (const fact of descendants) {
		if (seen.has(fact.record.id)) continue;
		seen.add(fact.record.id);
		const state: Outcome = outcome(fact, windows);
		counts.set(state, (counts.get(state) ?? 0) + 1);
	}
	const order: Outcome[] = ["failed", "stopped", "missing", "running", "unknown", "done"];
	const labels: string[] = order.flatMap((state) => (counts.has(state) ? [`${counts.get(state)} ${state}`] : []));
	return `${seen.size} task${seen.size === 1 ? "" : "s"}: ${labels.join(" · ")}${view.complete ? "" : " · partial coverage"}`;
}
