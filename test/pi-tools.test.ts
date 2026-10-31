// The tool selection a delegate gets, checked in a real Pi: each test builds a
// launch through the extension (the harness and fake tmux), then starts the
// project's own Pi with the tool arguments that launch passed (`--tools` or
// `--no-tools`, and each `-e`), plus a probe extension. The probe registers
// stand-in MCP tools (Pi treats a tool as MCP by its `mcp__` name, or as one
// of the MCP resource tools) and writes the tools Pi registered and activated
// once the session starts. A tool Pi did not register is unreachable: not
// declared, not callable from codemode, not loadable by tool_search.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

import { agentDir, agentFile, cleanup, resetRoot, root, rosterDir, session, writeAgent } from "./harness.ts";

beforeEach(() => resetRoot());
after(() => cleanup());

const SCOUT = { description: "Looks things up", model: "alpha/fast-model", thinking: "low" };

/** A tool definition with no parameters, as a probe registers it. */
const tool = (name: string, exposure: string) =>
	`pi.registerTool({ name: ${JSON.stringify(name)}, label: ${JSON.stringify(name)}, description: "probe", exposure: ${JSON.stringify(exposure)}, parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: undefined }) });`;

/** The probe: stand-in MCP tools and a plain one, and a report of what Pi kept. */
const PROBE = `import { writeFileSync } from "node:fs";

export default function (pi) {
	${tool("probe_tool", "direct")}
	${tool("mcp__fake__echo", "codemode")}
	${tool("mcp__fake__other", "deferred")}
	${tool("list_mcp_resources", "direct")}
	pi.on("session_start", () => {
		const report = { all: pi.getAllTools().map((t) => t.name).sort(), active: [...pi.getActiveTools()].sort() };
		writeFileSync(process.env.PROBE_OUT, JSON.stringify(report));
	});
}
`;

/** The arguments of a launch that choose tools: `--tools <list>` or `--no-tools`, and every `-e <path>`. */
function toolArgs(argv: readonly string[]): string[] {
	const args: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--tools" || argv[i] === "-e" || argv[i] === "--exclude-tools") args.push(argv[i], argv[i + 1]);
		if (argv[i] === "--no-tools") args.push(argv[i]);
	}
	return args;
}

/** Start the project's Pi with `args` and the probe, and return what the probe saw. */
async function inPi(args: readonly string[]): Promise<{ all: string[]; active: string[] }> {
	const dir = mkdtempSync(join(root, "pi-"));
	const home = join(dir, "home");
	mkdirSync(home);
	const probe = join(dir, "probe.ts");
	writeFileSync(probe, PROBE);
	const out = join(dir, "report.json");
	// A delegate's PI_* variables (and PI_CODING_AGENT_DIR) would change what Pi loads.
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PI_")));
	const pi = spawn("node_modules/.bin/pi", ["--no-session", "--mode", "rpc", "-ne", "-e", probe, ...args], {
		env: { ...env, HOME: home, PI_CODING_AGENT_DIR: home, PROBE_OUT: out },
		stdio: ["pipe", "ignore", "pipe"],
	});
	let stderr = "";
	pi.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	try {
		const deadline = Date.now() + 60_000;
		while (!existsSync(out)) {
			if (Date.now() > deadline || pi.exitCode !== null) throw new Error(`no probe report from Pi\n${stderr}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
		return JSON.parse(readFileSync(out, "utf8"));
	} finally {
		pi.kill("SIGKILL");
	}
}

/** Launch `agent` through the extension and return the tool arguments its child got. */
async function launchArgs(agent: string, activeTools: readonly string[]): Promise<string[]> {
	const s = session({ activeTools });
	await s.start();
	await s.delegate(`${agent} go`);
	assert.deepEqual(s.errors, []);
	return toolArgs(s.tmux.opened[0].argv);
}

const MCP = ["list_mcp_resources", "mcp__fake__echo", "mcp__fake__other"];

test("a tools list without MCP tools leaves every MCP tool unregistered in the child, deferred and codemode too", async () => {
	writeAgent("plain", agentFile({ ...SCOUT, tools: "read, probe_tool" }));
	const args = await launchArgs("plain", ["read", "delegate"]);
	const seen = await inPi(args);
	for (const name of MCP) assert.ok(!seen.all.includes(name), `${name} reached the child: ${seen.all.join(", ")}`);
	assert.ok(seen.all.includes("probe_tool") && seen.active.includes("probe_tool"), seen.all.join(", "));
});

test("a tools list naming one MCP tool gives the child that one only", async () => {
	writeAgent("one", agentFile({ ...SCOUT, tools: "read, mcp__fake__echo" }));
	const seen = await inPi(await launchArgs("one", ["read", "delegate"]));
	assert.deepEqual(
		seen.all.filter((name) => MCP.includes(name)),
		["mcp__fake__echo"],
	);
	assert.ok(!seen.all.includes("probe_tool"), seen.all.join(", "));
});

test("the parent's tools, with no tools field, reach the child exactly: MCP tools only when the parent had them", async () => {
	writeAgent("inherit", agentFile(SCOUT));
	const without = await inPi(await launchArgs("inherit", ["read", "bash", "delegate"]));
	assert.deepEqual(
		without.all.filter((name) => MCP.includes(name) || name === "probe_tool"),
		[],
	);
	const withOne = await inPi(await launchArgs("inherit", ["read", "mcp__fake__other", "delegate"]));
	assert.deepEqual(
		withOne.all.filter((name) => MCP.includes(name) || name === "probe_tool"),
		["mcp__fake__other"],
	);
});

test("ignored agent extensions never load in real Pi, even when tools or delegateTools name their tools", async () => {
	mkdirSync(rosterDir, { recursive: true });
	writeFileSync(
		join(rosterDir, "own.ts"),
		`export default function (pi) {\n\t${tool("own_tool", "direct")}\n\t${tool("own_shared", "codemode")}\n\t${tool("own_hidden", "codemode")}\n}\n`,
	);
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(join(agentDir, "squire", "settings.json"), JSON.stringify({ delegateTools: ["own_shared"] }));
	writeAgent("inherit", agentFile({ ...SCOUT, extensions: "./own.ts" }));
	writeAgent("less", agentFile({ ...SCOUT, extensions: "./own.ts", tools: "-bash" }));
	writeAgent("named", agentFile({ ...SCOUT, extensions: "./own.ts", tools: "read, own_tool" }));
	const own = (seen: { all: string[] }) => seen.all.filter((name) => name.startsWith("own_"));
	const inherit = await inPi(await launchArgs("inherit", ["read", "bash", "delegate"]));
	assert.deepEqual(own(inherit), []);
	const less = await inPi(await launchArgs("less", ["read", "bash", "delegate"]));
	assert.deepEqual(own(less), []);
	const named = await inPi(await launchArgs("named", ["read", "bash", "delegate"]));
	assert.deepEqual(own(named), []);
	assert.ok(!named.active.includes("own_tool") && named.all.includes("read"), named.all.join(", "));
});
