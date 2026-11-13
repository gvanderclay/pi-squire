import assert from "node:assert/strict";
import { test } from "node:test";
import {
	autoExitText,
	locatorRules,
	sameLiveLocator,
	sameWindowLocator,
	validWindowLocator,
	windowFacts,
	windowPresentation,
	windowTerms,
} from "../src/locators.ts";
import { paseoLocator, paseoLocators } from "../src/paseo-locator.ts";

const agent = "8f14e45f-ea3b-4c1d-9f2a-6b7c8d9e0f12";
const other = "0d3f6a9b-2c4e-4f60-8a1b-3c5d7e9f0a2b";
const paseo = { adapter: "paseo", version: 1, kind: "window", agent, name: "scout-paseo" };

test("a Paseo locator keeps a UUID agent and a bounded non-empty title", () => {
	assert.deepEqual(paseoLocator(paseo), paseo);
	assert.equal(validWindowLocator(paseo), true);
	assert.equal(locatorRules(paseo), paseoLocators);
	assert.deepEqual(paseoLocator({ ...paseo, name: "w".repeat(4096) }), { ...paseo, name: "w".repeat(4096) });
	for (const value of [
		null,
		undefined,
		[],
		"paseo",
		{ ...paseo, agent: "not-a-uuid" },
		{ ...paseo, agent: 71 },
		{ ...paseo, version: 2 },
		{ ...paseo, kind: "pane" },
		{ ...paseo, name: undefined },
		{ ...paseo, name: "" },
		{ ...paseo, name: "w".repeat(4097) },
	]) {
		assert.equal(paseoLocator(value), undefined);
		assert.equal(validWindowLocator(value), false);
	}
	assert.deepEqual(
		paseoLocator({ ...paseo, extra: true }),
		{ ...paseo, extra: true },
		"unknown extra fields do not invalidate a locator",
	);
});

test("Paseo presentation and equality read the agent, never the title", () => {
	assert.deepEqual(windowPresentation({ locator: paseo }), { windowId: agent, windowName: "scout-paseo" });
	assert.equal(sameWindowLocator({ locator: paseo }, { locator: { ...paseo, name: "renamed" } }), true);
	assert.equal(sameWindowLocator({ locator: paseo }, { locator: { ...paseo, agent: other } }), false);
	assert.equal(
		sameWindowLocator(
			{ locator: paseo },
			{ locator: { adapter: "tmux", version: 1, kind: "window", id: "@71", name: "x" } },
		),
		false,
	);
	assert.deepEqual(windowTerms({ locator: paseo }), { noun: "agent", host: "Paseo", group: "workspace" });
	const facts = windowFacts({ locator: paseo });
	assert.equal(facts.retainedAfterExit, false);
	assert.equal(facts.requiresSessionGuard, false);
	assert.equal(facts.ancestorReturnHint, false);
	assert.equal(
		autoExitText({ locator: paseo }, true),
		"on — the Paseo agent is archived after its task reply and nested work are handled unless the user took over",
	);
	assert.equal(autoExitText({ locator: paseo }, false), "off — the Paseo agent stays open after the result");
	assert.equal(paseoLocators.liveIsWindow, false);
	assert.equal(paseoLocators.normalizeLive(paseo), undefined);
	assert.equal(paseoLocators.runningLive(paseo), undefined);
	assert.equal(paseoLocators.paneTarget(paseo), undefined);
	assert.equal(paseoLocators.sameLive(paseo, paseo), false);
	assert.equal(sameLiveLocator(paseo, paseo), false);
});
