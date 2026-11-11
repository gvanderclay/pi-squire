import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { admitRouting } from "../src/routing-state.ts";
import { frozenRoute, MODEL_A, MODEL_B } from "./routing-fixtures.ts";

const root = mkdtempSync(join(tmpdir(), "routing-state-"));
process.env.PI_CODING_AGENT_DIR = root;
after(() => rmSync(root, { recursive: true, force: true }));
test("failed validation and previews do not consume a turn, admitted calls durably alternate per root/pool", () => {
	assert.throws(() =>
		admitRouting("parent", frozenRoute(), () => {
			throw new Error("invalid hook");
		}),
	);
	const route = frozenRoute();
	admitRouting("parent", route, () => {});
	assert.equal(route.tieTurn, 0);
	assert.equal(route.selected, MODEL_A);
	const next = frozenRoute();
	admitRouting("parent", next, () => {});
	assert.equal(next.tieTurn, 1);
	assert.equal(next.selected, MODEL_B);
	const separate = frozenRoute();
	admitRouting("other-root", separate, () => {});
	assert.equal(separate.tieTurn, 0);
});
test("roles sharing a pool rotate the same family set even when their candidate lists are reversed", () => {
	const selected: string[] = [];
	for (let turn = 0; turn < 6; turn++) {
		const route = frozenRoute();
		route.role = turn % 2 ? "other-role" : "worker";
		if (turn % 2) route.candidates.reverse();
		admitRouting("permuted-parent", route, () => {});
		assert.equal(route.tieTurn, turn);
		selected.push(route.selected);
	}
	assert.deepEqual(selected, [MODEL_A, MODEL_B, MODEL_A, MODEL_B, MODEL_A, MODEL_B]);
});

test("prototype-named pools and corrupt durable state cannot silently reuse a turn", () => {
	const route = frozenRoute();
	route.pool = "constructor";
	admitRouting("prototype", route, () => {});
	assert.equal(route.tieTurn, 0);
	const path = join(root, "squire", "routing-state", `${createHash("sha256").update("prototype").digest("hex")}.json`);
	writeFileSync(path, "{corrupt");
	assert.throws(() => admitRouting("prototype", frozenRoute(), () => {}));
	assert.equal(readFileSync(path, "utf8"), "{corrupt");
	for (const invalid of [null, { version: 1, root: "prototype", pools: [] }]) {
		writeFileSync(path, JSON.stringify(invalid));
		assert.throws(() => admitRouting("prototype", frozenRoute(), () => {}), /invalid routing tie state/);
	}
});

test("separate-process concurrent admissions never consume the same root/pool turn", async () => {
	const path = join(root, "route.json");
	writeFileSync(path, JSON.stringify(frozenRoute()));
	const run = promisify(execFile);
	const results = await Promise.all(
		Array.from({ length: 12 }, async () => {
			const result = await run(process.execPath, ["test/fixtures/routing-admit.ts", "concurrent-parent", path]);
			return JSON.parse(result.stdout) as { turn: number; model: string };
		}),
	);
	results.sort((a, b) => a.turn - b.turn);
	assert.deepEqual(
		results.map((result) => result.turn),
		Array.from({ length: 12 }, (_, index) => index),
	);
	assert.deepEqual(
		results.map((result) => result.model),
		Array.from({ length: 12 }, (_, index) => (index % 2 ? MODEL_B : MODEL_A)),
	);
});
