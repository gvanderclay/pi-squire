// Agent files: one `<name>.md` per agent in `<agent dir>/agents/` and, in a
// trusted project, `<cwd>/.pi/agents/`. These tests cover where the roster is
// read from and what each frontmatter field does to the delegate: its model,
// thinking, tools (with the `delegateTools` setting), extensions, prompt, name
// on screen and the fields a call cannot override. They drive the extension
// only through its registration function: a temporary agent directory, a fake
// Pi session, the fake tmux.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, type TestContext, test } from "node:test";

import { readRoster } from "../src/agents.ts";
import {
	agentDir,
	agentFile,
	cleanup,
	keyScript,
	resetRoot,
	root,
	rosterDir,
	session,
	writeAgent,
	writeProjectAgent,
} from "./harness.ts";

beforeEach(() => resetRoot());
after(() => cleanup());

const SCOUT = { description: "Looks things up", model: "alpha/fast-model", thinking: "low" };

const pair = (argv: readonly string[], flag: string) => argv.slice(argv.indexOf(flag), argv.indexOf(flag) + 2);
const promptOf = (argv: readonly string[]) => readFileSync(argv[argv.indexOf("--append-system-prompt") + 1], "utf8");

/** A fresh project directory for this test, so one test's `.pi/agents` cannot reach another. */
const project = () => mkdtempSync(join(root, "project-"));

const setSettings = (settings: unknown): void => {
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(join(agentDir, "squire", "settings.json"), JSON.stringify(settings));
};

// ---------------------------------------------------------------------------
// Where agents are read from

test("an agent is <agent dir>/agents/<name>.md, named for the file", async () => {
	writeAgent("scout", agentFile(SCOUT));
	writeFileSync(join(rosterDir, "notes.txt"), "not an agent");
	mkdirSync(join(rosterDir, "folder.md"));
	const { agents, warnings } = readRoster(agentDir);
	assert.deepEqual(
		agents.map((agent) => [agent.name, agent.path]),
		[["scout", join(rosterDir, "scout.md")]],
	);
	assert.deepEqual(warnings, []);
});

test("a trusted project's agents load too, and a project file replaces the global one of the same name", async () => {
	const cwd = project();
	writeAgent("scout", agentFile(SCOUT));
	writeAgent("worker", agentFile({ ...SCOUT, description: "Global worker" }));
	writeProjectAgent(cwd, "worker", agentFile({ ...SCOUT, description: "Project worker", model: "alpha/deep-model" }));
	writeProjectAgent(cwd, "local", agentFile({ ...SCOUT, description: "Only here" }));
	const s = session({ cwd, projectTrusted: true });
	await s.start();
	const description = s.tool("delegate").description;
	assert.ok(description.includes("- local — Only here"), description);
	assert.ok(description.includes("- worker — Project worker (default alpha/deep-model"), description);
	assert.ok(!description.includes("Global worker"), description);
	await s.delegate("worker do it");
	assert.equal(s.tmux.opened[0].argv[s.tmux.opened[0].argv.indexOf("--model") + 1], "alpha/deep-model");
});

test("an untrusted project's agents are not read, so a cloned repository cannot change a delegate", async () => {
	const cwd = project();
	writeAgent("worker", agentFile({ ...SCOUT, description: "Global worker" }));
	writeProjectAgent(cwd, "worker", agentFile({ ...SCOUT, description: "Project worker", model: "alpha/deep-model" }));
	writeProjectAgent(cwd, "local", agentFile({ ...SCOUT, description: "Only here" }));
	const s = session({ cwd, projectTrusted: false });
	await s.start();
	const description = s.tool("delegate").description;
	assert.ok(description.includes("Global worker") && !description.includes("Project worker"), description);
	await s.delegate("local do it");
	assert.deepEqual(s.tmux.opened, []);
	assert.match(s.errors[0], /no agent named "local"; available: worker/);
});

