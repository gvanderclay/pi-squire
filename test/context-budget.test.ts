import assert from "node:assert/strict";
import { test } from "node:test";
import { agentFile, DELEGATION_TOOLS, session, writeAgent } from "./harness.ts";

// Every byte here reaches the model of each session that loads pi-squire: the
// description and parameters directly, the output schema through codemode's
// declarations. Raise a budget only for text a model needs.
// Scripts reading delegation_status need its usage field names, not an opaque object.
// delegation_resume names the deferred fork in one clause, so a model can find it.
const BUDGET = 12_400;
// `delegation_fork` is deferred: no request declares it and codemode does not
// list it, so what every request pays is the other four.
const DECLARED_BUDGET = 10_300;

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

test("the tools every request declares stay within their budget", async (t) => {
	writeAgent("scout", agentFile({ description: "Looks things up" }));
	const s = session();
	await s.start();
	const declared = DELEGATION_TOOLS.filter((name) => s.tool(name).exposure !== "deferred");
	assert.deepEqual(declared, ["delegate", "delegation_status", "delegation_close", "delegation_resume"]);
	const measured = sizes(s, declared);
	t.diagnostic(`declared tool metadata: ${total(measured)} characters; ${JSON.stringify(measured)}`);
	assert.ok(
		total(measured) <= DECLARED_BUDGET,
		`${total(measured)} characters over a budget of ${DECLARED_BUDGET}: ${JSON.stringify(measured)}`,
	);
});
