import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { readRoster } from "../src/agents.ts";
import { doctor } from "../src/doctor.ts";
import { createHostRouter } from "../src/multiplexer.ts";
import { STARTER_AGENT } from "../src/starter-agent.ts";
import { FakeTmux } from "./fake-tmux.ts";
import { agentDir, cleanup, resetRoot, root, rosterDir, session, writeAgent } from "./harness.ts";

beforeEach(resetRoot);
after(cleanup);
const scope = () => `User — ${rosterDir} (all projects)`;

test("empty-roster bootstrap previews exact user file, inherits the model, and continues into task/settings", async () => {
	const s = session({
		mode: "tui",
		ui: { select: [scope()], confirm: [true], editor: ["answer"], input: [""], custom: [{}] },
	});
	await s.delegate("");
	assert.equal(readFileSync(join(rosterDir, "scout.md"), "utf8"), STARTER_AGENT);
	assert.ok(s.confirms[0].message.includes(join(rosterDir, "scout.md")));
	assert.ok(s.confirms[0].message.includes(STARTER_AGENT));
	assert.doesNotMatch(STARTER_AGENT, /^model:|^thinking:/m);
	assert.equal(s.editors[0].title, "Task for scout");
	assert.equal(s.selects.length, 1, "new scout is already selected");
	assert.equal(s.tmux.opened.length, 1);
	assert.ok(s.tmux.opened[0].argv.includes("alpha/fast-model"));
	assert.equal(readRoster(agentDir).agents[0].autoExit, true);
	assert.deepEqual(s.errors, [], "the starter dialog is not preceded by an empty-roster error");
});

test("cancel at scope or confirmation writes no file or directory and starts nothing", async () => {
	for (const ui of [{ select: [undefined] }, { select: [scope()], confirm: [false] }]) {
		const s = session({ mode: "tui", ui });
		await s.delegate("");
		assert.equal(existsSync(rosterDir), false);
		assert.equal(s.tmux.opened.length, 0);
		assert.equal(s.sendCalls.length, 0);
	}
});

test("an existing disabled scout is never overwritten", async () => {
	const text = "---\nenabled: false\n---\nKeep me\n";
	writeAgent("scout", text);
	const s = session({ mode: "tui", ui: { select: [scope()], confirm: [true] } });
	await s.delegate("");
	assert.equal(readFileSync(join(rosterDir, "scout.md"), "utf8"), text);
	assert.match(s.errors.join("\n"), /already exists.*not overwritten/);
	assert.equal(s.tmux.opened.length, 0);
});

test("exclusive create also refuses a file appearing during confirmation", async () => {
	let approve: (value: boolean) => void = () => {};
	const answer = new Promise<boolean>((resolve) => {
		approve = resolve;
	});
	const s = session({ mode: "tui", ui: { select: [scope()], confirm: [answer] } });
	const running = s.delegate("");
	while (s.confirms.length === 0) await new Promise((resolve) => setImmediate(resolve));
	writeAgent("scout", "user-owned race");
	approve(true);
	await running;
	assert.equal(readFileSync(join(rosterDir, "scout.md"), "utf8"), "user-owned race");
	assert.match(s.errors.join("\n"), /not overwritten/);
});

test("project scope is offered only to trusted projects and writes only there", async () => {
	const cwd = join(root, "project-scope");
	mkdirSync(cwd, { recursive: true });
	const dir = join(cwd, ".pi", "agents");
	const project = `Project — ${dir} (trusted project only; overrides user agents)`;
	const untrusted = session({ mode: "tui", cwd, ui: { select: [undefined] } });
	await untrusted.delegate("");
	assert.deepEqual(untrusted.selects[0].options, [scope()]);
	assert.match(untrusted.selects[0].title, /require project trust/);
	const trusted = session({
		mode: "tui",
		cwd,
		projectTrusted: true,
		ui: { select: [project], confirm: [true], editor: [undefined] },
	});
	await trusted.delegate("");
	assert.equal(readFileSync(join(dir, "scout.md"), "utf8"), STARTER_AGENT);
	assert.equal(existsSync(rosterDir), false);
	assert.equal(readRoster(agentDir, dir).agents[0].name, "scout");
});

test("trust lost while confirming project scope writes nothing", async () => {
	const cwd = join(root, "trust-lost");
	mkdirSync(cwd, { recursive: true });
	const dir = join(cwd, ".pi", "agents");
	let approve: (value: boolean) => void = () => {};
	const answer = new Promise<boolean>((resolve) => {
		approve = resolve;
	});
	const s = session({
		mode: "tui",
		cwd,
		projectTrusted: true,
		ui: {
			select: [`Project — ${dir} (trusted project only; overrides user agents)`],
			confirm: [answer],
		},
	});
	const running = s.delegate("");
	while (s.confirms.length === 0) await new Promise((resolve) => setImmediate(resolve));
	s.context.isProjectTrusted = () => false;
	approve(true);
	await running;
	assert.equal(existsSync(dir), false);
	assert.equal(existsSync(rosterDir), false);
	assert.match(s.errors.join("\n"), /creation needs a trusted project/);
});

