import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import type { Delegation } from "../src/results.ts";
import { DELEGATE_WIDGET_KEY } from "../src/widget.ts";
import { LIVE_LAUNCH_ENV, LiveActivityReader, liveSessionDir } from "../src/widget-live.ts";
import { agentDir, agentFile, cleanup, resetRoot, session, writeAgent } from "./harness.ts";

type Session = ReturnType<typeof session>;
const active: Session[] = [];
beforeEach(() => {
	resetRoot();
	writeAgent("worker", agentFile({ model: "alpha/fast-model", auto_exit: "false" }));
});
afterEach(async () => {
	for (const s of active.splice(0).reverse()) await s.shutdown();
});
after(cleanup);
function instance(options: Parameters<typeof session>[0] = {}): Session {
	const s = session({ mode: "tui", ...options });
	active.push(s);
	return s;
}
function frame(s: Session): string {
	return s.widgets.get(DELEGATE_WIDGET_KEY)?.render(150).join("\n") ?? "";
}
async function settle(): Promise<void> {
	for (let n = 0; n < 10; n++) await new Promise<void>((resolve) => setImmediate(resolve));
}
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail("combined activity/navigation observation timed out");
}
async function launch(s: Session, label: string): Promise<Delegation> {
	await s.delegate(`worker --label ${label} inspect`);
	await settle();
	return s.entries.filter((e) => e.data.requestId).at(-1)!.data as Delegation;
}
function deferred() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}
test("activity is joined only to the selected viewport, with stable selection and aligned secondary gutter", async () => {
	const original = LiveActivityReader.prototype.read;
	const reads: string[] = [];
	LiveActivityReader.prototype.read = async (id) => {
		reads.push(id);
		return { kind: "tools", text: `using ${id}…` };
	};
	try {
		const s = instance();
		const records: Delegation[] = [];
		for (let n = 0; n < 5; n++) records.push(await launch(s, `child${n}`));
		reads.length = 0;
		s.terminalKey("down");
		for (let n = 0; n < 3; n++) s.terminalKey("down");
		await settle();
		assert.match(frame(s), /▸ .*worker-child1/);
		assert.doesNotMatch(frame(s), /worker-child4/);
		assert.deepEqual(new Set(reads.slice(-3)), new Set([records[3].id, records[2].id, records[1].id]));
		assert.match(frame(s), /^ {2}Delegates\n {2}├─ ↑ 1 more direct delegate\n/);
		assert.match(frame(s), /\n {2}│ {2}└─ using /);
		await launch(s, "newest");
		await settle();
		assert.match(frame(s), /▸ .*worker-child1/);
	} finally {
		LiveActivityReader.prototype.read = original;
	}
});
test("selection changes during awaited activity discard the stale viewport and requeue the current one", async () => {
	const original = LiveActivityReader.prototype.read;
	let block = false;
	const entered = deferred(),
		gate = deferred();
	LiveActivityReader.prototype.read = async () => {
		if (block) {
			entered.release();
			await gate.promise;
			return { kind: "tools", text: "STALE VIEWPORT" };
		}
		return { kind: "tools", text: "fresh viewport" };
	};
	try {
		const s = instance();
		for (let n = 0; n < 5; n++) await launch(s, `child${n}`);
		block = true;
		s.terminalKey("down");
		await entered.promise;
		for (let n = 0; n < 3; n++) s.terminalKey("down");
		block = false;
		gate.release();
		await settle();
		assert.match(frame(s), /▸ .*worker-child1/);
		assert.match(frame(s), /fresh viewport/);
		assert.doesNotMatch(frame(s), /STALE VIEWPORT/);
	} finally {
		gate.release();
		LiveActivityReader.prototype.read = original;
	}
});
test("terminal result during selected activity read cannot resurrect running state or move target identity", async () => {
	const original = LiveActivityReader.prototype.read;
	let block = false;
	const entered = deferred(),
		gate = deferred();
	LiveActivityReader.prototype.read = async () => {
		if (block) {
			entered.release();
			await gate.promise;
		}
		return { kind: "tools", text: "stale running call" };
	};
	try {
		const s = instance();
		await launch(s, "older");
		const selected = await launch(s, "selected");
		block = true;
		s.terminalKey("down");
		await entered.promise;
		s.events.emit("message:inbound", {
			envelope: {
				id: "terminal",
				from: selected.id,
				in_reply_to: [selected.requestId],
				status: "failed",
				ts: "",
				body: "answer",
			},
			path: "/mail/result",
			requests: [],
			handled: false,
		});
		block = false;
		gate.release();
		await settle();
		const text = frame(s);
		assert.match(text, /▸ .*worker-selected.*failed/);
		const selectedLine = text.split("\n").findIndex((line) => line.includes("worker-selected"));
		assert.ok(!text.split("\n")[selectedLine + 1]?.includes("stale running call"));
	} finally {
		gate.release();
		LiveActivityReader.prototype.read = original;
	}
});
test("raw activity clears after owner failure while selected-widget control stays refused with Error.message", async () => {
	const id = "selected-failed-owner";
	process.env[LIVE_LAUNCH_ENV] = JSON.stringify({ version: 1, sessionId: id, launchId: "root-launch" });
	const s = instance({ parent: id });
	await launch(s, "child");
	await s.fire("tool_execution_start", { toolCallId: "read", toolName: "read", args: {} });
	await until(async () => (await new LiveActivityReader().read(id, "root-launch"))?.text === "reading…");
	s.terminalKey("down");
	const ownerFile = join(agentDir, "squire", "owners", `${id}.json`);
	const saved = readFileSync(ownerFile, "utf8");
	try {
		writeFileSync(ownerFile, "broken");
		assert.equal(s.terminalKey("enter"), true);
		await settle();
		assert.equal(s.customs.length, 0);
		assert.ok(s.errors.some((message) => message.startsWith("delegate: ") && !message.startsWith("delegate: Error:")));
		await s.fire("tool_execution_end", { toolCallId: "read", toolName: "read", result: {}, isError: false });
		await until(async () => {
			const files = (await readdir(liveSessionDir(id)).catch(() => [])).filter((f) => f.endsWith(".json"));
			if (files.length !== 1) return false;
			const snapshot = JSON.parse(await readFile(join(liveSessionDir(id), files[0]), "utf8"));
			return snapshot.activity === null;
		});
		await assert.rejects(s.toolCall("delegation_status", {}));
	} finally {
		writeFileSync(ownerFile, saved);
	}
});
