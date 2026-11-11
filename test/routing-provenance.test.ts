import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { StartedRecorded } from "../src/results.ts";
import { authorProof, ROUTING_ATTEMPT, readActiveBranch, routingEvidence } from "../src/routing-provenance.ts";
import { validateRoutingMetadata } from "../src/routing-restore.ts";
import { parseRuntimeRouting } from "../src/routing-runtime.ts";
import { frozenRoute, MODEL_A, MODEL_B, policy } from "./routing-fixtures.ts";

const root = mkdtempSync(join(tmpdir(), "squire-provenance-"));
after(() => rmSync(root, { recursive: true, force: true }));
function file(name: string, entries: object[]): string {
	const path = join(root, `${name}.jsonl`);
	writeFileSync(
		path,
		[{ type: "session", id: name, version: 3, cwd: root }, ...entries].map((entry) => JSON.stringify(entry)).join("\n"),
	);
	return path;
}
const assistant = (id: string, parentId: string | null, model: string) => ({
	id,
	parentId,
	type: "message",
	message: {
		role: "assistant",
		provider: model.slice(0, model.indexOf("/")),
		model: model.slice(model.indexOf("/") + 1),
		thinkingLevel: "high",
	},
});
test("author provenance walks raw active ancestry before compaction, excludes abandoned siblings, and never rewrites", () => {
	const path = file("author", [
		assistant("first", null, MODEL_A),
		assistant("abandoned", "first", MODEL_B),
		{ type: "compaction", id: "compact", parentId: "first", firstKeptEntryId: "first", summary: "retained" },
		assistant("current", "compact", MODEL_A),
	]);
	const before = readFileSync(path, "utf8");
	const branch = readActiveBranch(path);
	assert.deepEqual(
		branch.entries.map((entry) => entry.id),
		["first", "compact", "current"],
	);
	assert.deepEqual(authorProof("self", branch, policy().models).families, ["anthropic"]);
	assert.equal(readFileSync(path, "utf8"), before);
	const mixed = file("mixed", [assistant("a", null, MODEL_A), assistant("b", "a", MODEL_B)]);
	assert.deepEqual(authorProof("source", readActiveBranch(mixed), policy().models).families, ["anthropic", "openai"]);
});
test("unknown physical lineage, truncated files, cyclic ancestry and unsupported legacy formats fail closed", () => {
	assert.throws(
		() =>
			authorProof(
				"unknown",
				readActiveBranch(file("unknown", [assistant("a", null, "gateway/opaque")])),
				policy().models,
			),
		/unknown lineage/,
	);
	const broken = file("broken", [assistant("a", "missing", MODEL_A)]);
	assert.throws(() => readActiveBranch(broken), /broken/);
	const cycle = file("cycle", [assistant("a", "a", MODEL_A)]);
	assert.throws(() => readActiveBranch(cycle), /cyclic/);
	const truncated = file("truncated", [assistant("a", null, MODEL_A)]);
	writeFileSync(truncated, `${readFileSync(truncated, "utf8")}\n{"type":`);
	assert.throws(() => readActiveBranch(truncated));
	const legacy = join(root, "legacy.jsonl");
	writeFileSync(legacy, '{"type":"session","id":"old","version":1}');
	assert.throws(() => readActiveBranch(legacy), /unsupported/);
});
test("attempt markers bound review work and survive compaction, without counting inherited messages or later attempts", () => {
	const route = frozenRoute();
	route.independentReview = true;
	route.request.review = { authors: ["self"] };
	route.authors = [{ source: "self", sessionId: "parent", leafId: "lead", models: [MODEL_A], families: ["anthropic"] }];
	route.excludedFamilies = ["anthropic"];
	route.candidates = route.candidates.filter((candidate) => candidate.model === MODEL_B);
	route.selected = MODEL_B;
	const path = file("review", [
		assistant("inherited", null, MODEL_A),
		{ type: "custom", id: "marker", parentId: "inherited", customType: ROUTING_ATTEMPT, data: route },
		assistant("review-work", "marker", MODEL_B),
		{
			type: "compaction",
			id: "compact",
			parentId: "review-work",
			firstKeptEntryId: "review-work",
			summary: "compacted",
		},
		{
			type: "custom",
			id: "later",
			parentId: "compact",
			customType: ROUTING_ATTEMPT,
			data: { ...route, launchId: "later" },
		},
		assistant("later-work", "later", MODEL_A),
	]);
	assert.equal(routingEvidence(route, path).independent, "verified");
	assert.deepEqual(
		routingEvidence(route, path).served.map((item) => item.entryId),
		["review-work"],
	);
});
test("restored frozen constraints and verification cannot downgrade into legacy/verified with malformed metadata", () => {
	const route = frozenRoute();
	assert.equal(parseRuntimeRouting(route).selected, MODEL_A);
	for (const bad of [
		{ ...route, version: 2 },
		{ ...route, candidates: [] },
		{ ...route, launchId: undefined },
		{ ...route, selected: undefined },
		{ ...route, excludedFamilies: ["anthropic"] },
	])
		assert.throws(() => parseRuntimeRouting(bad));
	const record = {
		id: route.launchId,
		agent: route.role,
		model: route.selected,
		routingVersion: 1,
		routing: route,
	} as StartedRecorded;
	assert.doesNotThrow(() => validateRoutingMetadata(record));
	assert.throws(() => validateRoutingMetadata({ ...record, routing: undefined }));
	assert.throws(() => validateRoutingMetadata({ ...record, routingVersion: undefined }));
	assert.throws(() => validateRoutingMetadata({ ...record, id: "different-attempt" }), /identity\/model mismatch/);
	assert.throws(() => validateRoutingMetadata({ ...record, agent: "other-role" }), /identity\/model mismatch/);
	assert.throws(
		() =>
			validateRoutingMetadata({
				...record,
				result: {
					status: "done",
					replyId: "reply",
					envelopePath: "/fixture",
					routingEvidence: { independent: "verified", complete: true, served: [], reasons: [], fallbacks: [] },
				},
			} as StartedRecorded),
		/incomplete/,
	);
});