test("enabled: false leaves an agent out, and a project file with it hides the global agent there", async () => {
	const cwd = project();
	writeAgent("scout", agentFile(SCOUT));
	writeAgent("worker", agentFile({ ...SCOUT, enabled: "false" }));
	writeProjectAgent(cwd, "scout", agentFile({ enabled: "false" }));
	assert.deepEqual(
		readRoster(agentDir).agents.map((agent) => agent.name),
		["scout"],
	);
	const { agents, warnings } = readRoster(agentDir, join(cwd, ".pi", "agents"));
	assert.deepEqual(agents, []);
	assert.deepEqual(warnings, []);
});

test("an enabled that is not true or false leaves the agent out with a warning", async () => {
	writeAgent("scout", agentFile({ ...SCOUT, enabled: "sometimes" }));
	const { agents, warnings } = readRoster(agentDir);
	assert.deepEqual(agents, []);
	assert.ok(warnings[0].endsWith(`scout.md has enabled "sometimes", not true or false; skipped`), warnings[0]);
});

// ---------------------------------------------------------------------------
// Invalid agent files are disabled

test("an invalid agent file is disabled: out of the roster and the tool description, with a warning at session start", async () => {
	writeAgent("scout", agentFile(SCOUT));
	writeAgent("bad", agentFile({ ...SCOUT, description: "Broken", tools: "{ a: 1 }" }));
	const { agents, disabled } = readRoster(agentDir);
	assert.deepEqual(
		agents.map((agent) => agent.name),
		["scout"],
	);
	assert.deepEqual(
		disabled.map((item) => [item.name, item.path]),
		[["bad", join(rosterDir, "bad.md")]],
	);
	const s = session();
	await s.start();
	const description = s.tool("delegate").description;
	assert.ok(description.includes("- scout —") && !description.includes("bad"), description);
	assert.equal(s.warnings.length, 1, s.warnings.join("\n"));
	assert.ok(s.warnings[0].includes(join(rosterDir, "bad.md")), s.warnings[0]);
	assert.match(s.warnings[0], /has tools \{"a":1\}, not a comma-separated list of tool names/);
	// Each warning is shown once per session, not before every run.
	await s.prepare();
	assert.equal(s.warnings.length, 1, s.warnings.join("\n"));
	// A file that turns invalid later is warned about before the next run.
	writeAgent("scout", agentFile({ ...SCOUT, "auto-exit": "maybe" }));
	await s.prepare();
	assert.equal(s.warnings.length, 2, s.warnings.join("\n"));
	assert.match(s.warnings[1], /scout\.md has auto-exit "maybe"/);
	assert.ok(!s.tool("delegate").description.includes("- scout —"), s.tool("delegate").description);
});

test("calling a disabled agent by name gets an error naming its file and reason, from the tool and the command", async () => {
	writeAgent("bad", agentFile({ ...SCOUT, extensions: "./nope.ts" }));
	const s = session();
	await s.start();
	await s.delegate("bad go");
	assert.deepEqual(s.tmux.opened, []);
	assert.deepEqual(s.sendCalls, []);
	assert.equal(s.errors.length, 1);
	assert.match(
		s.errors[0],
		/agent "bad" is disabled because its file is invalid: .*bad\.md has extension .*nope\.ts, which does not exist/,
	);
	await assert.rejects(
		s.toolCall("delegate", { agent: "bad", task: "go" }),
		/agent "bad" is disabled because its file is invalid: .*nope\.ts, which does not exist/,
	);
});

// ---------------------------------------------------------------------------
// Defaults from the parent

test("with no model or thinking the delegate runs on the parent's, and description defaults to the name", async () => {
	writeAgent("plain", "Just do it.\n");
	const s = session({ parentModel: "beta/other-model", parentThinking: "high" });
	await s.start();
	assert.ok(
		s.tool("delegate").description.includes("- plain — plain (default this session's model, thinking this session's)"),
		s.tool("delegate").description,
	);
	const result = await s.toolCall("delegate", { agent: "plain", task: "go" });
	const { argv } = s.tmux.opened[0];
	assert.deepEqual(pair(argv, "--model"), ["--model", "beta/other-model"]);
	assert.deepEqual(pair(argv, "--thinking"), ["--thinking", "high"]);
	assert.equal((result.structuredContent as { model: string }).model, "beta/other-model");
});

