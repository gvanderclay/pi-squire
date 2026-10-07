// An agent's `exclude-tools` frontmatter: the tools its delegate goes without.
// The list reaches the child Pi as `--exclude-tools`, shows on the agent's
// roster line, and a name the session has no tool for leaves the agent out.
// These tests drive the extension only through its registration function: a
// temporary agent directory, a fake Pi session, the fake tmux.

import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

import { readRoster } from "../src/agents.ts";
import { agentDir, agentFile, cleanup, resetRoot, session, writeAgent } from "./harness.ts";

beforeEach(() => resetRoot());
after(() => cleanup());

const SCOUT = { description: "Looks things up", model: "alpha/fast-model", thinking: "low" };

test("exclude-tools reaches the child Pi as one --exclude-tools flag", async () => {
	writeAgent("scout", agentFile({ ...SCOUT, "exclude-tools": "edit, write" }));
	const s = session();
	await s.start();
	await s.delegate("scout find the answer");
	assert.deepEqual(s.errors, []);
	const { argv } = s.tmux.opened[0];
	const at = argv.indexOf("--exclude-tools");
	assert.deepEqual(argv.slice(at, at + 2), ["--exclude-tools", "edit,write"]);
});

test("the roster line in the delegate tool's description names the excluded tools", async () => {
	writeAgent("scout", agentFile({ ...SCOUT, "exclude-tools": "edit, write" }));
	writeAgent("worker", agentFile({ ...SCOUT, description: "Does the work" }));
	const s = session();
	await s.start();
	const description = s.tool("delegate").description;
	assert.ok(
		description.includes("- scout — Looks things up (default alpha/fast-model, thinking low, no edit/write)"),
		description,
	);
	assert.ok(description.includes("- worker — Does the work (default alpha/fast-model, thinking low)\n"), description);
});

test("a tool the session does not have leaves the agent out with a warning, so it cannot be delegated to", async () => {
	writeAgent("scout", agentFile({ ...SCOUT, "exclude-tools": "edit, wirte" }));
	writeAgent("worker", agentFile({ ...SCOUT, description: "Does the work" }));
	const s = session({ registeredTools: ["read", "bash", "edit", "write"] });
	await s.start();
	assert.ok(!s.tool("delegate").description.includes("scout"), s.tool("delegate").description);
	await assert.rejects(
		s.toolCall("delegate", { agent: "scout", task: "do it" }),
		/no agent named "scout"; available: worker/,
	);
	await s.delegate("scout do it");
	assert.deepEqual(s.tmux.opened, []);
	assert.ok(
		s.warnings.some((warning) =>
			warning.endsWith(`scout/AGENT.md has exclude-tools "wirte", not a tool this session has; skipped`),
		),
		s.warnings.join("\n"),
	);
});

test("exclude-tools may also be a YAML list", async () => {
	writeAgent("scout", agentFile({ ...SCOUT, "exclude-tools": "[edit, write]" }));
	const s = session();
	await s.start();
	await s.delegate("scout find the answer");
	assert.deepEqual(s.errors, []);
	const { argv } = s.tmux.opened[0];
	const at = argv.indexOf("--exclude-tools");
	assert.deepEqual(argv.slice(at, at + 2), ["--exclude-tools", "edit,write"]);
});

test("an exclude-tools that is not a list of names leaves the agent out with a warning", async () => {
	writeAgent("scout", agentFile({ ...SCOUT, "exclude-tools": "{ edit: true }" }));
	const s = session();
	await s.start();
	await s.delegate("scout do it");
	assert.deepEqual(s.tmux.opened, []);
	assert.ok(
		s.warnings.some((warning) =>
			warning.endsWith(
				`scout/AGENT.md has exclude-tools {"edit":true}, not a comma-separated list of tool names; skipped`,
			),
		),
		s.warnings.join("\n"),
	);
});

