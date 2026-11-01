import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { readRoster } from "../src/agents.ts";
import { agentDir, agentFile, cleanup, resetRoot, root, session, writeAgent, writeProjectAgent } from "./harness.ts";

beforeEach(() => resetRoot());
after(() => cleanup());

test("grant matrix: absent, true, false, empty and duplicate exact lists", () => {
	for (const [name, value] of Object.entries({ all: "true", off: "false", empty: "[]", names: "[worker, worker]" }))
		writeAgent(name, agentFile({ allow_nested_delegation: value }));
	writeAgent("absent", agentFile({}));
	writeAgent("worker", agentFile({}));
	const roster = readRoster(agentDir);
	assert.deepEqual(roster.disabled, []);
	const grants = Object.fromEntries(roster.agents.map((agent) => [agent.name, agent.allowNested]));
	assert.deepEqual(grants, {
		absent: undefined,
		all: true,
		empty: [],
		names: ["worker"],
		off: undefined,
		worker: undefined,
	});
	assert.deepEqual(roster.warnings, []);
});

test("malformed grants disable the agent without silently granting all or coercing scalar strings", () => {
	const values = [
		"",
		"null",
		'"true"',
		'"false"',
		"all",
		"worker",
		"42",
		"{}",
		"[worker, 42]",
		'[""]',
		'["worker,other"]',
		'["worker*"]',
		'["../worker"]',
		"[true]",
		"[null]",
	];
	for (const [index, value] of values.entries())
		writeAgent(`bad${index}`, agentFile({ allow_nested_delegation: value }));
	const roster = readRoster(agentDir);
	assert.equal(roster.agents.length, 0);
	assert.equal(roster.disabled.length, values.length);
	for (const item of roster.disabled)
		assert.match(item.reason, /allow_nested_delegation.*true, false or a list of agent names/);
});

test("unknown/disabled child names warn after the final roster is built but known grants remain usable", async () => {
	writeAgent("coordinator", agentFile({ allow_nested_delegation: "[worker, missing, disabled]" }));
	writeAgent("worker", agentFile({}));
	writeAgent("disabled", agentFile({ enabled: "false" }));
	const roster = readRoster(agentDir);
	assert.deepEqual(roster.agents.find((agent) => agent.name === "coordinator")?.allowNested, [
		"worker",
		"missing",
		"disabled",
	]);
	assert.equal(roster.warnings.length, 2);
	assert.match(roster.warnings.join(" "), /coordinator.md.*missing/);
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(join(agentDir, "squire", "settings.json"), '{"maxDepth":2}');
	const parent = session({ parentEnv: "root", agentEnv: "coordinator" });
	try {
		await parent.delegate("worker go");
		assert.equal(parent.tmux.opened.length, 1);
		await parent.delegate("missing go");
		assert.equal(parent.tmux.opened.length, 1);
		assert.match(parent.errors.join(" "), /no agent named/);
	} finally {
		await parent.shutdown();
	}
});

test("permission heuristic warns for lists and true/all without interpreting two permission blocks as equal policy", () => {
	writeAgent("worker", agentFile({}));
	writeAgent("restricted", agentFile({ permission: "\n  bash: deny" }));
	writeAgent("list", agentFile({ permission: "{}", allow_nested_delegation: "[worker, restricted]" }));
	writeAgent("all", agentFile({ permission: "\n  write: ask", allow_nested_delegation: "true" }));
	writeAgent("unconfigured", agentFile({ allow_nested_delegation: "[worker, restricted]" }));
	const roster = readRoster(agentDir);
	const warnings = roster.warnings.join("\n");
	assert.match(warnings, /list.md grants nested agent "worker".*without a permission block/);
	assert.match(warnings, /all.md grants nested agent "worker".*without a permission block/);
	assert.match(warnings, /all.md grants nested agent "unconfigured"/);
	assert.doesNotMatch(warnings, /grants nested agent "restricted"/);
	assert.doesNotMatch(warnings, /unconfigured.md grants/);
	assert.match(warnings, /not proof of equal or lesser permission authority/);
	assert.equal(roster.disabled.length, 0, "heuristic does not deny the grant");
});

test("permission map presence is deliberately a heuristic, not key presence or a policy validator", () => {
	for (const [name, permission] of Object.entries({ nullish: "", array: "[]", scalar: "deny", empty: "{}" }))
		writeAgent(name, agentFile({ permission, allow_nested_delegation: "[worker]" }));
	writeAgent("worker", agentFile({}));
	const roster = readRoster(agentDir);
	assert.equal(roster.warnings.length, 1);
	assert.match(roster.warnings[0], /empty.md grants/);
});

test("trusted project shadows determine both grant targets and permission warnings, without freezing definitions", () => {
	writeAgent("coordinator", agentFile({ permission: "{}", allow_nested_delegation: "[worker]" }));
	writeAgent("worker", agentFile({ permission: "{}" }));
	writeProjectAgent(root, "worker", agentFile({}));
	const project = join(root, ".pi", "agents");
	assert.deepEqual(readRoster(agentDir).warnings, []);
	assert.match(readRoster(agentDir, project).warnings.join(" "), /worker.*without a permission block/);
	writeProjectAgent(root, "worker", agentFile({ permission: "{}" }));
	assert.deepEqual(readRoster(agentDir, project).warnings, []);
});

test("false/empty grants listing delegation tools warn and admission refuses tool/command bypass before effects", async () => {
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(join(agentDir, "squire", "settings.json"), '{"maxDepth":2}');
	writeAgent("worker", agentFile({}));
	for (const value of ["false", "[]"]) {
		writeAgent("coordinator", agentFile({ tools: "delegate, delegation_resume", allow_nested_delegation: value }));
		const parent = session({ parentEnv: "root", agentEnv: "coordinator" });
		try {
			await parent.delegate("worker go");
			await assert.rejects(parent.toolCall("delegate", { agent: "worker", task: "go" }), /permitted agents: none/);
			assert.match(parent.warnings.join(" "), /listing tools alone does not grant nesting/);
			assert.equal(parent.tmux.opened.length, 0);
			assert.equal(parent.sendCalls.length, 0);
		} finally {
			await parent.shutdown();
		}
	}
});
