import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import type { DelegateHost, StartConfiguration } from "../src/host.ts";
import { windowLocator } from "../src/locators.ts";
import { readTree } from "../src/tree-registry.ts";
import { windowStates } from "../src/window-state.ts";
import { agentFile, cleanup, resetRoot, root, session, sessionDir, writeAgent } from "./harness.ts";

beforeEach(() => {
	resetRoot();
	writeAgent("scout", agentFile({ model: "alpha/fast-model", thinking: "low" }));
});
after(cleanup);

/** No pane/navigation capabilities. Reuses a released codec for the test's
 * durable identity; registering a third codec is intentionally out of scope. */
function configuredHost(calls: string[], configurations: StartConfiguration[]): DelegateHost {
	let next = 0;
	return {
		id: "api-host",
		usesWindowPlacement: false,
		requiresSessionGuard: false,
		ownsLocator: (value: unknown): boolean => !!value,
		unavailable: ((check?: true) => (check ? Promise.resolve(undefined) : undefined)) as DelegateHost["unavailable"],
		taskMailTiming: () => "after-open",
		states: async () => ({ ...windowStates([]), close: async () => false }),
		windowListRefusal: "No terminal viewer",
		show: async () => ({ text: "No terminal viewer", brief: "No viewer" }),
		peek: async () => "worker output",
		openWindow: async (spec) => {
			calls.push("open");
			const id = `@${++next}`;
			return { id, session: undefined, locator: windowLocator({ id, name: spec.name }) };
		},
		configureStart: async (_opened, configuration) => {
			calls.push("configure");
			configurations.push(configuration);
		},
		closeTaskless: async () => {
			calls.push("close-taskless");
		},
	};
}

function startedId(result: Awaited<ReturnType<ReturnType<typeof session>["toolCall"]>>): string {
	return (result.structuredContent as { id: string }).id;
}

test("a pane-free host can open, configure, then mail for launch, resume and fork", async () => {
	const calls: string[] = [];
	const configurations: StartConfiguration[] = [];
	const host = configuredHost(calls, configurations);
	const s = session({ multiplexer: host });
	s.events.on("message:send", () => calls.push("mail"));
	try {
		const id = startedId(await s.toolCall("delegate", { agent: "scout", task: "first" }));
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(
			join(sessionDir, `source_${id}.jsonl`),
			`${JSON.stringify({ type: "session", version: 3, id, cwd: root, timestamp: "2026-10-26T00:00:00.000Z" })}\n`,
		);
		const resumedId = startedId(await s.toolCall("delegation_resume", { id, task: "second" }));
		const forkId = startedId(await s.toolCall("delegation_fork", { id: resumedId, task: "third" }));
		assert.deepEqual(calls, ["open", "configure", "mail", "open", "configure", "mail", "open", "configure", "mail"]);
		assert.deepEqual(
			configurations.map((configuration) => [configuration.kind, configuration.sessionId, configuration.launchId]),
			[
				["launch", id, id],
				["resume", id, resumedId],
				["fork", forkId, forkId],
			],
		);
		for (const configuration of configurations) {
			assert.equal(configuration.model, "alpha/fast-model");
			assert.equal(configuration.thinking, "low");
			assert.equal(realpathSync(configuration.cwd), realpathSync(root));
			assert.equal(configuration.sessionDir, sessionDir);
		}
		assert.equal(host.paneStates, undefined);
		assert.equal(host.observeLivePane, undefined);
		assert.equal(host.configureStart === undefined, false);
	} finally {
		await s.shutdown();
	}
});

test("configuration failure before task mail rolls back through closeTaskless without recording a start", async () => {
	const calls: string[] = [];
	const host = configuredHost(calls, []);
	host.configureStart = async () => {
		calls.push("configure");
		throw new Error("configuration refused");
	};
	const s = session({ multiplexer: host });
	s.events.on("message:send", () => calls.push("mail"));
	try {
		await assert.rejects(s.toolCall("delegate", { agent: "scout", task: "first" }), /configuration refused/);
		assert.deepEqual(calls, ["open", "configure", "close-taskless"]);
		assert.equal(
			s.entries.some((entry) => entry.customType === "delegate-start-v2"),
			false,
		);
		assert.equal(
			readTree(s.parent).entries.at(-1)?.phase,
			"started",
			"opened resources remain charged until reconciled",
		);
	} finally {
		await s.shutdown();
	}
});

test("mail failure after configuration preserves the host's taskless rollback refusal", async () => {
	const calls: string[] = [];
	const host = configuredHost(calls, []);
	host.closeTaskless = async () => {
		calls.push("close-taskless");
		throw new Error("API close refused; inspect worker");
	};
	const s = session({ multiplexer: host, send: "error" });
	s.events.on("message:send", () => calls.push("mail"));
	try {
		await assert.rejects(
			s.toolCall("delegate", { agent: "scout", task: "first" }),
			/could not send the task.*; API close refused; inspect worker/,
		);
		assert.deepEqual(calls, ["open", "configure", "mail", "close-taskless"]);
		assert.equal(
			s.entries.some((entry) => entry.customType === "delegate-start-v2"),
			false,
		);
	} finally {
		await s.shutdown();
	}
});
