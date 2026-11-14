import assert from "node:assert/strict";
import { test } from "node:test";
import { agentFile, DELEGATION_TOOLS, session, writeAgent } from "./harness.ts";

// Every byte here reaches the model of each session that loads pi-squire: the
// description and parameters directly, the output schema through codemode's
// declarations. Raise a budget only for text a model needs.
// Scripts reading delegation_status need its usage field names, not an opaque object.
// delegation_resume names the deferred fork in one clause, so a model can find it.
const BUDGET = 12_400;
// `delegation_fork` is deferred: a parent that can find it (codemode or
// tool_search active) starts without it declared, so what such a parent pays in
// every request is the other four. Activating it later declares it.
const DECLARED_BUDGET = 10_300;
// The routing request is one schema embedded in `delegate`, `delegation_resume`
// and `delegation_fork`, so a routed roster pays for it in three tools at once.
const ROUTED_BUDGET = 12_900;
// The loadout Pi gives a parent that can find a deferred tool: `delegation_fork` starts inactive.
const DECLARED = ["delegate", "delegation_status", "delegation_close", "delegation_resume"];

function sizes(s: ReturnType<typeof session>, names: readonly string[]): Record<string, number> {
	return Object.fromEntries(
		names.map((name) => {
			const tool = s.tool(name);
			return [
				name,
				tool.description.length + JSON.stringify(tool.parameters).length + JSON.stringify(tool.outputSchema).length,
			];
		}),
	);
}

function total(sizes: Record<string, number>): number {
	return Object.values(sizes).reduce((sum, size) => sum + size, 0);
}

test("the delegation tools' model-facing metadata stays within its budget", async (t) => {
	writeAgent("scout", agentFile({ description: "Looks things up" }));
	const s = session();
	await s.start();
	const measured = sizes(s, DELEGATION_TOOLS);
	t.diagnostic(`delegation tool metadata: ${total(measured)} characters; ${JSON.stringify(measured)}`);
	assert.ok(
		total(measured) <= BUDGET,
		`${total(measured)} characters over a budget of ${BUDGET}: ${JSON.stringify(measured)}`,
	);
});

test("the tools a parent with codemode starts with declared stay within their budget", async (t) => {
	writeAgent("scout", agentFile({ description: "Looks things up" }));
	const s = session({ activeTools: ["read", "bash", "codemode", ...DECLARED] });
	await s.start();
	// Measure what is active, not what is registered deferred: an active deferred tool is declared.
	const active = s.pi.getActiveTools();
	const declared = DELEGATION_TOOLS.filter((name) => active.includes(name));
	assert.deepEqual(declared, DECLARED);
	const measured = sizes(s, declared);
	t.diagnostic(`declared tool metadata: ${total(measured)} characters; ${JSON.stringify(measured)}`);
	assert.ok(
		total(measured) <= DECLARED_BUDGET,
		`${total(measured)} characters over a budget of ${DECLARED_BUDGET}: ${JSON.stringify(measured)}`,
	);
});

test("a routed roster's declared tools stay within their budget", async (t) => {
	// The same agent as above, now routed: the roster line gains the routing profile.
	writeAgent("scout", agentFile({ description: "Looks things up", routing_profile: "worker" }));
	const s = session({ activeTools: ["read", "bash", "codemode", ...DECLARED] });
	await s.start();
	const active = s.pi.getActiveTools();
	const declared = DELEGATION_TOOLS.filter((name) => active.includes(name));
	assert.deepEqual(declared, DECLARED);
	const measured = sizes(s, declared);
	t.diagnostic(`routed declared tool metadata: ${total(measured)} characters; ${JSON.stringify(measured)}`);
	assert.ok(
		total(measured) <= ROUTED_BUDGET,
		`${total(measured)} characters over a budget of ${ROUTED_BUDGET}: ${JSON.stringify(measured)}`,
	);
});