test("a project shadow hiding the new user scout is explained instead of silently opening no form", async () => {
	const cwd = join(root, "shadow-scout");
	const dir = join(cwd, ".pi", "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "scout.md"), "---\nenabled: false\n---\n");
	const s = session({ mode: "tui", cwd, projectTrusted: true, ui: { select: [scope()], confirm: [true] } });
	await s.delegate("");
	assert.equal(readFileSync(join(rosterDir, "scout.md"), "utf8"), STARTER_AGENT);
	assert.match(s.errors.join("\n"), /starter created but not usable.*delegate-doctor/);
	assert.equal(s.editors.length, 0);
	assert.equal(s.tmux.opened.length, 0);
});

test("bootstrap is never offered in RPC, print, JSON or typed requests", async () => {
	for (const mode of ["rpc", "print", "json"] as const) {
		const s = session({ mode, hasUI: true });
		await s.delegate("");
		assert.equal(s.selects.length, 0);
		assert.equal(s.confirms.length, 0);
		assert.match(s.errors.join("\n"), /no agents are defined/);
	}
	const typed = session({ mode: "tui" });
	await typed.delegate("scout answer");
	assert.equal(typed.selects.length, 0);
	assert.equal(existsSync(rosterDir), false);
});

test("empty roster tells the tool to ask the user, not to run a slash command itself", async () => {
	const s = session();
	await assert.rejects(s.toolCall("delegate", { agent: "scout", task: "hello" }), (error: Error) => {
		assert.match(error.message, /^no agents are defined; tell the user to run \/delegate in interactive Pi/);
		assert.ok(error.message.includes(rosterDir));
		assert.match(error.message, /Retry the delegate tool after an agent is saved/);
		assert.doesNotMatch(error.message, /Retry \/delegate/);
		return true;
	});
	assert.equal(s.selects.length, 0);
	assert.equal(s.tmux.opened.length, 0);
});

test("delegate and resume tools get short host hints from cheap and full preflight", async () => {
	writeAgent("scout", STARTER_AGENT);
	for (const strict of [false, true]) {
		const s = session();
		if (strict) s.tmux.versionText = "tmux 3.1";
		else s.tmux.inside = false;
		for (const [tool, params] of [
			["delegate", { agent: "scout", task: "hello" }],
			["delegation_resume", { id: "missing", task: "hello" }],
		] as const)
			await assert.rejects(s.toolCall(tool, params), (error: Error) => {
				assert.match(error.message, /Ask the user to fix the host; \/delegate-doctor shows details\.$/);
				assert.doesNotMatch(error.message, /brew install|apt install|tmux new-session/);
				return true;
			});
		assert.equal(s.tmux.opened.length, 0);
	}
});

test("doctor reports roster paths, parse errors, settings, trust and session directory without launching or scanning", async () => {
	writeAgent("scout", STARTER_AGENT);
	writeAgent("broken", "---\nauto_exit: nope\n---\n");
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(join(agentDir, "squire", "settings.json"), "{broken");
	writeFileSync(join(agentDir, "settings.json"), "[]");
	const s = session();
	await s.start();
	const before = { send: s.sendCalls.length, scan: s.scan.calls, entries: s.entries.length };
	await s.command("delegate-doctor", "");
	const text = s.notes.join("\n");
	assert.match(text, /Roster: 1 usable/);
	assert.ok(text.includes(join(rosterDir, "scout.md")));
	assert.match(text, /Agent warning:.*broken.md.*auto_exit/);
	assert.match(text, /Squire settings:.*parse\/read error/);
	assert.match(text, /Pi user settings:.*invalid; expected/);
	assert.match(text, /untrusted; not read/);
	assert.match(text, /Session directory:.*writability not tested/);
	assert.equal(s.scan.calls, before.scan);
	// The harness send handler is intentionally simplistic; the invalid probe never opens a host.
	assert.equal(s.sendCalls.length, before.send + 1);
	assert.equal(s.tmux.opened.length, 0);
	assert.equal(s.entries.length, before.entries);
	assert.equal(s.sent.length, 0);
	assert.equal(s.userMessages.length, 0);
});

test("doctor distinguishes selected tmux, Herdr and Paseo, availability failure, absence and ambiguity", async () => {
	const ctx = session().context;
	for (const id of ["tmux", "herdr", "paseo"]) {
		const host = new FakeTmux();
		Object.defineProperty(host, "id", { value: id });
		const env = id === "paseo" ? { PASEO_AGENT_ID: "fake" } : { PI_DELEGATE_MULTIPLEXER: id };
		const text = await doctor(ctx, {
			agentDir,
			host,
			roster: () => readRoster(agentDir),
			events: createEventBus(),
			env,
		});
		assert.match(text, new RegExp(`Selected host: ${id}`));
		assert.match(text, /why:.*(?:PASEO_AGENT_ID|PI_DELEGATE_MULTIPLEXER)/);
		assert.match(text, /Host availability: launch preflight passed; connectivity and task success not proven/);
		host.unavailable = ((check?: true) =>
			check ? Promise.resolve(`${id} unavailable (fake)`) : undefined) as typeof host.unavailable;
		const unavailable = await doctor(ctx, {
			agentDir,
			host,
			roster: () => readRoster(agentDir),
			events: createEventBus(),
			env,
		});
		assert.match(unavailable, new RegExp(`Host availability: ${id} unavailable`));
		assert.match(unavailable, /Host prerequisite:/);
		assert.equal(host.opened.length, 0);
	}
	for (const reason of ["inside neither tmux nor Herdr", "inside both tmux and Herdr"]) {
		const host = createHostRouter(
			[],
			() => {
				throw new Error(reason);
			},
			() => undefined,
			"none",
		);
		const text = await doctor(ctx, {
			agentDir,
			host,
			roster: () => readRoster(agentDir),
			events: createEventBus(),
			env: {},
		});
		assert.ok(text.includes(reason));
		assert.match(
			text,
			reason.includes("both")
				? /Host prerequisite: set "multiplexer": "tmux" or "herdr".*PI_DELEGATE_MULTIPLEXER/
				: /Host prerequisite:.*tmux new-session/,
		);
		if (reason.includes("both")) assert.doesNotMatch(text, /brew install|apt install/);
	}
	const old = new FakeTmux();
	old.versionText = "tmux 3.1";
	assert.match(
		await doctor(ctx, { agentDir, host: old, roster: () => readRoster(agentDir), events: createEventBus(), env: {} }),
		/this is tmux 3.1/,
	);
});

test("doctor checks each mail hook separately with invalid payloads, not scan or tool-name inference", async () => {
	const s = session();
	const events = createEventBus();
	events.on("message:send", (data) => {
		const payload = data as { to: string; error?: string };
		assert.equal(payload.to, "");
		payload.error = "invalid destination";
	});
	events.on("message:scan", () => {
		assert.fail("doctor must not claim inbox mail");
	});
	const text = await doctor(s.context, { agentDir, host: s.tmux, roster: () => readRoster(agentDir), events, env: {} });
	assert.match(
		text,
		/message:send: a handler answered an invalid-input probe; delivery and reply were not tested; provider error: invalid destination/,
	);
	assert.match(text, /message:reply: no handler answered;.*pi install npm:pi-session-mail.*\/reload/);
});

test("doctor includes bounded provider errors without claiming healthy mail", async () => {
	for (const error of ["no active session has a mailbox address", "invalid destination", `bad\n${"x".repeat(500)}`]) {
		const events = createEventBus();
		events.on("message:send", (data) => {
			(data as { error?: string }).error = error;
		});
		const s = session();
		const text = await doctor(s.context, {
			agentDir,
			host: s.tmux,
			roster: () => readRoster(agentDir),
			events,
			env: {},
		});
		const line = text.split("\n").find((line) => line.startsWith("message:send:")) ?? "";
		assert.match(
			line,
			/a handler answered an invalid-input probe; delivery and reply were not tested; provider error:/,
		);
		if (error.length <= 300) assert.ok(line.endsWith(error));
		else {
			assert.ok(line.endsWith("… (truncated)"));
			assert.ok(line.length < 500);
			assert.ok(line.includes("bad xxx"), "provider control characters stay on one line");
		}
	}
});

test("doctor explains explicit settings and host refusals remain actionable for commands", async () => {
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(join(agentDir, "squire", "settings.json"), '{"multiplexer":"herdr"}');
	const s = session();
	await s.command("delegate-doctor", "");
	assert.match(s.notes.join("\n"), /why: multiplexer=herdr in/);
	writeAgent("scout", STARTER_AGENT);
	s.tmux.inside = false;
	await s.delegate("scout go");
	assert.match(s.errors.join("\n"), /not inside tmux.*Host prerequisite:.*brew install tmux.*delegate-doctor/);
	const noMail = session({ send: "none" });
	await noMail.delegate("scout go");
	assert.match(noMail.errors.join("\n"), /message:\*.*pi install npm:pi-session-mail.*\/reload/);
});
