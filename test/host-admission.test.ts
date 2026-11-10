import assert from "node:assert/strict";
import { test } from "node:test";
import { createHostAdmission } from "../src/host-admission.ts";
import { createHostRouter } from "../src/multiplexer.ts";
import { FakeTmux } from "./fake-tmux.ts";

test("admission freezes the concrete host and placement once; later settings do not affect it", async () => {
	const first = new FakeTmux();
	const second = new FakeTmux();
	Object.defineProperty(second, "id", { value: "second" });
	let choice = "tmux";
	let reads = 0;
	const router = createHostRouter(
		[first, second],
		() => choice,
		() => undefined,
		"unavailable",
	);
	const admission = createHostAdmission(router, () => {
		reads++;
		return { placement: "companion", companionSuffix: "frozen" };
	});
	const admitted = await admission.admit();
	choice = "second";
	assert.equal(admitted.client, first);
	assert.equal(admitted.placement, "companion");
	assert.equal(admitted.companionSuffix, "frozen");
	assert.equal(reads, 1);
	assert.equal(Object.isFrozen(admitted), true);
	assert.equal((await admission.admit()).client, second);
});

test("availability probes leave placement and selection freezing until full admission", async () => {
	const host = new FakeTmux();
	let reads = 0;
	const gate = createHostAdmission(host, () => {
		reads++;
		throw new Error("invalid placement");
	});
	assert.equal(gate.probe(), undefined);
	assert.equal(reads, 0);
	await assert.rejects(gate.admit(), /invalid placement/);
	assert.equal(reads, 1);
});

test("unselected router refuses before reading any concrete-host facts or placement", async () => {
	const router = createHostRouter(
		[],
		() => {
			throw new Error("selection refused");
		},
		() => undefined,
		"unavailable",
	);
	const gate = createHostAdmission(router, () => {
		throw new Error("placement must not be read");
	});
	assert.equal(gate.probe(), "selection refused");
	await assert.rejects(gate.admit(), /^Error: selection refused$/);
});

test("a host without window placement never reads terminal settings", async () => {
	const host = new FakeTmux();
	Object.defineProperty(host, "usesWindowPlacement", { value: false });
	const gate = createHostAdmission(host, () => {
		throw new Error("terminal setting read");
	});
	const admitted = await gate.admit();
	assert.equal(admitted.client, host);
	assert.equal(admitted.placement, "current");
	assert.equal(admitted.companionSuffix, "delegates");
});

test("version refusal wins over invalid placement at full admission", async () => {
	const host = new FakeTmux();
	host.versionText = "tmux 3.1";
	const gate = createHostAdmission(host, () => {
		throw new Error("placement read too early");
	});
	assert.equal(gate.probe(), undefined);
	await assert.rejects(gate.admit(), /tmux.*3\./);
});
