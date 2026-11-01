import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import type { Delegation } from "../src/results.ts";
import { SessionOwner } from "../src/session-owner.ts";
import { LIVE_LAUNCH_ENV, LiveActivityReader, liveSessionDir } from "../src/widget-live.ts";
import { agentDir, agentFile, cleanup, resetRoot, writeAgent } from "./harness.ts";
import { mailSession, scan } from "./mail-harness.ts";

type Session = ReturnType<typeof mailSession>;
const active: Session[] = [];
beforeEach(() => {
	resetRoot();
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(join(agentDir, "squire", "settings.json"), JSON.stringify({ maxDepth: 3 }));
	writeAgent("worker", agentFile({ model: "alpha/fast-model", auto_exit: "false" }));
});
afterEach(async () => {
	for (const s of active.splice(0).reverse()) await s.shutdown();
});
after(cleanup);
function instance(id: string, launch: string, options: Parameters<typeof mailSession>[0] = {}): Session {
	process.env[LIVE_LAUNCH_ENV] = JSON.stringify({ version: 1, sessionId: id, launchId: launch });
	const s = mailSession({ parent: id, mode: "tui", ...options });
	active.push(s);
	return s;
}
async function until(check: () => Promise<boolean>, message: string): Promise<void> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((r) => setTimeout(r, 15));
	}
	assert.fail(message);
}
async function live(id: string, launch: string, text: string): Promise<void> {
	await until(
		async () => (await new LiveActivityReader().read(id, launch))?.text === text,
		`missing owner activity: ${text}`,
	);
}
async function cleared(id: string): Promise<void> {
	await until(async () => {
		const names = (await files(id)).filter((name) => name.endsWith(".json"));
		if (names.length !== 1) return false;
		try {
			const value = JSON.parse(await readFile(join(liveSessionDir(id), names[0]), "utf8"));
			return value.activity === null;
		} catch {
			return false;
		}
	}, "live publisher must persist a clear before shutdown");
}
async function files(id: string): Promise<string[]> {
	return (await readdir(liveSessionDir(id)).catch(() => [])).sort();
}
test("owner-record read errors never drop factual ends or grant control authority", async () => {
	const id = "owner-read-error-activity";
	const owner = instance(id, "launch");
	await owner.start();
	await tool(owner, "reading-call", "read");
	await live(id, "launch", "reading…");
	const path = join(agentDir, "squire", "owners", `${encodeURIComponent(id)}.json`);
	const saved = await readFile(path, "utf8");
	try {
		await writeFile(path, "not-json");
		await owner.fire("tool_execution_end", {
			toolCallId: "reading-call",
			toolName: "read",
			result: {},
			isError: false,
		});
		await cleared(id);
		await tool(owner, "new-edit", "edit");
		await live(id, "launch", "editing…");
		const opened = owner.tmux.opened.length;
		await assert.rejects(owner.toolCall("delegate", { agent: "worker", task: "must remain blocked" }));
		assert.equal(owner.tmux.opened.length, opened);
		await owner.fire("agent_settled", { aborted: false });
		await cleared(id);
	} finally {
		await writeFile(path, saved);
	}
});
test("assistant streaming observes no per-token owner checks", async (t) => {
	const owner = instance("streaming-owner", "launch");
	await owner.start();
	await owner.fire("message_start", { message: { role: "assistant" } });
	const checks = t.mock.method(SessionOwner.prototype, "active");
	for (let n = 0; n < 100; n++)
		await owner.fire("message_update", {
			message: { role: "assistant" },
			assistantMessageEvent: { type: "text_delta", delta: "x" },
		});
	assert.equal(checks.mock.callCount(), 0, "text deltas must not synchronously probe owner storage");
	checks.mock.restore();
	await live(owner.parent, "launch", "x".repeat(100));
});
async function tool(s: Session, id: string, name: string): Promise<void> {
	await s.fire("tool_execution_start", { toolCallId: id, toolName: name, args: {} });
}
test("reviewed owner gate blocks losing activity startup/events/cleanup while replacement generation survives stale shutdown", async () => {
	const id = "owned-activity";
	const owner = instance(id, "launch");
	await owner.start();
	await tool(owner, "owner-read", "read");
	await live(id, "launch", "reading…");
	const names = await files(id);
	assert.equal(names.length, 1);
	const path = join(liveSessionDir(id), names[0]);
	const saved = await readFile(path, "utf8");
	const duplicate = instance(id, "launch");
	await duplicate.start();
	assert.equal(duplicate.shutdowns(), 1);
	await tool(duplicate, "loser-edit", "edit");
	await duplicate.fire("message_start", { message: { role: "assistant" } });
	await duplicate.fire("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "loser must not publish" },
	});
	await duplicate.fire("message_end", { message: { role: "assistant" } });
	await duplicate.fire("agent_end", { messages: [] });
	await duplicate.shutdown();
	assert.deepEqual(await files(id), names, "loser creates no extra projection generation");
	assert.equal(await readFile(path, "utf8"), saved, "loser events and shutdown cannot overwrite or clear the owner");
	await owner.shutdown();
	// Replacement may start while the stopped publisher drains async generation cleanup.
	const replacement = instance(id, "next-launch");
	await replacement.start();
	await tool(replacement, "replacement-edit", "edit");
	await live(id, "next-launch", "editing…");
	const nextNames = await files(id);
	assert.equal(nextNames.length, 1);
	assert.notDeepEqual(nextNames, names);
	const nextPath = join(liveSessionDir(id), nextNames[0]);
	const nextSaved = await readFile(nextPath, "utf8");
	await owner.shutdown();
	await duplicate.shutdown();
	await tool(owner, "stale-write", "write");
	assert.deepEqual(await files(id), nextNames);
	assert.equal(await readFile(nextPath, "utf8"), nextSaved);
	await live(id, "next-launch", "editing…");
});
test("failed staged processing still clears live activity before shutdown and preserves replacement publication", async () => {
	const id = "failed-owner-activity";
	const owner = instance(id, "launch");
	const result = await owner.toolCall("delegate", { agent: "worker", task: "finish while root processing fails" });
	const direct = owner.entries.find((entry) => entry.data.id === (result.structuredContent as { id: string }).id)!
		.data as Delegation;
	const child = instance(direct.id, direct.id, { tmux: owner.tmux, mode: "json" });
	await child.start();
	scan(child);
	await tool(owner, "root-read", "read");
	await live(id, "launch", "reading…");
	owner.pi.sendMessage = () => {
		throw Error("injected combined activity delivery failure");
	};
	await child.run();
	scan(owner);
	assert.ok(owner.errors.some((error) => error.includes("input retained")));
	await assert.rejects(owner.toolCall("delegation_status", {}), /input processing failed/);
	await owner.fire("tool_execution_end", { toolCallId: "root-read", toolName: "read", result: {}, isError: false });
	await cleared(id);
	await tool(owner, "after-failure-edit", "edit");
	await live(id, "launch", "editing…");
	await owner.fire("agent_settled", { aborted: false });
	await cleared(id);
	await assert.rejects(owner.toolCall("delegation_status", {}), /input processing failed/);
	await owner.shutdown();
	await until(async () => (await files(id)).length === 0, "failed owner must still run activity shutdown");
	assert.ok(owner.tmux.windows.has(direct.windowId), "process-owner cleanup is not explicit task/window cancellation");
	const replacement = instance(id, "reopened-launch", { entries: owner.entries, tmux: owner.tmux });
	await replacement.start();
	await tool(replacement, "replacement-write", "write");
	await live(id, "reopened-launch", "writing…");
	const names = await files(id);
	assert.equal(names.length, 1);
	const path = join(liveSessionDir(id), names[0]);
	const saved = await readFile(path, "utf8");
	await owner.shutdown();
	assert.equal(await readFile(path, "utf8"), saved);
	await live(id, "reopened-launch", "writing…");
});
