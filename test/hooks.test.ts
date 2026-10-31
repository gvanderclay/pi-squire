// The `session:launch` contract, run from the worked example in
// `../README.md`. The example is the documentation: every
// `` ```js <name> `` fence is extracted and executed verbatim on a real
// `createEventBus`, so a field renamed in the README without a matching
// change in the code fails here. The name after the fence's `js` marker
// selects the test below that runs it, and `test("...")` at the end fails
// when a fence has no runner.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

import { agentDir, agentFile, cleanup, resetRoot, root, session, writeAgent } from "./harness.ts";

beforeEach(() => resetRoot());
after(() => cleanup());

/** Every `` ```js <name> `` block in the README, by name. */
function readmeExamples(): Map<string, string> {
	const text = readFileSync(new URL("../README.md", import.meta.url), "utf8");
	const fence = /^```js(?:[ \t]+(\S+))?[ \t]*\n([\s\S]*?)^```[ \t]*$/gm;
	const out = new Map<string, string>();
	for (const [, name, code] of text.matchAll(fence)) {
		assert.ok(name, "every runnable example fence names the test that runs it: ```js <name>");
		assert.ok(!out.has(name), `README.md has two examples named ${name}`);
		out.set(name, code);
	}
	return out;
}

const examples = readmeExamples();
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
	...args: string[]
) => (...args: unknown[]) => Promise<void>;

/** Run one README example with the names its prose promises: `pi`, `assert`. */
async function runExample(name: string, scope: { pi: unknown }) {
	const code = examples.get(name);
	assert.ok(code, `README.md has a \`\`\`js ${name} example`);
	await new AsyncFunction("pi", "assert", code)(scope.pi, assert);
}

test("the README's session:launch example adds its flag and env key to the launched child", async () => {
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
	const s = session();
	await runExample("session:launch", { pi: s.pi });
	await s.delegate("scout do the thing");
	const opened = s.tmux.opened[0];
	assert.equal(opened.argv.at(-1), "--auto");
	assert.equal(opened.argv[opened.argv.indexOf("--thinking") + 1], "low", "the emitter's own args stay");
	assert.equal(opened.env.GATE_MODE, "auto");
	assert.equal(opened.env.GATE_ROOT, opened.cwd, "the example reads the cwd the window opens in");
	assert.equal(opened.env.GATE_CHAIN, "scout");
	assert.equal(opened.env.GATE_PARENT, s.parent);
	assert.equal(opened.env.PI_DELEGATE_PARENT, s.parent, "the emitter's own env stays");
});

test("the executable launch example preserves unrelated flags/env under the nested final ceiling", async () => {
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(join(agentDir, "squire", "settings.json"), '{"maxDepth":2}');
	writeAgent("coordinator", agentFile({ allow_nested_delegation: "[scout]" }));
	writeAgent("scout", agentFile({ model: "alpha/fast-model" }));
	const s = session({ parentEnv: "root", agentEnv: "coordinator", activeTools: ["read", "delegate"] });
	try {
		await runExample("session:launch", { pi: s.pi });
		await s.delegate("scout go");
		const opened = s.tmux.opened[0];
		assert.ok(opened.argv.includes("--auto"));
		assert.equal(opened.env.GATE_MODE, "auto");
		assert.equal(opened.env.GATE_PARENT, s.parent);
		assert.deepEqual(opened.argv.slice(-2), ["--tools", "read,mcp__"]);
	} finally {
		await s.shutdown();
	}
});

test("session:launch can still add an extension after agent-specific loading was removed", async () => {
	writeAgent("scout", agentFile({ model: "alpha/fast-model", extensions: "./ignored.ts" }));
	const s = session();
	s.events.on("session:launch", (payload) => {
		const launch = payload as { args: string[]; env: Record<string, string> };
		assert.ok(!launch.args.includes("-e"), "no frontmatter extension arguments");
		launch.args.push("-e", "/custom/launch.ts");
		launch.env.CUSTOM_LAUNCH = "new";
	});
	await s.delegate("scout go");
	assert.deepEqual(s.tmux.opened[0].argv.slice(-2), ["-e", "/custom/launch.ts"]);
	assert.equal(s.tmux.opened[0].env.CUSTOM_LAUNCH, "new");
	assert.deepEqual(s.warnings, []);
});

test("the payload a session:launch listener sees names the agent", async () => {
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
	const s = session();
	let seen: { agent?: unknown } | undefined;
	s.events.on("session:launch", (payload) => {
		seen = payload as { agent?: unknown };
	});
	await s.delegate("scout do the thing");
	assert.equal(seen?.agent, "scout");
});

test("the session:launch payload carries the delegate tool call's ID", async () => {
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
	const s = session();
	let seen: { toolCallId?: unknown } | undefined;
	s.events.on("session:launch", (payload) => {
		seen = payload as { toolCallId?: unknown };
	});
	await s.toolCall("delegate", { agent: "scout", task: "do the thing" });
	assert.equal(seen?.toolCallId, "call-1");
});

test("a launch from the /delegate command carries no tool call ID", async () => {
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
	const s = session();
	let seen: { toolCallId?: unknown } | undefined;
	s.events.on("session:launch", (payload) => {
		seen = payload as { toolCallId?: unknown };
	});
	await s.delegate("scout do the thing");
	assert.ok(seen, "the command launched a window");
	assert.equal(seen.toolCallId, undefined);
});

test("launch hook cwd cannot redirect and append add contract survives", async () => {
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
	const parentCwd = join(root, "parent-checkout");
	mkdirSync(parentCwd, { recursive: true });
	const s = session({ cwd: parentCwd });
	let seenCwd: unknown;
	s.events.on("session:launch", (data) => {
		const payload = data as { cwd: unknown; args: string[]; env: Record<string, string> };
		seenCwd = payload.cwd;
		payload.cwd = tmpdir();
		payload.args.push("--verbose");
		payload.env.CONTRIBUTOR_MARKER = "yes";
	});
	await s.delegate("scout do the thing");
	assert.equal(seenCwd, parentCwd);
	assert.equal(s.tmux.opened[0].cwd, parentCwd);
	assert.ok(s.tmux.opened[0].argv.includes("--verbose"));
	assert.equal(s.tmux.opened[0].env.CONTRIBUTOR_MARKER, "yes");
	assert.equal(s.entries[0].data.cwd, parentCwd);
});

test("while a delegation runs, each tick emits message:scan with a payload the provider marks scanned", async (t) => {
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
	t.mock.timers.enable({ apis: ["setInterval"] });
	const s = session();
	await s.start();
	const payloads: { scanned?: boolean }[] = [];
	s.events.on("message:scan", (payload) => void payloads.push(payload as never));
	await s.delegate("scout do the thing");
	t.mock.timers.tick(5000);
	assert.equal(payloads.length, 1);
	assert.equal(payloads[0].scanned, true, "the provider's listener marked it before emit returned");
	await s.shutdown();
});

test("every runnable example in the README has a runner above", () => {
	assert.deepEqual([...examples.keys()].sort(), ["session:launch"]);
});
