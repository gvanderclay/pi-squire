import assert from "node:assert/strict";
import { test } from "node:test";
import type { DelegateHost, WindowSpec } from "../src/host.ts";
import { createHostRouter } from "../src/multiplexer.ts";
import type { WindowRecord } from "../src/tmux-locator.ts";
import { windowStates } from "../src/window-state.ts";

function adapter(id: string, calls: string[]): DelegateHost {
	const ownsLocator = (value: unknown): boolean =>
		!!value &&
		typeof value === "object" &&
		"adapter" in value &&
		value.adapter === id &&
		"key" in value &&
		value.key === 1;
	const states: DelegateHost["states"] = async () => ({
		...windowStates(undefined),
		answered: true,
		look: (record) => ({ state: ownsLocator(record.locator) ? "running" : "unknown" }),
		state: (record) => (ownsLocator(record.locator) ? "running" : "unknown"),
		listed: (record) => ownsLocator(record.locator),
		close: async (record) => {
			assert.ok(ownsLocator(record.locator));
			calls.push(id + ":close");
			return true;
		},
	});
	const unavailable: DelegateHost["unavailable"] = ((check?: true) =>
		check ? Promise.resolve(undefined) : undefined) as DelegateHost["unavailable"];
	return {
		id,
		ownsLocator,
		usesWindowPlacement: false,
		requiresSessionGuard: false,
		unavailable,
		states,
		windowListRefusal: id + " unavailable",
		openWindow: async () => {
			calls.push(id + ":open");
			return { id: "1", session: undefined, locator: { adapter: id, key: 1 } };
		},
		show: async (_target, verify) => {
			if (!(await verify())) return { shown: false };
			calls.push(id + ":show");
			return { shown: true, returnHint: "return" };
		},
		peek: async () => id,
	};
}
const spec: WindowSpec = { name: "worker", cwd: ".", argv: [], env: {} };

test("N-host router freezes launch, routes records by tag, and has no tmux internals", async () => {
	const calls: string[] = [];
	const adapters = ["one", "two", "three"].map((id) => adapter(id, calls));
	let choice = "three";
	const router = createHostRouter(
		adapters,
		() => choice,
		() => adapters[0],
		"unselected",
	);
	const frozen = router.forLaunch!();
	choice = "two";
	await frozen.openWindow(spec, "current", "unused");
	await router.openWindow(spec, "current", "unused");
	const record: WindowRecord = { locator: { adapter: "one", key: 1 } };
	const observation = await router.states(true);
	assert.equal(observation.state(record), "running");
	assert.equal(await observation.close(record), true);
	assert.equal(await router.peek({ windowId: "1", locator: { adapter: "three", key: 1 } }), "three");
	assert.deepEqual(calls, ["three:open", "two:open", "one:close"]);
	for (const name of ["kill", "listWindows", "listPanes", "inspectPane"]) assert.equal(name in router, false);
});

test("unknown or invalid tags never route to an available host", async () => {
	const calls: string[] = [];
	const one = adapter("one", calls);
	const router = createHostRouter(
		[one],
		() => "missing",
		() => undefined,
		"unselected",
	);
	assert.throws(() => router.forLaunch!(), /unsupported/);
	await assert.rejects(async () => router.openWindow(spec, "current", "unused"), /unsupported/);
	for (const locator of [
		{ adapter: "missing", key: 1 },
		{ adapter: "one", key: 2 },
	]) {
		const states = await router.states(true);
		assert.equal(states.state({ locator }), "unknown");
		await assert.rejects(states.close({ locator }), /unsupported/);
		await assert.rejects(async () => router.peek({ windowId: "@1", locator }), /no verified/);
	}
	assert.deepEqual(calls, []);
});
