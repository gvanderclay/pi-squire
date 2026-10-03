import assert from "node:assert/strict";
import { after, test } from "node:test";

import { cleanup, FAKE_MODELS, resetRoot, session } from "./harness.ts";

after(cleanup);

test("an errored run carries the failure a test chose, and a plain one keeps boom", async () => {
	resetRoot();
	const s = session({ parentEnv: "p", autoExitEnv: "1" });
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
	assert.equal(s.shutdowns(), 0);
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
