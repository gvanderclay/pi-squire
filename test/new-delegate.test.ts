// The new-delegate form, `/delegate` and `/delegate-resume` with no arguments,
// and the resume picker. The settings screen is driven as a component, key by
// key; the flows around it use the harness's scripted `ctx.ui`.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

import type { Model } from "@earendil-works/pi-ai";

import type { Agent } from "../src/agents.ts";
import { type FormResult, SettingsForm } from "../src/new-delegate.ts";
import {
	agentDir,
	agentFile,
	cleanup,
	resetRoot,
	root,
	session,
	sessionDir,
	type UiAnswers,
	writeAgent,
} from "./harness.ts";

beforeEach(() => {
	resetRoot();
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "pi-squire-limits.json"), "[]");
});
after(() => cleanup());

const AGENT = { description: "Looks things up", model: "alpha/fast-model", thinking: "low" };

/** Models with different thinking support: none, up to high, and up to xhigh. */
const THINKER = { provider: "gamma", id: "thinker", reasoning: true };
const BIG = { provider: "gamma", id: "big", reasoning: true, thinkingLevelMap: { xhigh: "x" } };
const PLAIN = { provider: "alpha", id: "fast-model" };
const MODELS = [PLAIN, THINKER, BIG] as unknown as Model<never>[];

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";
const ESC = "\x1b";
const CLEAR = "\x15";

const style = { fg: (_color: string, text: string) => text } as never;

function form(overrides: Partial<Agent> = {}, cwd = root, width = 100) {
	let result: FormResult | undefined | "pending" = "pending";
	const agent = { name: "scout", model: "gamma/big", thinking: "xhigh", autoExit: true, ...overrides } as Agent;
	const screen = new SettingsForm({
		agent,
		models: MODELS,
		cwd,
		style,
		cwdProblem: (value) => (value.startsWith("/nowhere") ? `cwd ${value} is not an accessible directory` : undefined),
		done: (value) => {
			result = value;
		},
	});
	const keys = (...data: string[]) => {
		for (const key of data) screen.handleInput(key);
	};
	const type = (text: string) => keys(...text.split(""));
	const text = () => screen.render(width).join("\n");
	return { screen, keys, type, text, result: () => result };
}

// Rows: start, model, thinking, auto-exit, cwd, worktree.
const ROW = { start: 0, model: 1, thinking: 2, autoExit: 3, cwd: 4, worktree: 5 };
const goto = (f: ReturnType<typeof form>, row: number) => {
	f.keys(...Array(row).fill(DOWN));
};

test("every row starts at the agent's default and Start returns no change", () => {
	const f = form({}, root, Math.max(100, root.length + 24));
	const text = f.text();
	assert.match(text, /Start/);
	assert.match(text, /Model\s+gamma\/big/);
	assert.match(text, /Thinking\s+xhigh/);
	assert.match(text, /Auto-exit\s+on/);
	assert.match(text, new RegExp(`Working directory\\s+${root}`));
	assert.match(text, /Worktree\s+\(none\)/);
	f.keys(ENTER);
	assert.deepEqual(f.result(), {});
});

test("esc leaves the screen without a result", () => {
	const f = form();
	f.keys(ESC);
	assert.equal(f.result(), undefined);
});

test("the thinking levels are the selected model's, and a model change clamps visibly", () => {
	const f = form();
	assert.deepEqual(f.screen.levels(), ["off", "minimal", "low", "medium", "high", "xhigh"]);
	goto(f, ROW.model);
	f.keys(ENTER);
	f.type("thinker");
	assert.match(f.text(), /gamma\/thinker/);
	assert.doesNotMatch(f.text(), /gamma\/big/);
	f.keys(ENTER);
	assert.deepEqual(f.screen.levels(), ["off", "minimal", "low", "medium", "high"]);
	assert.match(f.text(), /Model\s+gamma\/thinker/);
	assert.match(f.text(), /Thinking\s+high/);
	assert.match(f.text(), /thinking xhigh is not supported by gamma\/thinker; now high/);
	f.keys(UP, ENTER); // Start
	assert.deepEqual(f.result(), { model: "gamma/thinker", thinking: "high" });
});

test("a model with no thinking support leaves only off", () => {
	const f = form({ thinking: "medium" });
	goto(f, ROW.model);
	f.keys(ENTER);
	f.type("fast");
	f.keys(ENTER);
	assert.deepEqual(f.screen.levels(), ["off"]);
	assert.match(f.text(), /Thinking\s+off/);
	assert.match(f.text(), /thinking medium is not supported by alpha\/fast-model; now off/);
});

