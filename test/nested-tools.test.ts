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
import { availableTools, enforceToolCeiling } from "../src/tool-ceiling.ts";
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

test("explicit lists and delegateTools resolve to exact parent names with removed-tool notices", async () => {
	writeAgent(
		"worker",
		agentFile({ tools: "probe_driver, plain, child_only, hidden_tool, inactive", model: "alpha/fast-model" }),
	);
	writeFileSync(
		join(agentDir, "squire", "settings.json"),
		JSON.stringify({
			maxDepth: 3,
			delegateTools: ["script_tool", "mcp__fake__*", "late_only"],
		}),
	);
	const { parent } = await coordinator();
	const result = await parent.toolCall("delegate", { agent: "worker", task: "probe" });
	const names = selected(parent.tmux.opened[0].argv);
	assert.ok(names.includes("script_tool") && names.includes("mcp__fake__echo"));
	assert.ok(!names.some((name) => name.includes("*")));
	const notices = (result.structuredContent as { notices: string[] }).notices.join(" ");
	for (const name of ["child_only", "hidden_tool", "inactive", "late_only"]) assert.ok(notices.includes(name), notices);
	const seen = await (await runtime(parent.tmux.opened[0].argv)).probe();
	assert.equal(seen.outcomes.child_only, false);
	assert.equal(seen.outcomes.late_only, false);
	assert.equal(seen.outcomes.script_tool, true);
});

test("automatic nesting grants are individually capped even with an explicit tools list", async () => {
	writeAgent(
		"worker",
		agentFile({ tools: "probe_driver", allow_nested_delegation: "[worker]", model: "alpha/fast-model" }),
	);
	const { parent } = await coordinator();
	// The real extension cannot activate missing CLI registrations; model that
	// state after lifecycle exposure for this intentionally limited parent.
	parent.pi.setActiveTools(["probe_driver", "delegate"]);
	const result = await parent.toolCall("delegate", { agent: "worker", task: "probe" });
	const names = selected(parent.tmux.opened[0].argv);
	assert.ok(names.includes("delegate"));
	for (const name of ["delegation_close", "delegation_status", "delegation_resume"]) assert.ok(!names.includes(name));
	assert.match((result.structuredContent as { notices: string[] }).notices.join(" "), /delegation_resume/);
});

test("post-hook plain/wildcard requests, aliases, exclusions and extensions cannot widen the final registration ceiling on launch/resume", async () => {
	const { parent } = await coordinator();
	parent.events.on("session:launch", (data) => {
		const payload = data as { args: string[]; env: Record<string, string> };
		payload.args.push("-e", "/isolated/custom.ts", "-t", "*", "-xt", "plain", "--verbose");
		payload.env.ISOLATED_MARK = "yes";
	});
	const launched = await parent.toolCall("delegate", { agent: "worker", task: "probe" });
	assert.equal(parent.tmux.opened[0].env.ISOLATED_MARK, "yes");
	assert.ok(parent.tmux.opened[0].argv.includes("/isolated/custom.ts"));
	const first = await (await runtime(parent.tmux.opened[0].argv)).probe();
	assert.equal(first.outcomes.plain, false);
	assert.equal(first.outcomes.child_only, false);
	assert.equal(first.outcomes.late_only, false);
	assert.equal(first.outcomes.deferred_tool, true);
	const id = (launched.structuredContent as { id: string }).id;
	sessionFile(id);
	parent.tmux.windows.clear();
	// Current parent availability and child definition, not the launch-time set.
	parent.pi.setActiveTools(["probe_driver", "delegate", "delegation_resume"]);
	writeAgent("worker", agentFile({ tools: "probe_driver, plain, child_only", model: "alpha/fast-model" }));
	const resumed = await parent.toolCall("delegation_resume", { id, task: "again" });
	const second = await (await runtime(parent.tmux.opened[1].argv)).probe();
	assert.equal(second.outcomes.plain, false);
	assert.equal(second.outcomes.child_only, false);
	assert.equal(second.outcomes.deferred_tool, true);
	assert.match((resumed.structuredContent as { notices: string[] }).notices.join(" "), /Nested tool ceiling/);
});

test("nested command resume resolves current child tools and additions and reports removed names", async () => {
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
	for (const name of ["plain", "child_only", "late_only"]) assert.equal(seen.outcomes[name], false, name);
	for (const name of ["script_tool", "deferred_tool"]) assert.equal(seen.outcomes[name], true, name);
	assert.match(parent.notes.join(" "), /child_only, late_only/);
});

test("empty nested selections cannot be resurrected by a previous --tools and a hook; command notices include removed tools", async () => {
	writeAgent("worker", agentFile({ tools: "[]", model: "alpha/fast-model" }));
	const { parent } = await coordinator();
	parent.events.on("session:launch", (data) => {
		(data as { args: string[] }).args.push("--tools", "child_only");
	});
	await parent.delegate("worker probe");
	const names = selected(parent.tmux.opened[0].argv);
	assert.deepEqual(names, []);
	assert.ok(parent.tmux.opened[0].argv.includes("--no-tools"));
	assert.match(parent.notes.join(" "), /child_only/);
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

test("a -- token used as an option value cannot swallow the final ceiling", () => {
	const args = ["--tools", "*", "--system-prompt", "--"];
	enforceToolCeiling({ args, available: ["read"], cwd: root, agentDir, trusted: false, notices: [] });
	assert.deepEqual(selected(args), ["read", "mcp__"]);
	assert.equal(parseArgs(args).systemPrompt, "--");
});

test("finalizer handles modifier customization using trusted Pi defaults, and inserts the ceiling before --", () => {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["probe_driver", "plain"] }));
	const args = ["--tools", "read", "-t", "+child_only,-plain", "--", "task"];
	const notices: string[] = [];
	enforceToolCeiling({ args, available: ["probe_driver", "plain"], cwd: root, agentDir, trusted: false, notices });
	assert.deepEqual(selected(args), ["probe_driver", "mcp__"]);
	assert.match(notices.join(" "), /child_only/);
});
