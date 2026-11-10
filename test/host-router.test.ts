import assert from "node:assert/strict";
import { test } from "node:test";
import type { DelegateHost, WindowSpec } from "../src/host.ts";
import { type WindowRecord, windowLocator } from "../src/locators.ts";
import { createHostRouter } from "../src/multiplexer.ts";
import { mailTask } from "../src/resume.ts";
import { liveLocator } from "../src/tmux-locator.ts";
import { askPaneStates, windowStates } from "../src/window-state.ts";
import { FakeTmux } from "./fake-tmux.ts";

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
			calls.push(`${id}:close`);
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
		closeTaskless: async () => {
			calls.push(`${id}:taskless`);
		},
		windowListRefusal: `${id} unavailable`,
		openWindow: async () => {
			calls.push(`${id}:open`);
			return { id: "1", session: undefined, locator: { adapter: id, key: 1 } };
		},
		show: async (_target, verify) => {
			if (!(await verify())) return { shown: false };
			calls.push(`${id}:show`);
			return { shown: true, returnHint: "return" };
		},
		peek: async () => id,
	};
}
test("failed resume task mail closes through the opened locator's owner, not the launch choice or tmux", async () => {
	const calls: string[] = [];
	const tmux = new FakeTmux();
	const third = adapter("third", calls);
	const router = createHostRouter(
		[tmux, third],
		() => "tmux",
		() => tmux,
		"unavailable",
	);
	const opened = await third.openWindow({ name: "worker", cwd: ".", argv: [], env: {} }, "current", "unused");
	const error = new Error("mailbox down");
	await assert.rejects(
		mailTask(
			{
				tmux: router,
				sendTask: () => {
					throw error;
				},
			},
			opened,
			"session",
			"task",
		),
		(value) => value === error,
	);
	assert.deepEqual(calls, ["third:open", "third:taskless"]);
	assert.deepEqual(tmux.killed, []);
});

test("taskless close failure keeps the mail error and owning host's recovery advice", async () => {
	const third = adapter("third", []);
	third.closeTaskless = async () => {
		throw new Error("third close refused; inspect the worker");
	};
	const router = createHostRouter(
		[third],
		() => "third",
		() => third,
		"unavailable",
	);
	const opened = await third.openWindow({ name: "worker", cwd: ".", argv: [], env: {} }, "current", "unused");
	const cause = new Error("mailbox down");
	await assert.rejects(
		mailTask(
			{
				tmux: router,
				sendTask: () => {
					throw cause;
				},
			},
			opened,
			"session",
			"task",
		),
		(error) => {
			assert.ok(error instanceof Error);
			assert.equal(error.cause, cause);
			assert.equal(error.message, "mailbox down; third close refused; inspect the worker");
			return true;
		},
	);
});

test("legacy tmux navigation keeps target-id validation and rejects raw pane locators", async () => {
	const tmux = new FakeTmux();
	const router = createHostRouter(
		[tmux],
		() => "tmux",
		() => tmux,
		"unavailable",
	);
	const locator = windowLocator({ id: "@1", name: "worker" });
	await assert.rejects(async () => router.peek({ windowId: "not-a-window", locator }), /no verified/);
	const pane = liveLocator({
		socket: "/socket",
		serverPid: 1,
		serverStarted: "1",
		paneId: "%1",
		windowId: "@1",
		windowName: "worker",
		exited: false,
	});
	await assert.rejects(async () => router.peek({ windowId: "@1", locator: pane }), /no verified/);
	assert.deepEqual(tmux.captures, []);
});

test("optional terminal snapshots remain available for cross-host historical navigation", async () => {
	const tmux = new FakeTmux();
	tmux.addWindow("@1", "historical");
	const third = adapter("third", []);
	const router = createHostRouter(
		[tmux, third],
		() => "third",
		() => third,
		"unavailable",
	);
	const observation = await askPaneStates(router);
	assert.equal(observation.livePanes?.running({ windowId: "@1", windowName: "historical" }), true);
	assert.equal(tmux.paneListCalls, 1);
	assert.equal(observation.state({ windowId: "@1", windowName: "historical" }), "running");
});

test("startup recovery keeps a sole positive observer but never falls back from a known pane-free host", async () => {
	const observed = { id: "@1", name: "worker" };
	const tmux = Object.assign(new FakeTmux(), { currentWindow: async () => observed });
	const third = adapter("third", []);
	let host: DelegateHost | undefined;
	const router = createHostRouter(
		[tmux, third],
		() => "third",
		() => host,
		"unavailable",
	);
	assert.deepEqual(await router.currentWindow!(), observed);
	host = third;
	assert.equal(await router.currentWindow!(), undefined);
});

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
