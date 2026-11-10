import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import type { DelegateHost, OpenedWindow, WindowSpec } from "../src/host.ts";
import { type WindowRecord, windowLocator } from "../src/locators.ts";
import { createHostRouter } from "../src/multiplexer.ts";
import { liveLocator } from "../src/tmux-locator.ts";
import { askPaneStates, windowStates } from "../src/window-state.ts";
import { FakeTmux } from "./fake-tmux.ts";
import { agentFile, cleanup, resetRoot, root, session, sessionDir, writeAgent } from "./harness.ts";

beforeEach(resetRoot);
after(cleanup);

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
		taskMailTiming: (kind) => (kind === "resume" ? "after-open" : "before-open"),
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
/** Drive the production starter through resume, then change the router's
 * selection after open. Its admitted concrete host must still own rollback. */
async function failedResumeMail(closeError?: Error) {
	const calls: OpenedWindow[] = [];
	const tmux = new FakeTmux();
	const third = new FakeTmux();
	Object.defineProperty(third, "id", { value: "third" });
	let choice = "third";
	const router = createHostRouter(
		[tmux, third],
		() => choice,
		() => tmux,
		"unavailable",
	);
	writeAgent("scout", agentFile({ model: "alpha/fast-model", thinking: "low" }));
	const s = session({ multiplexer: router, tmux });
	await s.start();
	const launched = await s.toolCall("delegate", { agent: "scout", task: "first" });
	const id = (launched.structuredContent as { id: string }).id;
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(
		join(sessionDir, `source_${id}.jsonl`),
		`${JSON.stringify({ type: "session", version: 3, id, cwd: root, timestamp: "2026-10-26T00:00:00.000Z" })}\n`,
	);
	third.windows.clear();
	const open = third.openWindow.bind(third);
	third.openWindow = async (...args) => {
		const opened = await open(...args);
		choice = "tmux";
		return opened;
	};
	const close = third.closeTaskless.bind(third);
	third.closeTaskless = async (opened) => {
		calls.push(opened);
		if (closeError) throw closeError;
		await close(opened);
	};
	const cause = new Error("provider failure");
	const error = new Error("mailbox down", { cause });
	// Throw a known error at the synchronous send boundary so rollback must
	// preserve the original object and its cause, not just its text.
	s.events.on("message:send", (payload: unknown) => {
		Object.defineProperty(payload, "error", {
			get: () => {
				throw error;
			},
		});
	});
	return { s, tmux, third, calls, cause, error, resume: () => s.toolCall("delegation_resume", { id, task: "again" }) };
}

test("failed resume task mail closes through the admitted host after the router's launch choice changes", async () => {
	const fixture = await failedResumeMail();
	try {
		await assert.rejects(
			fixture.resume(),
			(value) => value instanceof Error && value === fixture.error && value.cause === fixture.cause,
		);
		assert.equal(fixture.calls.length, 1);
		assert.equal(fixture.calls[0].id, fixture.third.opened.at(-1)?.windowId);
		assert.deepEqual(fixture.third.killed, [fixture.calls[0].id]);
		assert.deepEqual(fixture.tmux.killed, []);
		assert.equal(fixture.tmux.opened.length, 0);
	} finally {
		await fixture.s.shutdown();
	}
});

test("taskless close failure keeps the mail error and admitted host's recovery advice", async () => {
	const fixture = await failedResumeMail(new Error("third close refused; inspect the worker"));
	try {
		await assert.rejects(fixture.resume(), (error) => {
			assert.ok(error instanceof Error);
			assert.equal(error.cause, fixture.error);
			assert.equal(error.message, "mailbox down; third close refused; inspect the worker");
			return true;
		});
		assert.equal(fixture.calls.length, 1);
		assert.equal(fixture.calls[0].id, fixture.third.opened.at(-1)?.windowId);
		assert.deepEqual(fixture.tmux.killed, []);
	} finally {
		await fixture.s.shutdown();
	}
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