test("a supported level survives a model change without a notice", () => {
	const f = form({ thinking: "low" });
	goto(f, ROW.model);
	f.keys(ENTER);
	f.type("thinker");
	f.keys(ENTER);
	assert.match(f.text(), /Thinking\s+low/);
	assert.doesNotMatch(f.text(), /not supported/);
});

test("esc in the model list keeps the model; filtering narrows the list", () => {
	const f = form();
	goto(f, ROW.model);
	f.keys(ENTER);
	assert.match(f.text(), /gamma\/thinker/);
	f.type("zzzz");
	assert.doesNotMatch(f.text(), /gamma\/thinker/);
	f.keys(ESC);
	assert.match(f.text(), /Model\s+gamma\/big/);
});

test("thinking and auto-exit cycle, and only changed rows are returned", () => {
	const f = form({ model: "gamma/thinker", thinking: "low" });
	goto(f, ROW.thinking);
	f.keys(ENTER); // low -> medium
	goto(f, 1);
	f.keys(ENTER); // on -> off
	assert.match(f.text(), /Thinking\s+medium/);
	assert.match(f.text(), /Auto-exit\s+off/);
	f.keys(UP, UP, UP, ENTER);
	assert.deepEqual(f.result(), { thinking: "medium", autoExit: false });
});

test("a row set back to the default is not returned", () => {
	const f = form();
	goto(f, ROW.autoExit);
	f.keys(ENTER, ENTER); // off, on
	f.keys(UP, UP, UP, ENTER);
	assert.deepEqual(f.result(), {});
});

test("the working directory is validated as --cwd", () => {
	const f = form({}, root, Math.max(100, root.length + 24));
	goto(f, ROW.cwd);
	f.keys(ENTER, CLEAR);
	f.type("/nowhere/dir");
	f.keys(ENTER);
	assert.match(f.text(), /not an accessible directory/);
	assert.match(f.text(), new RegExp(`Working directory\\s+${root}`));
	f.keys(UP, UP, UP, UP, ENTER);
	assert.deepEqual(f.result(), {}, "the refused directory was not kept");
});

test("a changed working directory is returned", () => {
	const f = form();
	goto(f, ROW.cwd);
	f.keys(ENTER, CLEAR);
	f.type("/tmp");
	f.keys(ENTER);
	f.keys(UP, UP, UP, UP, ENTER);
	assert.deepEqual(f.result(), { cwd: "/tmp" });
});

test("a worktree refuses a changed working directory, and the other way round", () => {
	const first = form({}, root, Math.max(100, root.length + 24));
	goto(first, ROW.worktree);
	first.keys(ENTER);
	first.type("feature-x");
	first.keys(ENTER);
	assert.match(first.text(), /Worktree\s+feature-x/);
	first.keys(UP); // from the worktree row up to cwd
	first.keys(ENTER, CLEAR);
	first.type("/tmp");
	first.keys(ENTER);
	assert.match(first.text(), /mutually exclusive/);
	assert.match(first.text(), new RegExp(`Working directory\\s+${root}`));
	first.keys(DOWN, DOWN, ENTER); // down to the worktree row, wrap to Start
	assert.deepEqual(first.result(), { worktree: "feature-x" });

	const second = form();
	goto(second, ROW.cwd);
	second.keys(ENTER, CLEAR);
	second.type("/tmp");
	second.keys(ENTER);
	second.keys(DOWN, ENTER);
	second.type("feature-x");
	second.keys(ENTER);
	assert.match(second.text(), /mutually exclusive/);
	assert.match(second.text(), /Worktree\s+\(none\)/);
});

test("an empty worktree answer clears it", () => {
	const f = form();
	goto(f, ROW.worktree);
	f.keys(ENTER);
	f.type("feature-x");
	f.keys(ENTER, ENTER, CLEAR, ENTER);
	assert.match(f.text(), /Worktree\s+\(none\)/);
});

// ---- the flow around the screen

/** What a launch put on the wire, minus what differs per launch: ids, names and the prompt file. */
function wire(s: ReturnType<typeof session>, index: number) {
	const window = s.tmux.opened[index];
	const argv = [...window.argv];
	for (const flag of ["--session-id", "--name", "--append-system-prompt"]) argv[argv.indexOf(flag) + 1] = "<varies>";
	const record = { ...s.entries[index].data } as Record<string, unknown>;
	for (const key of ["id", "name", "windowId", "windowName", "requestId"]) delete record[key];
	const env = { ...window.env };
	const live = JSON.parse(env.PI_SQUIRE_LIVE_LAUNCH);
	assert.equal(live.sessionId, s.entries[index].data.id);
	assert.equal(live.launchId, s.entries[index].data.id);
	env.PI_SQUIRE_LIVE_LAUNCH = "<per-launch correlation>";
	return { argv, cwd: window.cwd, env, record };
}

