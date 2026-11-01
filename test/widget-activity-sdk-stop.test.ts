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
async function wait(reader: ActivityProcess, sessionId: string, active: boolean): Promise<void> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const value = await reader.command("read", { sessionId, launchId: "sdk-launch" });
		if (Boolean(value) === active) return;
		await new Promise((r) => setTimeout(r, 15));
	}
	assert.fail("real SDK lifecycle did not clear activity");
}
for (const ending of ["abort", "error"]) {
	test(`real no-network SDK ${ending} clears a streamed response without completing a Squire task`, async () => {
		const writer = new ActivityProcess(agentDir, "widget-activity-sdk.ts");
		const reader = new ActivityProcess(agentDir);
		processes.push(writer, reader);
		const sessionId = await writer.command<string>("start");
		await wait(reader, sessionId, true);
		await writer.command(ending);
		await wait(reader, sessionId, false);
		await writer.command("stop");
	});
}
