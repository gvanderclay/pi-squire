import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { contextNotice } from "../src/resume-checks.ts";

/** A registry that knows no model, so every identifier is a custom id it cannot establish. */
const empty = { getAll: () => [], find: () => undefined, hasConfiguredAuth: () => false } as unknown as ModelRegistry;

test("an identical unregistered model id is the same model, and a different one is unknown", () => {
	assert.deepEqual(contextNotice("/no/such/session.jsonl", "alpha/custom-id", "alpha/custom-id", empty), []);
	assert.deepEqual(contextNotice("/no/such/session.jsonl", "alpha/custom-id", "alpha/other-id", empty), [
		"The source's cache may not carry over to alpha/other-id: model identity could not be established.",
	]);
});
