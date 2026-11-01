// Real Pi registration/execution, driven by squire launch/resume argv. No
// model requests, real tmux server, or production agent resources are used.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	parseArgs,
	SessionManager,
	SettingsManager,
	type ToolExposure,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { availableTools } from "../src/tool-names.ts";
import { agentDir, agentFile, cleanup, resetRoot, root, session, sessionDir, writeAgent } from "./harness.ts";

const exposures: Record<string, ToolExposure> = {
	probe_driver: "direct",
	plain: "direct",
	inactive: "direct",
	orchestrator: "model-only",
	script_tool: "codemode",
	deferred_tool: "deferred",
	hidden_tool: "hidden",
	mcp__fake__echo: "deferred",
	list_mcp_resources: "codemode",
	child_only: "codemode",
	late_only: "deferred",
	delegate: "direct",
	delegation_status: "direct",
	delegation_close: "direct",
	delegation_resume: "direct",
};
const runtimes: Awaited<ReturnType<typeof runtime>>[] = [];
const fakeSessions: ReturnType<typeof session>[] = [];
beforeEach(() => {
	resetRoot();
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(join(agentDir, "squire", "settings.json"), JSON.stringify({ maxDepth: 3 }));
	writeAgent("coordinator", agentFile({ allow_nested_delegation: "[worker]", model: "alpha/fast-model" }));
	writeAgent("worker", agentFile({ model: "alpha/fast-model" }));
});
afterEach(async () => {
	for (const item of runtimes.splice(0)) item.session.dispose();
	for (const item of fakeSessions.splice(0)) await item.shutdown();
});
after(() => cleanup());

