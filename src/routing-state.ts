import { createHash } from "node:crypto";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readState, writeState } from "./local-state.ts";
import { orderRoutingTies, tiedFamilies } from "./routing.ts";
import type { Candidate, RoutingRecord } from "./routing-types.ts";
import { withTreeLock } from "./tree-lock.ts";

type TieState = { version: 1; root: string; pools: Record<string, number> };
/** Commit only at admitted dispatch, after synchronous hook validation. Preview/validation never consumes a turn. */
export function admitRouting<T>(root: string, route: RoutingRecord, work: (selected: Candidate) => T): T {
	const key: string = createHash("sha256").update(root).digest("hex");
	const path: string = join(getAgentDir(), "squire", "routing-state", `${key}.json`);
	return withTreeLock(`${path}.lock`, () => {
		const saved: TieState | undefined = readState<TieState>(path);
		const state: TieState = saved === undefined ? { version: 1, root, pools: {} } : saved;
		if (
			state?.version !== 1 ||
			state.root !== root ||
			!state.pools ||
			typeof state.pools !== "object" ||
			Array.isArray(state.pools) ||
			Object.values(state.pools).some((turn) => !Number.isSafeInteger(turn) || turn < 0)
		)
			throw new Error("invalid routing tie state; launch refused");
		// Single-candidate/explicit launches do not steal a peer tie's turn; each family set shares its pool counter.
		const pool: string = JSON.stringify([route.pool, tiedFamilies(route.candidates).sort()]);
		const turn: number = Object.hasOwn(state.pools, pool) ? state.pools[pool] : 0;
		if (turn >= Number.MAX_SAFE_INTEGER) throw new Error("routing tie counter overflow; launch refused");
		const ordered: Candidate[] = orderRoutingTies(route.candidates, turn);
		const selected: Candidate | undefined = ordered[0];
		if (!selected) throw new Error("empty frozen route; launch refused");
		route.candidates = ordered;
		route.selected = selected.model;
		route.tieTurn = turn;
		route.reason = `qualified by constraints/floor; priority ${selected.priority ?? 0}, quality ${selected.quality}, ${selected.pressure ? "quota pressured" : "no applicable quota pressure"}; root/pool family tie turn ${turn}`;
		const result: T = work(selected);
		state.pools[pool] = turn + 1;
		writeState(path, state);
		return result;
	});
}
