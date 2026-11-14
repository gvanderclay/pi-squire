import assert from "node:assert/strict";
import { test } from "node:test";
import { agentFile, DELEGATION_TOOLS, session, writeAgent } from "./harness.ts";

// Every byte here reaches the model of each session that loads pi-squire: the
// description and parameters directly, the output schema through codemode's
// declarations. Raise the budget only for text a model needs.
// Scripts reading delegation_status need its usage field names, not an opaque object.
const BUDGET = 12_300;

test("the delegation tools' model-facing metadata stays within its budget", async (t) => {
	writeAgent("scout", agentFile({ description: "Looks things up" }));
	const s = session();
	await s.start();
	const sizes = Object.fromEntries(
		DELEGATION_TOOLS.map((name) => {
			const tool = s.tool(name) as { description: string; parameters: unknown; outputSchema?: unknown };
			return [
				name,
				tool.description.length + JSON.stringify(tool.parameters).length + JSON.stringify(tool.outputSchema).length,
			];
		}),
	);
	const total = Object.values(sizes).reduce((sum, size) => sum + size, 0);
	t.diagnostic(`delegation tool metadata: ${total} characters; ${JSON.stringify(sizes)}`);
	assert.ok(total <= BUDGET, `${total} characters over a budget of ${BUDGET}: ${JSON.stringify(sizes)}`);
});
