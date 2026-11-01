import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import type { Delegation } from "../src/results.ts";
import { DELEGATE_WIDGET_KEY } from "../src/widget.ts";
import { LIVE_LAUNCH_ENV, LiveActivityPublisher, LiveActivityReader, liveSessionDir } from "../src/widget-live.ts";
import { FakeTmux } from "./fake-tmux.ts";
import { agentFile, cleanup, resetRoot, root, session, sessionDir, writeAgent } from "./harness.ts";

type Session = ReturnType<typeof session>;
const sessions: Session[] = [];
beforeEach(() => {
	resetRoot();
	writeAgent("worker", agentFile({ model: "alpha/fast-model", auto_exit: "false" }));
});
afterEach(async () => {
	for (const s of sessions.splice(0)) await s.shutdown();
});
after(cleanup);
function create(id: string, launch?: string, options: Parameters<typeof session>[0] = {}): Session {
	if (launch) process.env[LIVE_LAUNCH_ENV] = JSON.stringify({ version: 1, sessionId: id, launchId: launch });
	else delete process.env[LIVE_LAUNCH_ENV];
	const s = session({ parent: id, ...options });
	sessions.push(s);
	return s;
}
async function until(check: () => Promise<boolean>, message: string): Promise<void> {
	const end = Date.now() + 5000;
	while (Date.now() < end) {
		if (await check()) return;
		await new Promise((r) => setTimeout(r, 15));
	}
	assert.fail(message);
}
async function live(id: string, launch: string, text: string | null): Promise<void> {
	await until(async () => {
		const value = await new LiveActivityReader().read(id, launch);
		return text === null ? !value : value?.text === text;
	}, `live projection did not become ${text}`);
}
async function tool(s: Session, id = "call", name = "read"): Promise<void> {
	await s.fire("tool_execution_start", { toolCallId: id, toolName: name, args: { SECRET_ARGUMENT: "not persisted" } });
}
test("all modes register factual collector, reject thinking/results, clear on message/run boundaries and reload", async () => {
	const s = create("runtime", "launch");
	await s.start();
	await s.fire("agent_start");
	await s.fire("message_start", { message: { role: "assistant", content: [] } });
	await s.fire("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "thinking_delta", delta: "THINKING_SECRET" },
	});
	await s.fire("message_update", {
		message: { role: "toolResult" },
		assistantMessageEvent: { type: "text_delta", delta: "RESULT_SECRET" },
	});
	await s.fire("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "literal text" },
	});
	await live("runtime", "launch", "literal text");
	const files = await readdir(liveSessionDir("runtime"));
	const json = await readFile(join(liveSessionDir("runtime"), files.find((f) => f.endsWith(".json"))!), "utf8");
	assert.ok(!json.includes("THINKING_SECRET") && !json.includes("RESULT_SECRET"));
	await s.fire("message_end", { message: { role: "assistant" } });
	await live("runtime", "launch", null);
	await tool(s);
	await live("runtime", "launch", "reading…");
	await s.fire("message_end", { message: { role: "toolResult", content: [{ type: "text", text: "OUTPUT_SECRET" }] } });
	await live("runtime", "launch", "reading…");
	for (const boundary of ["agent_end", "agent_settled", "agent_start"]) {
		await s.fire(boundary, { messages: [], aborted: true });
		await live("runtime", "launch", null);
		await tool(s);
		await live("runtime", "launch", "reading…");
	}
	await s.fire("session_start", { reason: "reload" });
	await live("runtime", "launch", null);
	await tool(s, "after-reload", "bash");
	await live("runtime", "launch", "command call…");
	assert.equal(s.widgets.size, 0, "non-TUI collector does not require a widget");
});
test("locator ticks keep observing without unchanged rewrites, publish rename/move/clear and reset per session/generation", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const original = LiveActivityPublisher.prototype.publishLocator;
	const drains: Promise<void>[] = [];
	let observations = 0;
	t.mock.method(
		LiveActivityPublisher.prototype,
		"publishLocator",
		function (this: LiveActivityPublisher, ...args: Parameters<LiveActivityPublisher["publishLocator"]>): void {
			original.apply(this, args);
			observations++;
			drains.push(this.flush());
		},
	);
	const tmux = new FakeTmux();
	tmux.ownPane = "%1";
	tmux.addWindow("@1", "original");
	tmux.panes.set("%1", { windowId: "@1" });
	const inspect = t.mock.method(tmux, "inspectPane");
	const s = create("locator-ticks", "launch", { tmux });
	await s.start();
	await until(async () => observations > 0, "initial locator observation");
	await Promise.all(drains.splice(0));
	const read = async (id = "locator-ticks") => {
		const files = (await readdir(liveSessionDir(id))).filter((name) => name.endsWith(".json"));
		assert.equal(files.length, 1);
		return readFile(join(liveSessionDir(id), files[0]), "utf8");
	};
	const initial = await read();
	const initialGeneration = JSON.parse(initial).generation;
	const tick = async (): Promise<void> => {
		const before = observations;
		t.mock.timers.tick(1000);
		await until(async () => observations > before, "fresh positive pane observation");
		await Promise.all(drains.splice(0));
	};
	const initialInspects = inspect.mock.callCount();
	for (let n = 0; n < 3; n++) {
		await tick();
		assert.equal(await read(), initial, "identical observed locator does not advance revision or rewrite snapshot");
	}
	assert.equal(inspect.mock.callCount(), initialInspects + 3, "deduplication never stops fresh positive reads");
	tmux.addWindow("@1", "renamed");
	await tick();
	assert.equal(JSON.parse(await read()).locator.windowName, "renamed");
	tmux.addWindow("@8", "moved");
	tmux.panes.set("%1", { windowId: "@8" });
	await tick();
	assert.equal(JSON.parse(await read()).locator.windowId, "@8");
	tmux.panes.delete("%1");
	await tick();
	const cleared = await read();
	assert.equal(JSON.parse(cleared).locator, undefined);
	await tick();
	assert.equal(await read(), cleared, "repeated absent-pane observations do not rewrite");
	await tool(s);
	await live("locator-ticks", "launch", "reading…");
	const active = await read();
	assert.equal(JSON.parse(active).activity.text, "reading…");
	await tick();
	assert.equal(await read(), active, "locator deduplication leaves activity publication untouched");
	await s.fire("session_start", { reason: "reload" });
	await Promise.all(drains.splice(0));
	await until(async () => {
		const files = (await readdir(liveSessionDir("locator-ticks"))).filter((name) => name.endsWith(".json"));
		if (files.length !== 1) return false;
		return (
			JSON.parse(await readFile(join(liveSessionDir("locator-ticks"), files[0]), "utf8")).generation !==
			initialGeneration
		);
	}, "replacement generation");
	const replacement = JSON.parse(await read());
	assert.equal(replacement.activity, null);
	assert.ok(replacement.ownerToken);
	const second = create("locator-new-session", undefined, { tmux });
	await second.start();
	await Promise.all(drains.splice(0));
	const switched = JSON.parse(await read("locator-new-session"));
	assert.notEqual(switched.generation, replacement.generation);
	assert.notEqual(switched.ownerToken, replacement.ownerToken);
	assert.equal(switched.activity, null);
});

