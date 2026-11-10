// Narrow in-memory conformance model: no tmux sessions, commands, names as
// identity, placement policy or navigationVerbs copied from the real adapter.
// FakeTmux remains a richer tmux feature-test fixture during migration.
import { WindowOpenError, type WindowRecord } from "../src/tmux.ts";
import type { AdapterContract, AdapterFixture } from "./adapter-contract.ts";

type Terminal = { running: boolean; screen: string };
type MemoryLocator = { adapter: "memory"; key: number };
type MemoryRecord = { locator: MemoryLocator };

export async function memoryAdapter(): Promise<AdapterFixture> {
	const terminals = new Map<number, Terminal>();
	let next = 0;
	let failedAsk = false;
	let ambiguous = false;
	let unconfirmed: MemoryRecord | undefined;
	let unavailable = false;
	let shown: number | undefined;
	const key = (record: WindowRecord): number | undefined => {
		const locator = record.locator as Partial<MemoryLocator> | undefined;
		return locator?.adapter === "memory" && typeof locator.key === "number" ? locator.key : undefined;
	};
	const add = (): MemoryRecord => {
		const locator: MemoryLocator = { adapter: "memory", key: ++next };
		terminals.set(locator.key, { running: true, screen: "SQUIRE-ADAPTER-SCREEN" });
		return { locator };
	};
	const adapter: AdapterContract = {
		async open() {
			const record = add();
			if (ambiguous) {
				ambiguous = false;
				unconfirmed = record;
				throw new WindowOpenError("create answer lost", "unknown");
			}
			return record;
		},
		async state(record) {
			const id = key(record);
			if (failedAsk || id === undefined) return "unknown";
			return terminals.get(id)?.running ? "running" : "gone";
		},
		async close(record) {
			const id = key(record);
			if (failedAsk || id === undefined) throw new Error("identity could not be verified");
			return terminals.delete(id);
		},
		async show(record, verify) {
			if (!(await verify())) return { shown: false };
			shown = key(record);
			return { shown: true, returnHint: "return to the parent terminal" };
		},
		async peek(record) {
			const id = key(record);
			if (id === undefined || !terminals.has(id)) throw new Error("terminal missing");
			return terminals.get(id)!.screen;
		},
		unavailable: () => (unavailable ? "memory adapter unavailable" : undefined),
	};
	return {
		adapter,
		async exit(record) {
			terminals.delete(key(record)!);
		},
		async replace(record) {
			terminals.delete(key(record)!);
			return add();
		},
		failAsk(fail) {
			failedAsk = fail;
		},
		ambiguousOpen() {
			ambiguous = true;
		},
		async ambiguousSurvives() {
			return !!unconfirmed && terminals.has(unconfirmed.locator.key);
		},
		setUnavailable(value) {
			unavailable = value;
		},
		async isShown(record) {
			return shown === key(record);
		},
		async dispose() {
			terminals.clear();
		},
	};
}