test("an unknown thinking level is dropped with a warning and the parent's level applies", async () => {
	writeAgent("scout", agentFile({ ...SCOUT, thinking: "very" }));
	const s = session({ parentThinking: "minimal" });
	await s.start();
	await s.delegate("scout go");
	assert.deepEqual(pair(s.tmux.opened[0].argv, "--thinking"), ["--thinking", "minimal"]);
	assert.ok(
		s.warnings.some((warning) =>
			warning.endsWith(
				`scout.md has thinking "very", not one of off, minimal, low, medium, high, xhigh, max; the parent's level applies`,
			),
		),
		s.warnings.join("\n"),
	);
});

test("every thinking level Pi takes is accepted, off included", async () => {
	for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"])
		writeAgent(`t-${level}`, agentFile({ ...SCOUT, thinking: level }));
	const { agents, warnings } = readRoster(agentDir);
	assert.deepEqual(
		agents.map((agent) => agent.thinking),
		["high", "low", "max", "medium", "minimal", "off", "xhigh"],
	);
	assert.deepEqual(warnings, []);
});

test("a model or fallback the registry does not know goes to the child unchanged, for Pi to resolve", async () => {
	writeAgent("pattern", agentFile({ ...SCOUT, model: "sonnet", fallback: "alpha/*, beta/other-model" }));
	const s = session();
	await s.start();
	await s.delegate("pattern go");
	assert.deepEqual(s.errors, []);
	const opened = s.tmux.opened[0];
	assert.deepEqual(pair(opened.argv, "--model"), ["--model", "sonnet"]);
	assert.equal(opened.env.PI_DELEGATE_FALLBACK, "alpha/*,beta/other-model");
});

// ---------------------------------------------------------------------------
// Tools

test("a tools line is the delegate's whole list, as a comma-separated or YAML list", async () => {
	writeAgent("listed", agentFile({ ...SCOUT, tools: "device_run, read" }));
	writeAgent("yaml", agentFile({ ...SCOUT, tools: "[read, grep]" }));
	const s = session();
	await s.start();
	for (const name of ["listed", "yaml"]) await s.delegate(`${name} go`);
	assert.deepEqual(s.errors, []);
	const [listed, yaml] = s.tmux.opened.map((opened) => opened.argv);
	assert.deepEqual(pair(listed, "--tools"), ["--tools", "device_run,read"]);
	assert.deepEqual(pair(yaml, "--tools"), ["--tools", "read,grep"]);
	for (const argv of s.tmux.opened.map((opened) => opened.argv)) {
		assert.ok(!argv.includes("--exclude-tools") && !argv.includes("--no-tools"), argv.join(" "));
	}
});

test("without a tools field the delegate gets the parent's active tools, less the delegation tools", async () => {
	writeAgent("none", agentFile({ ...SCOUT, extensions: "" }));
	const s = session({
		activeTools: ["read", "grep", "delegate", "delegation_status", "codemode", "delegation_resume"],
	});
	await s.start();
	await s.delegate("none go");
	assert.deepEqual(s.errors, []);
	const { argv } = s.tmux.opened[0];
	assert.deepEqual(pair(argv, "--tools"), ["--tools", "read,grep,codemode"]);
	assert.ok(!argv.includes("--no-tools") && !argv.includes("-e"), argv.join(" "));
});

test("a parent restricted to one tool passes just that tool, read when each launch starts", async () => {
	writeAgent("none", agentFile(SCOUT));
	const s = session({ activeTools: ["read", "delegate"] });
	await s.start();
	await s.delegate("none go");
	s.pi.setActiveTools(["read", "bash", "delegate"]);
	await s.toolCall("delegate", { agent: "none", task: "again" });
	const [first, second] = s.tmux.opened.map((opened) => opened.argv);
	assert.deepEqual(pair(first, "--tools"), ["--tools", "read"]);
	assert.deepEqual(pair(second, "--tools"), ["--tools", "read,bash"]);
});

