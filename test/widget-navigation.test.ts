import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import type { Delegation } from "../src/results.ts";
import { DELEGATE_WIDGET_KEY } from "../src/widget.ts";
import {
	agentDir,
	agentFile,
	cleanup,
	keyScript,
	resetRoot,
	root,
	session,
	sessionDir,
	writeAgent,
} from "./harness.ts";

type Session = ReturnType<typeof session>;
const active: Session[] = [];
beforeEach(() => {
	resetRoot();
	writeAgent("worker", agentFile({ model: "alpha/fast-model", auto_exit: "false" }));
});
afterEach(async () => {
	for (const s of active.splice(0)) await s.shutdown();
});
after(cleanup);
function instance(): Session {
	const s = session({ mode: "tui" });
	active.push(s);
	return s;
}
async function settle(): Promise<void> {
	for (let n = 0; n < 8; n++) await new Promise<void>((resolve) => setImmediate(resolve));
}
function frame(s: Session): string {
	return s.widgets.get(DELEGATE_WIDGET_KEY)?.render(120).join("\n") ?? "";
}
async function launch(s: Session, label: string): Promise<Delegation> {
	await s.delegate(`worker --label ${label} inspect`);
	await settle();
	return s.entries.filter((e) => e.data.requestId).at(-1)!.data as Delegation;
}
test("real direct launches: compact viewport scrolls, same dashboard target, Escape list then prompt in both modes", async () => {
	for (const mode of ["regular", "fullscreen"]) {
		const s = instance();
		await s.start();
		s.switchRenderer(mode);
		for (let n = 0; n < 5; n++) await launch(s, `child${n}`);
		assert.equal(s.terminalListeners(), 1);
		assert.doesNotMatch(frame(s), /enter details|▸/);
		assert.equal(s.terminalKey("down"), true);
		assert.match(frame(s), /▸ ├─ ◌ worker-child4/);
		for (let n = 0; n < 3; n++) s.terminalKey("down");
		await settle();
		assert.match(frame(s), /worker-child1/);
		assert.doesNotMatch(frame(s), /worker-child4/);
		assert.match(frame(s), /↑ 1 more direct delegate/);
		const details = keyScript(["escape"], 150);
		s.queueCustom(details);
		assert.equal(s.terminalKey("enter"), true);
		await settle();
		assert.match(details.frames[0], /Delegate: worker-child1/);
		assert.match(details.frames[0], /delegation: .*session:/);
		assert.match(frame(s), /▸ .*worker-child1/);
		assert.equal(s.terminalKey("escape"), true);
		assert.doesNotMatch(frame(s), /▸|enter details/);
		const overall = keyScript(["enter", "escape", "escape"], 150);
		s.queueCustom(overall);
		await s.command("delegates");
		assert.match(overall.frames[0], /^Delegates/);
		assert.match(overall.frames[1], /Delegate: worker-child0/);
		assert.equal(s.tmux.switches.length, 0);
		await s.shutdown();
		assert.equal(s.terminalListeners(), 0);
	}
});
test("completion, nonempty prompt, dialogs, unknown focus and custom editors keep their keys", async () => {
	const s = instance();
	await launch(s, "focus");
	s.editorText(" ");
	assert.equal(s.terminalKey("down"), false);
	s.editorText("");
	s.editorCompletion(true);
	assert.equal(s.terminalKey("down"), false);
	s.editorCompletion(false);
	assert.equal(s.terminalKey("down"), true);
	await s.fire("ui_prompt_start", { kind: "confirm" });
	assert.equal(s.terminalKey("down"), false);
	assert.equal(s.terminalKey("enter"), false);
	await s.fire("ui_prompt_end", { kind: "confirm" });
	s.promptFocus({ getText: () => "", setText: () => {} });
	assert.equal(s.terminalKey("down"), false);
	s.promptFocus();
	s.customEditor(true);
	assert.equal(s.terminalKey("down"), false);
	s.customEditor(false);
	assert.equal(s.terminalKey("down"), true);
	assert.equal(s.terminalKey("normal typing"), false);
	assert.doesNotMatch(frame(s), /enter details/);
});
test("stable row through completion reorder, selected disappearance and cap-zero never leave invisible focus", async () => {
	const s = instance();
	const older = await launch(s, "older");
	const selected = await launch(s, "selected");
	await launch(s, "newest");
	s.terminalKey("down");
	s.terminalKey("down");
	assert.match(frame(s), /▸ .*worker-selected/);
	await s.fire("session_info_changed", { name: "parent rename" });
	await s.toolCall("delegation_close", { id: older.id });
	await settle();
	assert.match(frame(s), /▸ .*worker-selected/);
	await s.toolCall("delegation_close", { id: selected.id });
	await settle();
	assert.doesNotMatch(frame(s), /worker-selected/);
	assert.match(frame(s), /▸ .*worker-newest/);
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(join(agentDir, "squire", "settings.json"), JSON.stringify({ delegateWidgetMaxEntries: 0 }));
	// A real Results change queues configuration refresh without waiting on a cosmetic timer.
	await launch(s, "hidden");
	assert.equal(frame(s), "");
	assert.equal(s.terminalKey("down"), false);
});
test("dashboard resume uses existing eligibility/task flow, not renderer authority", async () => {
	const s = session({ mode: "tui", ui: { editor: ["continue locally"] } });
	active.push(s);
	const child = await launch(s, "resume");
	s.tmux.exit(child.windowId);
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(
		join(sessionDir, `saved_${child.id}.jsonl`),
		`${JSON.stringify({ type: "session", id: child.id, cwd: root })}\n`,
	);
	s.queueCustom(keyScript(["r"]));
	s.queueCustom(keyScript(["escape"]));
	await s.command("delegates");
	assert.equal(s.tmux.opened.length, 2);
	const latest = s.entries.filter((e) => e.data.requestId).at(-1)!.data;
	assert.equal(latest.sessionId, child.id);
	assert.equal(latest.resumedFrom, child.id);
	assert.equal(s.editors.at(-1)?.title, "Follow-up for worker-resume");
});