test("manual reopen/switch mismatches cannot borrow a launch; seed is captured per factory", async () => {
	const s = create("stable", "launch");
	await s.start();
	await tool(s);
	await live("stable", "launch", "reading…");
	const manual = create("manual");
	await manual.start();
	await tool(manual);
	await new Promise((r) => setTimeout(r, 30));
	assert.equal(await new LiveActivityReader().read("manual", "launch"), undefined);
	process.env[LIVE_LAUNCH_ENV] = JSON.stringify({ version: 1, sessionId: "other", launchId: "other-launch" });
	await s.fire("session_start", { reason: "reload" });
	await tool(s, "reload");
	await live("stable", "launch", "reading…");
});
test("real launch seed correlates activity in the actual widget and terminal outcomes suppress it", async () => {
	const parent = create("parent", undefined, { mode: "tui" });
	await parent.delegate("worker --label factual inspect");
	const first = parent.entries.find((e) => typeof e.data.requestId === "string")!.data as Delegation;
	const seed = JSON.parse(parent.tmux.opened[0].env[LIVE_LAUNCH_ENV]);
	assert.deepEqual(seed, { version: 1, sessionId: first.id, launchId: first.id });
	const child = create(first.id, first.id);
	await child.start();
	await tool(child);
	await until(async () => frame(parent).includes("reading…"), "widget did not observe child");
	parent.events.emit("message:inbound", {
		envelope: {
			id: "answer",
			from: first.id,
			in_reply_to: [first.requestId],
			status: "failed",
			ts: "",
			body: "answer",
		},
		path: "/mail/reply",
		requests: [],
		handled: false,
	});
	await until(
		async () => frame(parent).includes("failed") && !frame(parent).includes("reading…"),
		"terminal result did not mask live data",
	);
	assert.equal(
		(await new LiveActivityReader().read(first.id, first.id))?.text,
		"reading…",
		"consumer does not alter publisher or task state",
	);
});
test("run settlement clears a coordinator's activity, not its unfinished child delegation", async () => {
	const s = create("coordinator", "launch", { mode: "tui" });
	await s.delegate("worker inspect");
	await tool(s);
	await live("coordinator", "launch", "reading…");
	await s.fire("agent_settled", { aborted: false });
	await live("coordinator", "launch", null);
	await until(async () => frame(s).includes("running"), "unfinished child must remain running");
});
test("projection storage failure does not block Squire task reply settlement/delivery", async () => {
	const dir = liveSessionDir("broken-worker");
	await mkdir(join(dir, ".."), { recursive: true });
	await writeFile(dir, "not directory");
	const s = create("broken-worker", "launch", { parentEnv: "owner", autoExitEnv: "false" });
	const replies: unknown[] = [];
	s.events.on("message:reply", (data) => {
		const p = data as { envelope?: unknown };
		replies.push(data);
		p.envelope = { id: "reply" };
	});
	await s.start();
	s.events.emit("message:inbound", {
		envelope: { id: "request", kind: "request", from: "owner", body: "work" },
		handled: false,
	});
	await tool(s);
	await s.run("completed");
	assert.equal(replies.length, 1);
	assert.equal(s.errors.length, 0);
});
test("real resume preserves stable id but refreshes launch correlation; old launch activity is never borrowed", async () => {
	const parent = create("resume-parent", undefined, { mode: "tui" });
	await parent.delegate("worker --label resume inspect");
	const first = parent.entries.find((e) => typeof e.data.requestId === "string")!.data as Delegation;
	await mkdir(sessionDir, { recursive: true });
	await writeFile(
		join(sessionDir, `today_${first.id}.jsonl`),
		`${JSON.stringify({ type: "session", version: 3, id: first.id, cwd: root })}\n`,
	);
	parent.tmux.exit(first.windowId);
	await parent.toolCall("delegation_resume", { id: first.id, task: "continue" });
	const resumed = parent.entries.filter((e) => typeof e.data.requestId === "string").at(-1)!.data as Delegation;
	assert.notEqual(resumed.id, first.id);
	assert.equal(resumed.sessionId, first.id);
	assert.deepEqual(JSON.parse(parent.tmux.opened[1].env[LIVE_LAUNCH_ENV]), {
		version: 1,
		sessionId: first.id,
		launchId: resumed.id,
	});
	const old = create(first.id, first.id);
	await old.start();
	await tool(old, "old");
	await live(first.id, first.id, "reading…");
	assert.equal(await new LiveActivityReader().read(first.id, resumed.id), undefined);
	await old.shutdown();
	const next = create(first.id, resumed.id);
	await next.start();
	await tool(next, "new", "edit");
	await live(first.id, resumed.id, "editing…");
	await until(async () => frame(parent).includes("editing…"), "resumed row did not get its exact-launch activity");
	await parent.toolCall("delegation_close", { id: resumed.id });
	await until(async () => !frame(parent).includes("editing…"), "close did not mask activity");
});

