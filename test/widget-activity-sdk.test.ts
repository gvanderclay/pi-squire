import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { agentDir, cleanup, resetRoot } from "./harness.ts";
import { ActivityProcess } from "./widget-live-process-harness.ts";

const processes: ActivityProcess[] = [];
beforeEach(resetRoot);
afterEach(async () => {
	for (const p of processes.splice(0)) await p.kill();
});
after(cleanup);
function processFixture(fixture?: string) {
	const p = new ActivityProcess(agentDir, fixture);
	processes.push(p);
	return p;
}
async function observed(reader: ActivityProcess, id: string, expected: string | null): Promise<unknown> {
	const deadline = Date.now() + 5000;
	let value: unknown;
	do {
		value = await reader.command("read", { sessionId: id, launchId: "sdk-launch" });
		if (expected === null ? value === null : JSON.stringify(value).includes(expected)) return value;
		await new Promise((r) => setTimeout(r, 10));
	} while (Date.now() < deadline);
	assert.fail(`activity did not become ${expected}: ${JSON.stringify(value)}`);
}
test("real local Pi synthetic stream and nested tools reach an independent OS reader without paid inference", async () => {
	const writer = processFixture("widget-activity-sdk.ts"),
		reader = processFixture();
	const id = await writer.command<string>("start");
	assert.deepEqual(await observed(reader, id, "Literal live response"), {
		kind: "response",
		text: "Literal live response",
	});
	const calls = await writer.command<{ id: string; parent?: string; phase: string }[]>("tools");
	assert.ok(calls.some((c) => c.id === "outer/1" && c.parent === "outer"));
	assert.ok(calls.some((c) => c.id === "outer/2" && c.parent === "outer"));
	assert.deepEqual(await observed(reader, id, "reading…"), { kind: "tools", text: "reading…" });
	await writer.command("first");
	assert.deepEqual(await observed(reader, id, "reading…"), { kind: "tools", text: "reading…" });
	const completed = await writer.command<{ id: string; phase: string }[]>("finish");
	assert.ok(completed.some((c) => c.id === "outer/1" && c.phase === "end"));
	assert.ok(completed.some((c) => c.id === "outer/2" && c.phase === "end"));
	await observed(reader, id, null);
	await writer.command("reload");
	await observed(reader, id, null);
	await writer.command("stop");
});