test("pending opening and post-confirm re-list protect the empty prompt until dashboard focus mounts", async () => {
	const s = session({ mode: "tui", ui: { confirm: [false] } });
	active.push(s);
	await launch(s, "gated");
	const original = s.tmux.listWindows.bind(s.tmux);
	let release!: () => void, entered!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const ready = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let initial = true;
	s.tmux.listWindows = async () => {
		if (initial) {
			entered();
			await gate;
		}
		return original();
	};
	s.queueCustom(keyScript(["x"]));
	s.queueCustom(keyScript(["escape"]));
	s.terminalKey("down");
	s.terminalKey("enter");
	await ready;
	for (const key of ["escape", "x", "p", "r", "enter"]) assert.equal(s.terminalKey(key), true);
	let resume!: () => void, between!: () => void;
	const loopGate = new Promise<void>((resolve) => {
		resume = resolve;
	});
	const loopReady = new Promise<void>((resolve) => {
		between = resolve;
	});
	s.tmux.listWindows = async () => {
		if (s.confirms.length) {
			between();
			await loopGate;
		}
		return original();
	};
	initial = false;
	release();
	await loopReady;
	// The real navigator has closed the confirmation and awaits its next listing.
	for (const key of ["escape", "x", "p", "r"]) assert.equal(s.terminalKey(key), true);
	assert.equal(s.confirms.length, 1);
	assert.equal(s.tmux.killed.length, 0);
	resume();
	await settle();
	assert.match(frame(s), /▸ .*worker-gated/);
	assert.equal(s.terminalKey("escape"), true);
	assert.equal(s.terminalKey("escape"), false, "only the first returned-list Escape is owned");
});
