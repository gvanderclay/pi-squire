import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	autoExitText,
	livePaneTarget,
	locatedRecord,
	normalizeLiveLocator,
	recordLocator,
	sameLiveLocator,
	sameWindowLocator,
	validWindowLocator,
	windowFacts,
	windowLocator,
	windowPresentation,
	windowTerms,
} from "../src/locators.ts";
import { tmuxLocator } from "../src/tmux-locator.ts";

const tmux = { adapter: "tmux", version: 1, kind: "window", id: "@71", name: "" };
const herdr = {
	adapter: "herdr",
	version: 1,
	kind: "window",
	session: null,
	socket: "/socket",
	workspace: "w1",
	tab: "w1:t2",
	pane: "w1:p2",
	terminal: "terminal",
	name: "worker",
	launchFile: "/launch",
};

test("adapter-owned validators keep released tmux and Herdr shapes and bounds", () => {
	for (const value of [
		tmux,
		{ ...tmux, name: "worker".repeat(1000) },
		{ ...tmux, extra: true },
		herdr,
		{ ...herdr, session: "named" },
	]) {
		assert.equal(validWindowLocator(value), true);
		assert.equal(recordLocator({ locator: value }), value);
		assert.deepEqual(locatedRecord({ locator: value }), { locator: value });
	}
	for (const value of [
		null,
		[],
		{ ...tmux, version: 2 },
		{ ...tmux, id: "71" },
		{ ...tmux, name: null },
		{ ...herdr, session: undefined },
		{ ...herdr, session: "" },
		{ ...herdr, socket: "s".repeat(4097) },
		{ ...herdr, kind: "pane" },
	])
		assert.equal(validWindowLocator(value), false);
	assert.equal(tmuxLocator(herdr), false, "the tmux codec does not validate another adapter");
	const legacy = { windowId: "@71", windowName: "" };
	assert.deepEqual(recordLocator(legacy), tmux);
	assert.deepEqual(windowLocator({ id: "@71", name: "" }), tmux);
});

test("adapter equality and presentation preserve each released identity rule", () => {
	assert.equal(sameWindowLocator({ locator: tmux }, { windowId: "@71", windowName: "" }), true);
	assert.equal(sameWindowLocator({ locator: tmux }, { locator: { ...tmux, name: "renamed" } }), false);
	assert.equal(
		sameWindowLocator({ locator: herdr }, { locator: { ...herdr, name: "renamed" } }),
		true,
		"Herdr names are not identity",
	);
	assert.equal(sameWindowLocator({ locator: herdr }, { locator: { ...herdr, launchFile: "/other" } }), false);
	const live = { ...herdr, kind: "pane" };
	assert.equal(sameLiveLocator(live, { ...live, name: "renamed" }), true);
	assert.deepEqual(windowPresentation({ locator: live }), { windowId: "w1:t2", windowName: "worker" });
	assert.equal(validWindowLocator(live), false);
	assert.equal(livePaneTarget(live), "w1:p2");
	assert.deepEqual(windowTerms({ locator: herdr }), { noun: "tab", host: "Herdr", group: "workspace" });
	assert.equal(windowFacts({ locator: herdr }).retainedAfterExit, true);
	assert.equal(windowFacts({ locator: live }).ancestorReturnHint, true);
	assert.equal(windowFacts({ locator: tmux }).requiresSessionGuard, false);
	assert.match(autoExitText({ locator: herdr }, true), /errors retain it/);
	assert.equal(
		autoExitText({ locator: live }, true),
		autoExitText({}, true),
		"disposable pane evidence does not change durable auto-exit wording",
	);
});

test("bare released live telemetry upgrades identically; explicit unknown tags never downgrade", () => {
	const fixture = JSON.parse(readFileSync(new URL("./fixtures/released-window-records.json", import.meta.url), "utf8"));
	const bare = fixture.pane;
	const wrapped = { adapter: "tmux", version: 1, kind: "pane", pane: bare };
	assert.deepEqual(normalizeLiveLocator(bare), wrapped);
	assert.deepEqual(normalizeLiveLocator(wrapped), wrapped);
	assert.equal(livePaneTarget(bare), bare.paneId);
	for (const value of [
		{ ...tmux, adapter: "future" },
		{ ...herdr, adapter: "future" },
		{ ...bare, adapter: "future" },
	]) {
		assert.equal(validWindowLocator(value), false);
		assert.equal(normalizeLiveLocator(value), undefined);
		assert.equal(recordLocator({ locator: value, windowId: "@71", windowName: "fallback" }), undefined);
		assert.throws(() => locatedRecord({ locator: value, windowId: "@71", windowName: "fallback" }), /unsupported/);
	}
});