test("fallback parses as a comma-separated string or a YAML list, and is empty when absent", async () => {
	writeAgent("a", agentFile({ ...SCOUT, fallback: "beta/other-model, alpha/deep-model" }));
	writeAgent("b", agentFile({ ...SCOUT, fallback: "[beta/other-model, alpha/deep-model]" }));
	writeAgent("c", agentFile(SCOUT));
	const { agents } = readRoster(agentDir);
	assert.deepEqual(
		agents.map((agent) => agent.fallback),
		[["beta/other-model", "alpha/deep-model"], ["beta/other-model", "alpha/deep-model"], []],
	);
});

test("fallback may be a block-style YAML list", async () => {
	writeAgent("a", agentFile({ ...SCOUT, fallback: "\n  - beta/other-model\n  - alpha/deep-model" }));
	const { agents, warnings } = readRoster(agentDir);
	assert.deepEqual(agents[0].fallback, ["beta/other-model", "alpha/deep-model"]);
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
	assert.ok(warnings[0].endsWith(`a/AGENT.md has fallback 5, not a list of provider/id; ignored`), warnings[0]);
	assert.ok(warnings[1].endsWith(`b/AGENT.md has fallback {"x":"y"}, not a list of provider/id; ignored`), warnings[1]);
});

test("a bad fallback entry is dropped with a warning and the agent still loads", async () => {
	writeAgent("a", agentFile({ ...SCOUT, fallback: "not-a-model, beta/other-model" }));
	const { agents, warnings } = readRoster(agentDir);
	assert.deepEqual(agents[0].fallback, ["beta/other-model"]);
	assert.ok(warnings[0].endsWith(`a/AGENT.md has fallback "not-a-model", not provider/id; dropped`), warnings[0]);
	const s = session();
	await s.start();
	await s.delegate("a go");
	assert.equal(s.tmux.opened.length, 1);
	assert.ok(s.warnings.some((warning) => warning.includes(`fallback "not-a-model"`)));
});

// `extensions` and `tools` frontmatter: extra child-only extensions and a tool allowlist.

const pair = (argv: readonly string[], flag: string) => argv.slice(argv.indexOf(flag), argv.indexOf(flag) + 2);

test("extensions become repeated -e flags, ~ and relative paths resolved, and the child still gets the usual flags", async () => {
	const rel = join(agentDir, "agents", "tester", "ext.ts");
	writeAgent("tester", agentFile({ ...SCOUT, extensions: "./ext.ts, ~/home-ext.ts" }));
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
		assert.ok(argv.includes("--append-system-prompt") && argv.includes("--session-id"));
	} finally {
		process.env.HOME = savedHome;
		rmSync(home);
	}
});

test("a missing extension path leaves the agent out with a warning", async () => {
	writeAgent("tester", agentFile({ ...SCOUT, extensions: "./nope.ts" }));
	const { agents, warnings } = readRoster(agentDir);
	assert.deepEqual(agents, []);
	assert.ok(warnings[0].includes("nope.ts, which does not exist; skipped"), warnings[0]);
});

test("tools and exclude-tools both reach the child; empty or absent lists pass no flags", async () => {
	writeAgent("both", agentFile({ ...SCOUT, tools: "device_run, read", "exclude-tools": "edit" }));
	writeAgent("empty", agentFile({ ...SCOUT, tools: "", extensions: "" }));
	writeAgent("none", agentFile(SCOUT));
	const s = session({ registeredTools: ["read", "bash", "edit", "write"] });
	await s.start();
	await s.delegate("both go");
	await s.delegate("empty go");
	await s.delegate("none go");
	assert.deepEqual(s.errors, []);
	const [both, empty, none] = s.tmux.opened.map((opened) => opened.argv);
	assert.deepEqual(pair(both, "--tools"), ["--tools", "device_run,read"]);
	assert.deepEqual(pair(both, "--exclude-tools"), ["--exclude-tools", "edit"]);
	for (const argv of [empty, none]) {
		assert.ok(!argv.includes("--tools") && !argv.includes("-e"), argv.join(" "));
	}
});

test("a tools that is not a list leaves the agent out with a warning", async () => {
	writeAgent("bad", agentFile({ ...SCOUT, tools: "{ a: 1 }" }));
	const { agents, warnings } = readRoster(agentDir);
	assert.deepEqual(agents, []);
	assert.ok(warnings[0].includes("has tools"), warnings[0]);
});