test("a parent whose only active tools are the delegation tools gives a delegate without a tools field no tools", async () => {
	writeAgent("none", agentFile(SCOUT));
	const s = session({ activeTools: ["delegate", "delegation_status", "delegation_close", "delegation_resume"] });
	await s.start();
	await s.delegate("none go");
	const { argv } = s.tmux.opened[0];
	assert.ok(argv.includes("--no-tools") && !argv.includes("--tools"), argv.join(" "));
});

test("an empty tools field, tools: or tools: [], gives the delegate no tools at all", async () => {
	writeAgent("bare", agentFile({ ...SCOUT, tools: "" }));
	writeAgent("list", agentFile({ ...SCOUT, tools: "[]" }));
	assert.deepEqual(
		readRoster(agentDir).agents.map((agent) => agent.tools),
		[[], []],
	);
	const s = session();
	await s.start();
	for (const name of ["bare", "list"]) await s.delegate(`${name} go`);
	assert.deepEqual(s.errors, []);
	for (const { argv } of s.tmux.opened) {
		assert.ok(argv.includes("--no-tools") && !argv.includes("--tools"), argv.join(" "));
	}
	assert.match(s.tool("delegate").description, /- bare — .*thinking low, no tools\)/);
});

test("a tools line of only -name entries is the parent's tools less those, then delegateTools", async () => {
	setSettings({ delegateTools: ["reach_parent", "bash"] });
	writeAgent("less", agentFile({ ...SCOUT, tools: "-bash, -edit" }));
	writeAgent("nomcp", agentFile({ ...SCOUT, tools: "[-mcp__*]" }));
	const { agents, warnings } = readRoster(agentDir);
	assert.deepEqual(warnings, []);
	assert.deepEqual(
		agents.map((agent) => [agent.tools, agent.toolsExcept]),
		[
			[undefined, ["bash", "edit"]],
			[undefined, ["mcp__*"]],
		],
	);
	const s = session({ activeTools: ["read", "bash", "edit", "mcp__docs__search", "mcp__docs__read", "delegate"] });
	await s.start();
	for (const name of ["less", "nomcp"]) await s.delegate(`${name} go`);
	assert.deepEqual(s.errors, []);
	const [less, nomcp] = s.tmux.opened.map((opened) => opened.argv);
	// delegateTools is added after the removals, so its bash stays.
	assert.deepEqual(pair(less, "--tools").slice(1)[0].split(",").slice(0, 4), [
		"read",
		"mcp__docs__search",
		"mcp__docs__read",
		"reach_parent",
	]);
	assert.ok(pair(less, "--tools")[1].split(",").includes("bash"), less.join(" "));
	assert.ok(!pair(less, "--tools")[1].split(",").includes("edit"), less.join(" "));
	assert.deepEqual(pair(nomcp, "--tools")[1].split(",").slice(0, 4), ["read", "bash", "edit", "reach_parent"]);
	assert.match(s.tool("delegate").description, /- less — .*tools: this session's except bash\/edit\)/);
});

test("a tools line with a +name entry, or with names and -name entries mixed, disables the agent", async () => {
	writeAgent("plus", agentFile({ ...SCOUT, tools: "+codemode" }));
	writeAgent("plusmixed", agentFile({ ...SCOUT, tools: "read, +grep" }));
	writeAgent("mixed", agentFile({ ...SCOUT, tools: "read, -bash" }));
	writeAgent("bare", agentFile({ ...SCOUT, tools: "-, -bash" }));
	writeAgent("scout", agentFile(SCOUT));
	const { agents, disabled } = readRoster(agentDir);
	assert.deepEqual(
		agents.map((agent) => agent.name),
		["scout"],
	);
	const reasons = Object.fromEntries(disabled.map((item) => [item.name, item.reason]));
	assert.match(reasons.plus, /plus\.md has tools entry "\+codemode": \+name entries are not accepted/);
	assert.match(reasons.plusmixed, /plusmixed\.md has tools entry "\+grep": \+name entries are not accepted/);
	assert.match(reasons.mixed, /mixed\.md has tools that mix tool names with -name entries/);
	assert.match(reasons.bare, /bare\.md has tools entry "-", which names no tool/);
	const s = session();
	await s.start();
	await s.delegate("mixed go");
	assert.deepEqual(s.tmux.opened, []);
	assert.match(s.errors[0], /agent "mixed" is disabled because its file is invalid: .*mix tool names with -name/);
});

test("a delegateTools entry that starts with + or - refuses every launch with an error naming the file", async () => {
	for (const entry of ["+codemode", "-bash"]) {
		setSettings({ delegateTools: ["reach_parent", entry] });
		writeAgent("scout", agentFile(SCOUT));
		const s = session();
		await s.start();
		await s.delegate("scout go");
		assert.deepEqual(s.tmux.opened, []);
		assert.deepEqual(s.sendCalls, []);
		assert.equal(s.errors.length, 1);
		assert.ok(s.errors[0].includes(join(agentDir, "squire", "settings.json")), s.errors[0]);
		assert.ok(
			s.errors[0].includes(`delegateTools entries are tool names; ${JSON.stringify(entry)} starts with`),
			s.errors[0],
		);
	}
});

test("an absent tools field and an empty one read differently", async () => {
	writeAgent("absent", agentFile(SCOUT));
	writeAgent("empty", agentFile({ ...SCOUT, tools: "" }));
	assert.deepEqual(
		readRoster(agentDir).agents.map((agent) => [agent.name, agent.tools]),
		[
			["absent", undefined],
			["empty", []],
		],
	);
});

test("the delegateTools setting is added to every delegate: a tools line, an empty one and none", async () => {
	setSettings({ delegateTools: ["reach_parent", "mcp__mail__*", "read"] });
	writeAgent("listed", agentFile({ ...SCOUT, tools: "read, grep" }));
	writeAgent("empty", agentFile({ ...SCOUT, tools: "[]" }));
	writeAgent("none", agentFile(SCOUT));
	const s = session({ activeTools: ["read", "bash", "delegate"] });
	await s.start();
	for (const name of ["listed", "empty", "none"]) await s.delegate(`${name} go`);
	assert.deepEqual(s.errors, []);
	const [listed, empty, none] = s.tmux.opened.map((opened) => opened.argv);
	assert.deepEqual(pair(listed, "--tools"), ["--tools", "read,grep,reach_parent,mcp__mail__*"]);
	assert.deepEqual(pair(empty, "--tools"), ["--tools", "reach_parent,mcp__mail__*,read"]);
	assert.deepEqual(pair(none, "--tools"), ["--tools", "read,bash,reach_parent,mcp__mail__*"]);
	for (const argv of [listed, empty, none]) assert.ok(!argv.includes("--no-tools"), argv.join(" "));
});

test("a delegateTools that is not a list of names refuses every launch before anything is sent", async () => {
	setSettings({ delegateTools: "reach_parent" });
	writeAgent("listed", agentFile({ ...SCOUT, tools: "read" }));
	writeAgent("none", agentFile(SCOUT));
	const s = session();
	await s.start();
	await s.delegate("listed go");
	await s.delegate("none go");
	assert.deepEqual(s.tmux.opened, []);
	assert.deepEqual(s.sendCalls, []);
	assert.equal(s.errors.length, 2);
	for (const error of s.errors) assert.match(error, /delegateTools must be a list of tool names or patterns/);
});

test("exclude-tools is no longer read: it passes no flag and says so", async () => {
	writeAgent("scout", agentFile({ ...SCOUT, "exclude-tools": "edit, write" }));
	const s = session();
	await s.start();
	await s.delegate("scout go");
	assert.equal(s.tmux.opened.length, 1);
	assert.ok(!s.tmux.opened[0].argv.includes("--exclude-tools"));
	assert.ok(
		s.warnings.some((warning) =>
			warning.endsWith(
				"scout.md has exclude-tools, which is no longer read; list the delegate's tools in tools instead",
			),
		),
		s.warnings.join("\n"),
	);
});

test("a tools that is not a list leaves the agent out with a warning", async () => {
	writeAgent("bad", agentFile({ ...SCOUT, tools: "{ a: 1 }" }));
	const { agents, warnings } = readRoster(agentDir);
	assert.deepEqual(agents, []);
	assert.ok(warnings[0].includes("has tools"), warnings[0]);
});

test("keys pi-squire does not know, and the ones it knows to ignore, are ignored without a warning", async () => {
	writeAgent(
		"scout",
		agentFile({
			...SCOUT,
			max_turns: "5",
			inherit_context: "true",
			run_in_background: "true",
			permission: "\n  bash: deny",
		}),
	);
	const { agents, warnings } = readRoster(agentDir);
	assert.equal(agents.length, 1);
	assert.deepEqual(warnings, []);
});

// ---------------------------------------------------------------------------
// fallback and extensions

test("fallback parses as a comma-separated string or a YAML list, and is empty when absent", async () => {
	writeAgent("a", agentFile({ ...SCOUT, fallback: "beta/other-model, alpha/deep-model" }));
	writeAgent("b", agentFile({ ...SCOUT, fallback: "[beta/other-model, alpha/deep-model]" }));
	writeAgent("c", agentFile({ ...SCOUT, fallback: "\n  - beta/other-model\n  - alpha/deep-model" }));
	writeAgent("d", agentFile(SCOUT));
	const { agents, warnings } = readRoster(agentDir);
	assert.deepEqual(
		agents.map((agent) => agent.fallback),
		[
			["beta/other-model", "alpha/deep-model"],
			["beta/other-model", "alpha/deep-model"],
			["beta/other-model", "alpha/deep-model"],
			[],
		],
	);
	assert.deepEqual(warnings, []);
});

test("a fallback that is not a list is ignored with a warning and the agent still loads", async () => {
	writeAgent("a", agentFile({ ...SCOUT, fallback: "5" }));
	writeAgent("b", agentFile({ ...SCOUT, fallback: "\n  x: y" }));
	const { agents, warnings } = readRoster(agentDir);
	assert.deepEqual(
		agents.map((agent) => agent.fallback),
		[[], []],
	);
	assert.ok(warnings[0].endsWith(`a.md has fallback 5, not a list of models; ignored`), warnings[0]);
	assert.ok(warnings[1].endsWith(`b.md has fallback {"x":"y"}, not a list of models; ignored`), warnings[1]);
});

test("extensions become repeated -e flags, ~ and paths relative to the agent file's folder resolved", async () => {
	writeAgent("tester", agentFile({ ...SCOUT, extensions: "./ext.ts, ~/home-ext.ts" }));
	const rel = join(rosterDir, "ext.ts");
	writeFileSync(rel, "");
	const savedHome = process.env.HOME;
	process.env.HOME = agentDir; // os.homedir() follows HOME on POSIX
	const home = join(homedir(), "home-ext.ts");
	writeFileSync(home, "");
	try {
		const { agents } = readRoster(agentDir);
		assert.deepEqual(agents[0].extensions, [rel, home]);
		const s = session();
		await s.start();
		await s.delegate("tester go");
		assert.deepEqual(s.errors, []);
		const { argv } = s.tmux.opened[0];
		assert.deepEqual(argv.flatMap((arg, i) => (arg === "-e" ? [argv[i + 1]] : [])).slice(-2), [rel, home]);
		assert.ok(!argv.includes("--no-extensions") && !argv.includes("-ne"), argv.join(" "));
	} finally {
		process.env.HOME = savedHome;
		rmSync(home);
	}
});

test("a project agent's relative extension resolves against the project's agents folder", async () => {
	const cwd = project();
	const path = writeProjectAgent(cwd, "tester", agentFile({ ...SCOUT, extensions: "./ext.ts" }));
	writeFileSync(join(cwd, ".pi", "agents", "ext.ts"), "");
	const { agents } = readRoster(agentDir, join(cwd, ".pi", "agents"));
	assert.equal(agents[0].path, path);
	assert.deepEqual(agents[0].extensions, [join(cwd, ".pi", "agents", "ext.ts")]);
});

test("a missing extension path leaves the agent out with a warning", async () => {
	writeAgent("tester", agentFile({ ...SCOUT, extensions: "./nope.ts" }));
	const { agents, warnings } = readRoster(agentDir);
	assert.deepEqual(agents, []);
	assert.ok(warnings[0].includes("nope.ts, which does not exist; skipped"), warnings[0]);
});

// ---------------------------------------------------------------------------
// prompt_mode

test("by default the body is wrapped in <agent_instructions>, and an empty body adds nothing", async () => {
	writeAgent("wrapped", agentFile(SCOUT, "Look things up.\n\nCarefully."));
	writeAgent("empty", `---\nmodel: alpha/fast-model\n---\n`);
	writeAgent("unknown", agentFile({ ...SCOUT, prompt_mode: "prepend" }, "Look things up."));
	const s = session();
	await s.start();
	for (const name of ["wrapped", "empty", "unknown"]) await s.delegate(`${name} go`);
	const [wrapped, empty, unknown] = s.tmux.opened.map((opened) => promptOf(opened.argv));
	assert.ok(
		wrapped.startsWith(
			"<agent_instructions>\nLook things up.\n\nCarefully.\n</agent_instructions>\n\nEnd with one self-contained final message:",
		),
		wrapped,
	);
	assert.ok(empty.startsWith("End with one self-contained final message:"), empty);
	assert.ok(unknown.startsWith("<agent_instructions>\nLook things up.\n</agent_instructions>"), unknown);
	assert.ok(
		s.warnings.some((warning) =>
			warning.endsWith(`unknown.md has prompt_mode "prepend", not append or replace; append applies`),
		),
	);
});

// ---------------------------------------------------------------------------
// locked

test("locked: true refuses a call's model and thinking for the fields the file sets, and the result says so", async () => {
	writeAgent("strict", agentFile({ ...SCOUT, locked: "true" }));
	const s = session();
	await s.start();
	const result = await s.toolCall("delegate", {
		agent: "strict",
		task: "go",
		model: "alpha/deep-model",
		thinking: "high",
	});
	const { argv } = s.tmux.opened[0];
	assert.deepEqual(pair(argv, "--model"), ["--model", "alpha/fast-model"]);
	assert.deepEqual(pair(argv, "--thinking"), ["--thinking", "low"]);
	const notice =
		"Agent strict locks model and thinking, so the model alpha/deep-model and thinking high given were not used.";
	assert.ok(result.content[0].text.includes(notice), result.content[0].text);
	assert.deepEqual((result.structuredContent as { notices: string[] }).notices, [notice]);
	assert.ok(s.tool("delegate").description.includes("locked: model/thinking"), s.tool("delegate").description);
});

test("locked: true locks only what the file sets; a list locks what it names; the agent's own value passes quietly", async () => {
	writeAgent("partial", agentFile({ description: "No model", thinking: "low", locked: "true" }));
	writeAgent("listed", agentFile({ ...SCOUT, locked: "[thinking]" }));
	const s = session();
	await s.start();
	await s.delegate("partial --model alpha/deep-model --thinking high go");
	await s.delegate("listed --model alpha/deep-model --thinking high go");
	await s.delegate("listed --thinking low go");
	const [partial, listed, same] = s.tmux.opened.map((opened) => opened.argv);
	assert.deepEqual(pair(partial, "--model"), ["--model", "alpha/deep-model"]);
	assert.deepEqual(pair(partial, "--thinking"), ["--thinking", "low"]);
	assert.deepEqual(pair(listed, "--model"), ["--model", "alpha/deep-model"]);
	assert.deepEqual(pair(listed, "--thinking"), ["--thinking", "low"]);
	assert.deepEqual(pair(same, "--thinking"), ["--thinking", "low"]);
	assert.deepEqual(s.notes.filter((note) => note.includes("locks")).length, 2);
	assert.ok(
		s.notes.some((note) => note.includes("Agent listed locks thinking, so the thinking high given was not used.")),
	);
});

/** Mark `scope` usage-limited for an hour in the marks file every session reads, until the test ends. */
function markLimited(t: TestContext, scope: string): void {
	const now = Date.now();
	const mark = { scope, reason: "limit", recordedAt: now, clearsAt: now + 3_600_000, source: "reactive", hits: 1 };
	const file = join(agentDir, "pi-squire-limits.json");
	writeFileSync(file, JSON.stringify([{ ...mark, delegations: [] }]));
	t.after(() => rmSync(file, { force: true }));
}

test("a locked alias passed back as given is no override: no notice, and no provider/id refusal", async () => {
	writeAgent("alias", agentFile({ ...SCOUT, model: "fast-model", locked: "true" }));
	const s = session();
	await s.start();
	const result = await s.toolCall("delegate", { agent: "alias", task: "go", model: "fast-model", thinking: "low" });
	assert.deepEqual(pair(s.tmux.opened[0].argv, "--model"), ["--model", "fast-model"]);
	assert.deepEqual((result.structuredContent as { notices: string[] }).notices, []);
});

test("a locked model passed back as given keeps its fallbacks, as if no model was passed", async (t) => {
	writeAgent("strict", agentFile({ ...SCOUT, fallback: "beta/other-model", locked: "[model]" }));
	const s = session();
	await s.start();
	await s.toolCall("delegate", { agent: "strict", task: "go", model: "alpha/fast-model" });
	assert.equal(s.tmux.opened[0].env.PI_DELEGATE_FALLBACK, "beta/other-model");
	markLimited(t, "alpha/fast-model");
	const result = await s.toolCall("delegate", { agent: "strict", task: "again", model: "alpha/fast-model" });
	const details = result.structuredContent as { model: string; skipped: { model: string }[]; notices: string[] };
	assert.equal(details.model, "beta/other-model");
	assert.deepEqual(
		details.skipped.map((item) => item.model),
		["alpha/fast-model"],
	);
	assert.deepEqual(details.notices, []);
	assert.match(result.content[0].text, /Used fallback beta\/other-model because alpha\/fast-model is usage-limited/);
});

test("a locked field the file leaves unset keeps the parent's value, and a call's other value is refused", async () => {
	writeAgent("bare", agentFile({ description: "No model or thinking", locked: "[model, thinking]" }));
	const s = session({ parentModel: "beta/other-model", parentThinking: "high" });
	await s.start();
	const result = await s.toolCall("delegate", {
		agent: "bare",
		task: "go",
		model: "alpha/deep-model",
		thinking: "low",
	});
	const { argv } = s.tmux.opened[0];
	assert.deepEqual(pair(argv, "--model"), ["--model", "beta/other-model"]);
	assert.deepEqual(pair(argv, "--thinking"), ["--thinking", "high"]);
	assert.deepEqual((result.structuredContent as { notices: string[] }).notices, [
		"Agent bare locks model and thinking, so the model alpha/deep-model and thinking low given were not used.",
	]);
});

// ---------------------------------------------------------------------------
// display_name

test("display_name names the window and the /delegates row; the agent's name still reaches session:launch", async () => {
	writeAgent("reviewer", agentFile({ ...SCOUT, display_name: "Code Reviewer" }));
	const s = session();
	await s.start();
	const launches: { agent: string; env: Record<string, string> }[] = [];
	s.events.on("session:launch", (data) => launches.push(data as { agent: string; env: Record<string, string> }));
	const result = await s.toolCall("delegate", { agent: "reviewer", task: "go", label: "pr-12" });
	const opened = s.tmux.opened[0];
	assert.equal(opened.name, "Code Reviewer-pr-12");
	assert.equal((result.structuredContent as { windowName: string }).windowName, "Code Reviewer-pr-12");
	assert.equal((result.structuredContent as { agent: string }).agent, "reviewer");
	assert.equal(launches[0].agent, "reviewer");
	assert.equal(opened.env.PI_DELEGATE_AGENT, "reviewer");
	assert.equal(s.entries[0].data.displayName, "Code Reviewer");
	const script = keyScript(["escape"]);
	s.queueCustom(script);
	await s.command("delegates");
	assert.match(script.frames[0], /Code Reviewer-pr-12 · Code Reviewer · running/);
});