const option = "scout — Looks things up";

test("a form start equals /delegate with the same choices: argv, env and record", async () => {
	writeAgent("scout", agentFile(AGENT));
	const s = session({
		ui: {
			select: [option],
			editor: ["look into it"],
			input: [""],
			custom: [{ model: "alpha/deep-model", thinking: "high", autoExit: false }],
		},
	});
	await s.start();
	await s.delegate("");
	await s.delegate("scout --model alpha/deep-model --thinking high --no-auto-exit look into it");
	assert.equal(s.tmux.opened.length, 2);
	const [form, typed] = [wire(s, 0), wire(s, 1)];
	assert.deepEqual(form, typed);
	assert.equal(s.sendCalls[0].body, "look into it");
	assert.match(s.notes.join("\n"), /delegate: scout .* started in window scout-/);
	assert.deepEqual(s.errors, []);
	assert.equal(s.selects[0].title, "New delegate: agent");
	assert.deepEqual(s.selects[0].options, [option]);
});

test("a label and a worktree reach the launch as --label and --worktree would", async () => {
	writeAgent("scout", agentFile(AGENT));
	const s = session({ ui: { select: [option], editor: ["go"], input: ["  my-label "], custom: [{}] } });
	await s.start();
	await s.delegate("   ");
	assert.equal(s.tmux.opened[0].name, "scout-my-label");
});

test("an invalid label is refused before any mail or window", async () => {
	writeAgent("scout", agentFile(AGENT));
	const s = session({ ui: { select: [option], editor: ["go"], input: ["bad label!"] } });
	await s.start();
	await s.delegate("");
	assert.match(s.errors.join("\n"), /delegate: label "bad label!" must be at most 32 letters/);
	assert.equal(s.customs.length, 0, "the settings screen is not opened");
	assert.equal(s.sendCalls.length, 0);
	assert.equal(s.tmux.opened.length, 0);
});

test("an invalid working directory is refused before any mail or window", async () => {
	writeAgent("scout", agentFile(AGENT));
	const s = session({ ui: { select: [option], editor: ["go"], input: [""], custom: [{ cwd: "/nowhere/at-all" }] } });
	await s.start();
	await s.delegate("");
	assert.match(s.errors.join("\n"), /not an accessible directory/);
	assert.equal(s.sendCalls.length, 0);
	assert.equal(s.tmux.opened.length, 0);
});

test("cancelling any step starts nothing", async () => {
	writeAgent("scout", agentFile(AGENT));
	for (const ui of [
		{ select: [undefined] },
		{ select: [option], editor: [undefined] },
		{ select: [option], editor: ["   "] },
		{ select: [option], editor: ["go"], input: [undefined] },
		{ select: [option], editor: ["go"], input: [""], custom: [undefined] },
	]) {
		const s = session({ ui });
		await s.start();
		await s.delegate("");
		assert.equal(s.tmux.opened.length, 0);
		assert.equal(s.sendCalls.length, 0);
	}
});

test("the settings screen is the factory ui.custom receives, built from the registry", async () => {
	writeAgent("scout", agentFile(AGENT));
	const s = session({ ui: { select: [option], editor: ["go"], input: [""], custom: [undefined] } });
	await s.start();
	await s.delegate("");
	assert.equal(s.customs.length, 1);
	let result: unknown = "pending";
	const screen = (
		s.customs[0] as (
			tui: unknown,
			theme: unknown,
			keys: unknown,
			done: (value: unknown) => void,
		) => { render(width: number): string[]; handleInput(data: string): void }
	)(undefined, { fg: (_c: string, t: string) => t }, undefined, (value) => {
		result = value;
	});
	assert.match(screen.render(100).join("\n"), /Model\s+alpha\/fast-model/);
	// The agent's low is not supported by its non-reasoning default model: shown as off and submitted so.
	assert.match(screen.render(100).join("\n"), /Thinking\s+off/);
	screen.handleInput(ENTER);
	assert.deepEqual(result, { thinking: "off" });
});

test("/delegate with no arguments outside tmux and with an empty roster says why", async () => {
	const s = session();
	await s.start();
	await s.delegate("");
	assert.match(s.errors.join("\n"), /no agents are defined/);
	writeAgent("scout", agentFile(AGENT));
	s.tmux.inside = false;
	await s.delegate("");
	assert.match(s.errors.join("\n"), /not inside tmux/);
	assert.equal(s.selects.length, 0);
});