type Calls = { callable: string[]; outcomes: Record<string, boolean> };
async function runtime(args: readonly string[] = []): Promise<{
	session: Awaited<ReturnType<typeof createAgentSession>>["session"];
	api: ExtensionAPI;
	probe(): Promise<Calls>;
}> {
	let api!: ExtensionAPI;
	const settingsManager = SettingsManager.inMemory();
	const loader = new DefaultResourceLoader({
		cwd: root,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [
			(pi) => {
				api = pi;
				for (const [name, exposure] of Object.entries(exposures)) {
					if (name === "late_only") continue;
					pi.registerTool({
						name,
						exposure,
						label: name,
						description: "isolated probe",
						parameters: Type.Object({}),
						prepareLoadout: name === "probe_driver" ? () => ({ hiddenDeclarations: ["plain"] }) : undefined,
						async execute(_id, _params, _signal, _update, ctx) {
							if (name !== "probe_driver") return { content: [{ type: "text", text: name }], details: undefined };
							const outcomes: Record<string, boolean> = {};
							for (const target of Object.keys(exposures).filter((value) => value !== "probe_driver"))
								outcomes[target] = !(await ctx.executeTool(target, {})).isError;
							return { content: [], details: { callable: ctx.tools.map((tool) => tool.name), outcomes } };
						},
					});
				}
				pi.on("session_start", () => {
					pi.registerTool({
						name: "late_only",
						exposure: "deferred",
						label: "late",
						description: "late probe",
						parameters: Type.Object({}),
						async execute() {
							return { content: [], details: undefined };
						},
					});
				});
			},
		],
	});
	await loader.reload();
	const parsed = parseArgs([...args]);
	const manager = SessionManager.inMemory(root);
	manager.appendMessage({
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "isolated",
		content: [{ type: "toolCall", id: "isolated-probe", name: "probe_driver", arguments: {} }],
		stopReason: "toolUse",
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	const { session: real } = await createAgentSession({
		cwd: root,
		agentDir,
		settingsManager,
		resourceLoader: loader,
		sessionManager: manager,
		tools: parsed.tools,
		excludeTools: parsed.excludeTools,
		noTools: parsed.noTools ? "all" : parsed.noBuiltinTools ? "builtin" : undefined,
	});
	await real.bindExtensions({});
	const result = {
		session: real,
		api,
		async probe(): Promise<Calls> {
			const driver = real.agent.state.tools.find((tool) => tool.name === "probe_driver");
			assert.ok(driver, "probe driver is declared");
			return (await driver.execute("isolated-probe", {}, new AbortController().signal)).details as Calls;
		},
	};
	runtimes.push(result);
	return result;
}

async function coordinator(active = ["probe_driver", "plain", "orchestrator", "delegate", "delegation_resume"]) {
	const real = await runtime();
	real.api.setActiveTools(active);
	// The parent does not have these child-only registrations at all.
	const registered = real.api.getAllTools().filter((tool) => !["child_only", "late_only"].includes(tool.name));
	const parent = session({
		parentEnv: "isolated-root",
		agentEnv: "coordinator",
		activeTools: active,
		registeredTools: registered.map((tool) => tool.name),
		toolExposures: exposures,
	});
	fakeSessions.push(parent);
	await parent.start();
	return { parent, real };
}
function selected(argv: readonly string[]): string[] {
	return parseArgs([...argv]).tools ?? [];
}
function sessionFile(id: string): void {
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(
		join(sessionDir, `probe_${id}.jsonl`),
		`${JSON.stringify({
			type: "session",
			version: 3,
			id,
			timestamp: "",
			cwd: root,
		})}\n`,
	);
}

test("parent availability matches real indirect execution plus active model-only, not displayed or registered names", async () => {
	const real = await runtime();
	real.api.setActiveTools(["probe_driver", "plain", "orchestrator"]);
	const seen = await real.probe();
	const available = availableTools(real.api);
	for (const name of ["plain", "script_tool", "deferred_tool", "mcp__fake__echo", "list_mcp_resources", "late_only"])
		assert.equal(seen.outcomes[name], true, name);
	assert.equal(seen.outcomes.orchestrator, false, "model-only cannot be called indirectly");
	assert.ok(available.includes("orchestrator"), "but the model can call its declaration");
	const orchestrator = real.session.agent.state.tools.find((tool) => tool.name === "orchestrator");
	assert.ok(orchestrator);
	assert.deepEqual((await orchestrator.execute("direct-probe", {}, new AbortController().signal)).content, [
		{ type: "text", text: "orchestrator" },
	]);
	assert.ok(
		available.includes("plain"),
		"hiddenDeclarations (codemode-only presentation) does not remove availability",
	);
	for (const name of ["inactive", "hidden_tool"]) {
		assert.equal(seen.outcomes[name], false, name);
		assert.ok(!available.includes(name), name);
	}
	assert.deepEqual(new Set(available), new Set([...seen.callable, "orchestrator"]));
	assert.ok(!real.api.getActiveTools().includes("deferred_tool"));
});

test("nested inherited tools retain codemode/deferred and model-only operations; real child calls stay bounded", async () => {
	const { parent } = await coordinator();
	await parent.toolCall("delegate", { agent: "worker", task: "isolated probe" });
	const opened = parent.tmux.opened[0];
	const child = await runtime(opened.argv);
	const seen = await child.probe();
	for (const name of ["plain", "script_tool", "deferred_tool", "mcp__fake__echo", "list_mcp_resources"])
		assert.equal(seen.outcomes[name], true, name);
	for (const name of ["inactive", "hidden_tool", "child_only", "late_only", "delegate"])
		assert.equal(seen.outcomes[name], false, name);
	assert.ok(child.api.getActiveTools().includes("orchestrator"));
	child.api.setActiveTools(child.api.getActiveTools().filter((name) => name !== "deferred_tool"));
	assert.equal((await child.probe()).outcomes.deferred_tool, true, "deactivation does not withdraw indirect reach");
});

test("a nested child's explicit tools and delegateTools pass as given, even names its parent cannot reach", async () => {
	writeAgent("worker", agentFile({ tools: "probe_driver, plain, child_only, inactive", model: "alpha/fast-model" }));
	writeFileSync(
		join(agentDir, "squire", "settings.json"),
		JSON.stringify({
			maxDepth: 3,
			delegateTools: ["script_tool", "mcp__fake__*", "late_only"],
		}),
	);
	const { parent } = await coordinator();
	const result = await parent.toolCall("delegate", { agent: "worker", task: "probe" });
	assert.deepEqual(selected(parent.tmux.opened[0].argv), [
		"probe_driver",
		"plain",
		"child_only",
		"inactive",
		"script_tool",
		"mcp__fake__*",
		"late_only",
	]);
	assert.deepEqual((result.structuredContent as { notices: string[] }).notices, []);
	const seen = await (await runtime(parent.tmux.opened[0].argv)).probe();
	for (const name of ["child_only", "inactive", "late_only", "script_tool", "mcp__fake__echo"])
		assert.equal(seen.outcomes[name], true, name);
	assert.equal(seen.outcomes.deferred_tool, false, "a tool the list leaves out stays out");
});

test("a granted nested child gets every delegation tool, whatever its parent has", async () => {
	writeAgent(
		"worker",
		agentFile({ tools: "probe_driver", allow_nested_delegation: "[worker]", model: "alpha/fast-model" }),
	);
	const { parent } = await coordinator();
	parent.pi.setActiveTools(["probe_driver", "delegate"]);
	await parent.toolCall("delegate", { agent: "worker", task: "probe" });
	const names = selected(parent.tmux.opened[0].argv);
	for (const name of ["delegate", "delegation_close", "delegation_status", "delegation_resume"])
		assert.ok(names.includes(name), name);
});

test("session:launch additions reach a nested child unchanged on launch and resume", async () => {
	const { parent } = await coordinator();
	parent.events.on("session:launch", (data) => {
		const payload = data as { args: string[]; env: Record<string, string> };
		payload.args.push("-e", "/isolated/custom.ts", "-t", "*", "-xt", "plain", "--verbose");
		payload.env.ISOLATED_MARK = "yes";
	});
	const launched = await parent.toolCall("delegate", { agent: "worker", task: "probe" });
	const opened = parent.tmux.opened[0];
	assert.equal(opened.env.ISOLATED_MARK, "yes");
	const added = opened.argv.lastIndexOf("-e");
	assert.deepEqual(opened.argv.slice(added, added + 7), [
		"-e",
		"/isolated/custom.ts",
		"-t",
		"*",
		"-xt",
		"plain",
		"--verbose",
	]);
	const first = await (await runtime(opened.argv)).probe();
	assert.equal(first.outcomes.plain, false);
	assert.equal(first.outcomes.child_only, true);
	const id = (launched.structuredContent as { id: string }).id;
	sessionFile(id);
	parent.tmux.windows.clear();
	writeAgent("worker", agentFile({ tools: "probe_driver, child_only", model: "alpha/fast-model" }));
	const resumed = await parent.toolCall("delegation_resume", { id, task: "again" });
	assert.ok(parent.tmux.opened[1].argv.includes("/isolated/custom.ts"));
	assert.deepEqual((resumed.structuredContent as { notices: string[] }).notices, []);
});

test("nested command resume uses the child's current tools and delegateTools", async () => {
	const { parent } = await coordinator();
	writeAgent("worker", agentFile({ tools: "probe_driver, plain", model: "alpha/fast-model" }));
	const result = await parent.toolCall("delegate", { agent: "worker", task: "probe" });
	const id = (result.structuredContent as { id: string }).id;
	sessionFile(id);
	parent.tmux.windows.clear();
	parent.pi.setActiveTools(["probe_driver", "delegate", "delegation_resume"]);
	writeAgent("worker", agentFile({ tools: "probe_driver, deferred_tool, child_only", model: "alpha/fast-model" }));
	writeFileSync(
		join(agentDir, "squire", "settings.json"),
		JSON.stringify({
			maxDepth: 3,
			delegateTools: ["script_tool", "late_only"],
		}),
	);
	await parent.command("delegate-resume", `${id} again`);
	assert.deepEqual(parent.errors, []);
	const seen = await (await runtime(parent.tmux.opened[1].argv)).probe();
	assert.equal(seen.outcomes.plain, false);
	for (const name of ["script_tool", "deferred_tool", "child_only", "late_only"])
		assert.equal(seen.outcomes[name], true, name);
});

test("an empty nested selection launches with --no-tools", async () => {
	writeAgent("worker", agentFile({ tools: "[]", model: "alpha/fast-model" }));
	const { parent } = await coordinator();
	await parent.delegate("worker probe");
	assert.deepEqual(selected(parent.tmux.opened[0].argv), []);
	assert.ok(parent.tmux.opened[0].argv.includes("--no-tools"));
	const child = await runtime(parent.tmux.opened[0].argv);
	assert.deepEqual(child.api.getAllTools(), []);
});

test("no-MCP selection keeps the sentinel and tools inherited with exclusions stay excluded before additions", async () => {
	writeAgent(
		"worker",
		agentFile({ tools: "-mcp__*, -list_mcp_resources, -script_tool, -deferred_tool", model: "alpha/fast-model" }),
	);
	const { parent } = await coordinator();
	await parent.delegate("worker probe");
	const argv = parent.tmux.opened[0].argv;
	assert.ok(selected(argv).includes("mcp__"));
	const seen = await (await runtime(argv)).probe();
	assert.equal(seen.outcomes.mcp__fake__echo, false);
	assert.equal(seen.outcomes.list_mcp_resources, false);
	assert.equal(seen.outcomes.script_tool, false);
});
