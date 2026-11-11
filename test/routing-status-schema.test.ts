import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { Value } from "typebox/value";
import { ROUTING_ATTEMPT, ROUTING_FALLBACK } from "../src/routing-provenance.ts";
import type { RoutingEvidence, RoutingRecord } from "../src/routing-types.ts";
import { agentDir, agentFile, cleanup, resetRoot, root, session, sessionDir, writeAgent } from "./harness.ts";
import { MODEL_A, MODEL_B, MODELS, policy } from "./routing-fixtures.ts";

const active: ReturnType<typeof session>[] = [];
beforeEach(() => {
	resetRoot();
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(join(agentDir, "squire", "routing.json"), JSON.stringify(policy()));
});
afterEach(async () => {
	for (const value of active.splice(0).reverse()) await value.shutdown();
});
after(cleanup);

type Started = { id: string; routing: RoutingRecord };
type Status = { delegations: { id: string; routingEvidence: RoutingEvidence }[] };
function effort(route: RoutingRecord, model: string) {
	const candidate = route.candidates.find((value) => value.model === model);
	assert.ok(candidate);
	return candidate;
}
function sourceFile(started: Started, models: string[], fallback = false): void {
	mkdirSync(sessionDir, { recursive: true });
	const rows: object[] = [
		{ type: "session", version: 3, id: started.id, cwd: root },
		{ type: "custom", id: "attempt", parentId: null, customType: ROUTING_ATTEMPT, data: started.routing },
	];
	let parentId = "attempt";
	for (const [index, model] of models.entries()) {
		const id = `answer-${index}`;
		rows.push({
			type: "message",
			id,
			parentId,
			message: {
				role: "assistant",
				provider: model.slice(0, model.indexOf("/")),
				model: model.slice(model.indexOf("/") + 1),
				thinkingLevel: effort(started.routing, model).effectiveThinking,
			},
		});
		parentId = id;
	}
	if (fallback)
		rows.push({
			type: "custom",
			id: "fallback",
			parentId,
			customType: ROUTING_FALLBACK,
			data: {
				from: MODEL_A,
				to: MODEL_B,
				reason: "unavailable",
				requestedThinking: effort(started.routing, MODEL_B).thinking,
				effectiveThinking: effort(started.routing, MODEL_B).effectiveThinking,
			},
		});
	writeFileSync(join(sessionDir, `status_${started.id}.jsonl`), rows.map((row) => JSON.stringify(row)).join("\n"));
}
function json(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}
async function start(profile = "worker") {
	writeAgent("role", agentFile({ routing_profile: profile }));
	const s = session({
		extraModels: MODELS,
		branch: [
			{
				type: "message",
				id: "author",
				parentId: null,
				message: { role: "assistant", provider: "alpha", model: "route-a" },
			},
		],
	});
	active.push(s);
	const launched = await s.toolCall("delegate", {
		agent: "role",
		task: "inspect",
		routing: {
			category: "standard",
			data: "private",
			...(profile === "reviewer" ? { review: { authors: ["self"] } } : {}),
		},
	});
	return { s, started: launched.structuredContent as Started };
}

test("routed delegation_status output advertises and validates complete served/fallback evidence", async () => {
	const { s, started } = await start();
	sourceFile(started, [MODEL_A, MODEL_B], true);
	const result = await s.toolCall("delegation_status", { id: started.id });
	const output = json(result.structuredContent) as Status;
	const schema = s.tool("delegation_status").outputSchema;
	assert.ok(schema);
	assert.equal(Value.Check(schema, output), true);
	assert.deepEqual(output.delegations[0].routingEvidence, {
		served: [
			// The registry clamps synthetic model effort; evidence reports the admitted effective level.
			{ model: MODEL_A, thinking: effort(started.routing, MODEL_A).effectiveThinking, entryId: "answer-0" },
			{ model: MODEL_B, thinking: effort(started.routing, MODEL_B).effectiveThinking, entryId: "answer-1" },
		],
		fallbacks: [
			{
				from: MODEL_A,
				to: MODEL_B,
				reason: "unavailable",
				requestedThinking: effort(started.routing, MODEL_B).thinking,
				effectiveThinking: effort(started.routing, MODEL_B).effectiveThinking,
			},
		],
		complete: true,
		independent: "not-required",
		reasons: [],
	});
	const withoutEffort = structuredClone(output);
	delete withoutEffort.delegations[0].routingEvidence.served[0].thinking;
	delete withoutEffort.delegations[0].routingEvidence.fallbacks[0].effectiveThinking;
	assert.equal(Value.Check(schema, withoutEffort), true, "observed effort fields are optional");
	for (const bad of [
		started.routing,
		{},
		{ ...output.delegations[0].routingEvidence, independent: "approved" },
		{ ...output.delegations[0].routingEvidence, complete: "true" },
		{ ...output.delegations[0].routingEvidence, served: [{ model: MODEL_A }] },
		{ ...output.delegations[0].routingEvidence, fallbacks: [{ from: MODEL_A, to: MODEL_B }] },
		{ ...output.delegations[0].routingEvidence, reasons: [42] },
	]) {
		const invalid = structuredClone(output);
		invalid.delegations[0].routingEvidence = bad as RoutingEvidence;
		assert.equal(Value.Check(schema, invalid), false, `accepted invalid routing evidence: ${JSON.stringify(bad)}`);
	}
});

test("malformed persisted fallback observations stay unverified and within the status schema", async () => {
	const { s, started } = await start("reviewer");
	const schema = s.tool("delegation_status").outputSchema;
	assert.ok(schema);
	for (const data of [
		{},
		"not an observation",
		{ from: MODEL_B, to: MODEL_B, reason: "unavailable", requestedThinking: 42 },
	]) {
		sourceFile(started, [MODEL_B]);
		appendFileSync(
			join(sessionDir, `status_${started.id}.jsonl`),
			`\n${JSON.stringify({
				type: "custom",
				id: "invalid-fallback",
				parentId: "answer-0",
				customType: ROUTING_FALLBACK,
				data,
			})}\n`,
		);
		const output = json((await s.toolCall("delegation_status", { id: started.id })).structuredContent) as Status;
		assert.equal(Value.Check(schema, output), true);
		assert.equal(output.delegations[0].routingEvidence.complete, false);
		assert.equal(output.delegations[0].routingEvidence.independent, "unverified");
		assert.deepEqual(output.delegations[0].routingEvidence.fallbacks, []);
		assert.match(output.delegations[0].routingEvidence.reasons.join("; "), /invalid fallback provenance/);
	}
});

test("status schema accepts incomplete/unverified and verified independent evidence from actual status calls", async () => {
	const { s, started } = await start("reviewer");
	const schema = s.tool("delegation_status").outputSchema;
	assert.ok(schema);
	const missing = json((await s.toolCall("delegation_status", { id: started.id })).structuredContent) as Status;
	assert.equal(missing.delegations[0].routingEvidence.complete, false);
	assert.equal(missing.delegations[0].routingEvidence.independent, "unverified");
	assert.equal(Value.Check(schema, missing), true);
	sourceFile(started, [MODEL_B]);
	const verified = json((await s.toolCall("delegation_status", { id: started.id })).structuredContent) as Status;
	assert.equal(verified.delegations[0].routingEvidence.independent, "verified");
	assert.equal(Value.Check(schema, verified), true);
});
