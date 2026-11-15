import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { after, test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { agentDir, cleanup, closeSessions, FAKE_MODELS, resetRoot, root, session } from "./harness.ts";

after(cleanup);

test("an IPC fixture can import the harness without starting the test runner", () => {
	const child = spawnSync(process.execPath, [fileURLToPath(new URL("./fixtures/harness-import.ts", import.meta.url))], {
		env: { ...process.env, SQUIRE_TEST_AGENT_DIR: agentDir },
		encoding: "utf8",
		timeout: 20000,
	});
	assert.equal(child.error, undefined);
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout, "harness fixture cleaned up\n");
});

test("an errored run carries the failure a test chose, and a plain one keeps boom", async () => {
	resetRoot();
	const s = session({ parentEnv: "p", autoExitEnv: "0" });
	const seen: Record<string, unknown>[] = [];
	s.pi.on("agent_end", (event) => {
		seen.push((event as { messages: Record<string, unknown>[] }).messages[1]);
	});
	await s.start();
	await s.run("error", { errorMessage: "400: bad request", provider: "opencode-go", model: "fake-go-model" });
	await s.run("error");
	assert.equal(seen[0].errorMessage, "400: bad request");
	assert.equal(seen[0].provider, "opencode-go");
	assert.equal(seen[0].model, "fake-go-model");
	assert.equal(seen[1].errorMessage, "boom");
	assert.equal("provider" in seen[1], false);
});

test("prepare records messages returned by before_agent_start handlers", async () => {
	resetRoot();
	const s = session();
	s.pi.on("before_agent_start", () => ({
		message: { customType: "harness-check", content: "returned message", display: false },
	}));
	await s.prepare();
	assert.deepEqual(s.preparedMessages, [{ customType: "harness-check", content: "returned message", display: false }]);
});

test("fire reaches handlers and extra models stay in their own session", async () => {
	resetRoot();
	const extra = { provider: "opencode-go", id: "fake-free", cost: { input: 0, output: 0 } };
	type Model = { provider: string; id: string };
	const registries: {
		find: (p: string, i: string) => unknown;
		getAll: () => unknown[];
		getAvailable: () => unknown[];
		hasConfiguredAuth: (m: Model) => boolean;
	}[] = [];
	for (const [extraModels, noCredentials] of [
		[[extra], undefined],
		[undefined, undefined],
		[[extra], ["opencode-go/fake-free"]],
	] as const) {
		const s = session({ extraModels, noCredentials });
		s.pi.on("after_provider_response", (_event, ctx) => {
			registries.push((ctx as { modelRegistry: (typeof registries)[number] }).modelRegistry);
		});
		await s.fire("after_provider_response", { status: 429 });
	}
	assert.equal(registries[0].find("opencode-go", "fake-free"), extra);
	assert.equal(registries[0].getAll().length, FAKE_MODELS.length + 1);
	assert.equal(registries[1].find("opencode-go", "fake-free"), undefined);
	assert.equal(registries[1].getAll().length, FAKE_MODELS.length);
	assert.ok(registries[0].getAvailable().includes(extra));
	assert.equal(registries[1].getAvailable().includes(extra), false);
	assert.equal(registries[0].hasConfiguredAuth(extra), true);
	assert.equal(registries[2].hasConfiguredAuth(extra), false);
	assert.deepEqual((registries[0].find("opencode-go", "fake-free") as { cost: unknown }).cost, { input: 0, output: 0 });
});

for (const operation of ["shutdown", "closeSessions", "cleanup"] as const) {
	test(`harness ${operation} drains an in-flight atomic publication before removing state`, async () => {
		resetRoot();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let destination: string | undefined;
		let finished = false;
		const s = session({
			publisherOptions: {
				rename: async (from, to) => {
					destination = String(to);
					entered.resolve();
					await release.promise;
					await rename(from, to);
				},
			},
		});
		try {
			await s.start();
			// Production schedules with an unref'ed timer: a bare promise cannot keep
			// Node alive until rename. Start the actual writer, without awaiting the gate.
			const publishing = s.flushPublishers();
			await entered.promise;
			const stopping = (
				operation === "shutdown" ? s.shutdown() : operation === "cleanup" ? cleanup() : closeSessions()
			).then(() => {
				finished = true;
			});
			await nextTurn();
			assert.equal(finished, false, "teardown must wait for this session's writer, not retry synchronous rm");
			release.resolve();
			await stopping;
			await publishing;
			assert.ok(destination);
			assert.equal(existsSync(destination), false, "stopped publisher removed its late atomic write");
			if (operation === "cleanup") assert.equal(existsSync(root), false, "root removed only after writer drained");
		} finally {
			release.resolve();
			await s.shutdown();
		}
	});
}