test("observer ticks during slow activity reads do not starve rendering, and shutdown cannot resurrect it", async () => {
	const original = LiveActivityReader.prototype.read;
	let release!: () => void, entered!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const ready = new Promise<void>((resolve) => {
		entered = resolve;
	});
	LiveActivityReader.prototype.read = async () => {
		entered();
		await gate;
		return { kind: "tools", text: "reading…" };
	};
	try {
		const s = create("slow-observer", undefined, { mode: "tui" });
		await s.delegate("worker inspect");
		await ready;
		await new Promise((resolve) => setTimeout(resolve, 1100));
		release();
		await until(async () => frame(s).includes("reading…"), "timer tick incorrectly discarded the slow snapshot");
		let finish!: () => void, nextRead!: () => void;
		const stopped = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const started = new Promise<void>((resolve) => {
			nextRead = resolve;
		});
		LiveActivityReader.prototype.read = async () => {
			nextRead();
			await stopped;
			return { kind: "tools", text: "editing…" };
		};
		await s.delegate("worker another task");
		await started;
		await s.shutdown();
		finish();
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(frame(s), "");
	} finally {
		release();
		LiveActivityReader.prototype.read = original;
	}
});
test("a result during async activity I/O cannot paint a stale running/activity row", async () => {
	const original = LiveActivityReader.prototype.read;
	let release!: () => void, entered!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const ready = new Promise<void>((resolve) => {
		entered = resolve;
	});
	LiveActivityReader.prototype.read = async () => {
		entered();
		await gate;
		return { kind: "tools", text: "reading…" };
	};
	try {
		const s = create("result-race", undefined, { mode: "tui" });
		await s.delegate("worker inspect");
		await ready;
		const record = s.entries.find((e) => typeof e.data.requestId === "string")!.data as Delegation;
		s.events.emit("message:inbound", {
			envelope: {
				id: "race-reply",
				from: record.id,
				in_reply_to: [record.requestId],
				status: "failed",
				ts: "",
				body: "answer",
			},
			path: "/mail/result",
			requests: [],
			handled: false,
		});
		release();
		await until(async () => frame(s).includes("failed"), "final task state was not repainted");
		assert.ok(!frame(s).includes("reading…") && !frame(s).includes("running"));
	} finally {
		release();
		LiveActivityReader.prototype.read = original;
	}
});
function frame(s: Session): string {
	return s.widgets.get(DELEGATE_WIDGET_KEY)?.render(120).join("\n") ?? "";
}
