// The `session:launch` contract, run from the worked example in
// `../README.md`. The example is the documentation: every
// `` ```js <name> `` fence is extracted and executed verbatim on a real
// `createEventBus`, so a field renamed in the README without a matching
// change in the code fails here. The name after the fence's `js` marker
// selects the test below that runs it, and `test("...")` at the end fails
// when a fence has no runner.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { agentFile, cleanup, resetAgents, session, writeAgent } from "./harness.ts";

beforeEach(() => resetAgents());
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
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
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
	assert.equal(opened.env.PI_DELEGATE_PARENT, s.parent, "the emitter's own env stays");
});

test("every runnable example in the README has a runner above", () => {
	assert.deepEqual([...examples.keys()].sort(), ["session:launch"]);
});
