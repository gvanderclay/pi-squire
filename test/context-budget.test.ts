import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { agentDir, agentFile, DELEGATION_TOOLS, session, writeAgent } from "./harness.ts";

// Every byte here reaches the model of each session that loads pi-squire: the
// description and parameters directly, the output schema through codemode's
// declarations. Raise a budget only for text a model needs.
// Scripts reading delegation_status need its usage field names, not an opaque object,
// and its selection counts, so a partial list is not mistaken for every record.
// delegation_resume names the deferred fork in one clause, so a model can find it.
// Cleanup adds 1,563 measured characters: T3 adds 46 for the command override pointer.
// T6 adds 140 measured schema characters for independently readable Git/Paseo observations;
// scripts must not mistake already-clean Git for a verified Paseo workspace.
// Discoverable parents still defer cleanup, so their declaration caps do not grow.
// T11 adds 57 characters of accurate fresh-launch/resource/fork guidance; no other text is cut.
// Partial-open attempts pass host-owned recovery facts through and type the assigned session id.
// The explicit open attempt schema costs 58 characters, not opaque per-field declarations.
const PASEO_PROGRESS_METADATA = 58;
const CLEANUP_RESOURCE_METADATA = 140;
const BUDGET = 14_441 + CLEANUP_RESOURCE_METADATA + PASEO_PROGRESS_METADATA;
// Status, cleanup and fork are deferred: a parent with codemode calls any of
// them from a script by name, so it starts with only the three that stay direct
// declared. Activating a deferred one declares it.
const DECLARED_BUDGET = 5_820;
// The routing request is one schema embedded in `delegate`, `delegation_resume`
// and `delegation_fork`. This case measures the three tools declared at the
// start, so it counts two copies; a declared fork adds the third.
const ROUTED_BUDGET = 8_600;
// A coordinator under codemode declares the same three, plus its roster line in `delegate`.
const COORDINATOR_BUDGET = 5_850;
// The loadout Pi gives a parent with codemode: the deferred tools start inactive.
const DECLARED = ["delegate", "delegation_close", "delegation_resume"];

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

test("a coordinator under codemode declares only its always-active delegation tools", async (t) => {
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(join(agentDir, "squire", "settings.json"), JSON.stringify({ maxDepth: 2 }));
	writeAgent("scout", agentFile({ description: "Looks things up" }));
	writeAgent("coordinator", agentFile({ allow_nested_delegation: "true" }));
	const parent = session();
	await parent.start();
	const launched = await parent.toolCall("delegate", { agent: "coordinator", task: "coordinate" });
	const id = (launched.structuredContent as { id: string }).id;
	const child = session({ parent: id, activeTools: ["read", "bash", "codemode"] });
	await child.start();
	const declared = DELEGATION_TOOLS.filter((name) => child.pi.getActiveTools().includes(name));
	assert.deepEqual(declared, DECLARED);
	const measured = sizes(child, declared);
	t.diagnostic(`coordinator declared metadata: ${total(measured)} characters; ${JSON.stringify(measured)}`);
	assert.ok(total(measured) <= COORDINATOR_BUDGET, JSON.stringify(measured));
	await child.shutdown();
	await parent.shutdown();
});
