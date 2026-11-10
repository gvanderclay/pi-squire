// The one module that words where a delegate is.

import assert from "node:assert/strict";
import { test } from "node:test";

import { inSession, locationTerms, noVerifiedOpen, openedIn, recordedLocation, windowDetail } from "../src/location.ts";

const tmuxRecord = { locator: { adapter: "tmux", version: 1, kind: "window", id: "@3", name: "scout-ab12" } } as const;

test("openedIn words the tmux window and its session, or the adapter's own location", () => {
	assert.equal(openedIn({ windowName: "scout-ab12" }), "window scout-ab12");
	assert.equal(openedIn({ windowName: "scout-ab12", windowSession: "main" }), "window scout-ab12 in session main");
	assert.equal(openedIn({ windowName: "scout-ab12", windowSession: "main" }, { session: false }), "window scout-ab12");
	assert.equal(openedIn({ windowName: "scout-ab12", windowSession: "main", location: "tab 7" }), "tab 7");
});

test("inSession and windowDetail leave out an absent session", () => {
	assert.equal(inSession(undefined), "");
	assert.equal(inSession("main"), " in session main");
	assert.equal(windowDetail({ windowName: "a", windowId: "@1" }), "window a (@1)");
	assert.equal(windowDetail({ windowName: "a", windowId: "@1", windowSession: "s" }), "window a (@1) in session s");
});

test("recordedLocation and nouns follow the recorded window", () => {
	assert.deepEqual(locationTerms(tmuxRecord), { noun: "window", host: "tmux", group: "session" });
	assert.equal(recordedLocation(tmuxRecord, undefined), "window: scout-ab12 (@3)");
	assert.equal(recordedLocation(tmuxRecord, ""), "window: scout-ab12 (@3)");
	assert.equal(recordedLocation(tmuxRecord, "main"), "window: scout-ab12 (@3) in session main");
	assert.equal(noVerifiedOpen("tab"), "no verified open tab for this delegation; tab changed or unavailable");
	assert.equal(noVerifiedOpen("window", { changed: false }), "no verified open window");
});