test("/delegate with arguments opens no form", async () => {
	writeAgent("scout", agentFile(AGENT));
	const s = session();
	await s.start();
	await s.delegate("scout look into it");
	assert.equal(s.selects.length, 0);
	assert.equal(s.editors.length, 0);
	assert.equal(s.customs.length, 0);
	assert.equal(s.tmux.opened.length, 1);
});

// ---- the resume picker

function writeSession(id: string, cwd: string): void {
	mkdirSync(sessionDir, { recursive: true });
	const header = { type: "session", version: 3, id, timestamp: "2026-10-26T00:00:00.000Z", cwd };
	writeFileSync(join(sessionDir, `20261026T000000_${id}.jsonl`), `${JSON.stringify(header)}\n`);
}

/** A session holding four delegations: two resumable, one still running, one with no session file. */
async function picker(ui: UiAnswers) {
	writeAgent("scout", agentFile(AGENT));
	const s = session({ ui });
	await s.start();
	const ids: Record<string, string> = {};
	for (const label of ["first", "second", "nofile", "running"]) {
		await s.delegate(`scout --label ${label} work`);
		const entry = s.entries.at(-1)?.data as { id: string; windowId: string };
		ids[label] = entry.id;
		if (label !== "nofile") writeSession(entry.id, root);
		if (label !== "running") s.tmux.windows.delete(entry.windowId);
	}
	return { s, ids };
}

test("the picker lists only delegations a resume accepts, newest first, with one listing", async () => {
	const { s, ids } = await picker({ select: [undefined] });
	const before = s.tmux.listCalls;
	await s.command("delegate-resume", "");
	assert.equal(s.tmux.listCalls - before, 1);
	assert.deepEqual(s.selects[0].options, [
		`scout-second · scout · ${ids.second.slice(0, 8)}`,
		`scout-first · scout · ${ids.first.slice(0, 8)}`,
	]);
	assert.equal(s.editors.length, 0);
	assert.equal(s.tmux.opened.length, 4, "nothing was resumed");
});

test("the picker resumes the chosen delegation with the follow-up from the editor", async () => {
	let choose: (value: string | undefined) => void = () => {};
	const chosen = new Promise<string | undefined>((resolve) => {
		choose = resolve;
	});
	const { s, ids } = await picker({ select: [chosen], editor: ["and now the rest"] });
	const running = s.command("delegate-resume", "");
	await new Promise((resolve) => setImmediate(resolve));
	choose(s.selects[0].options[1]);
	await running;
	assert.equal(s.tmux.opened.length, 5);
	assert.ok(s.tmux.opened[4].argv.includes("--session"));
	const record = s.entries.at(-1)?.data as { resumedFrom: string };
	assert.equal(record.resumedFrom, ids.first);
	assert.equal(s.sendCalls.at(-1)?.body, "and now the rest");
	assert.match(s.notes.join("\n"), /resumed .* as /);
	assert.equal(s.editors[0].title, "Follow-up for scout-first");
});

test("a resumed delegation leaves the picker, and an empty one says so", async () => {
	writeAgent("scout", agentFile(AGENT));
	const s = session();
	await s.start();
	await s.command("delegate-resume", "");
	assert.match(s.notes.join("\n"), /no delegation can be resumed now/);
	assert.equal(s.selects.length, 0);
});

test("/delegate-resume with arguments is unchanged and opens no picker", async () => {
	const { s, ids } = await picker({});
	await s.command("delegate-resume", `${ids.first} carry on`);
	assert.equal(s.selects.length, 0);
	assert.equal(s.editors.length, 0);
	assert.equal(s.tmux.opened.length, 5);
});

test("an agent default the default model does not support is clamped visibly and submitted as an override", () => {
	const f = form({ model: "alpha/fast-model", thinking: "high" });
	assert.deepEqual(f.screen.levels(), ["off"]);
	assert.match(f.text(), /Thinking\s+off/);
	assert.doesNotMatch(f.text(), /Thinking\s+high/);
	assert.match(f.text(), /thinking high is not supported by alpha\/fast-model; now off/);
	f.keys(ENTER); // Start
	assert.deepEqual(f.result(), { thinking: "off" });
});

test("a supported agent default shows no notice and submits no override", () => {
	const f = form({ model: "gamma/thinker", thinking: "high" });
	assert.doesNotMatch(f.text(), /not supported/);
	f.keys(ENTER);
	assert.deepEqual(f.result(), {});
});
