import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createNavigator } from "../src/navigator.ts";
import type { Results, StartedRecorded } from "../src/results.ts";
import { FakeTmux } from "./fake-tmux.ts";

const record: StartedRecorded = {
	id: "launch",
	name: "worker",
	agent: "worker",
	model: "provider/model",
	thinking: "off",
	windowId: "@1",
	windowName: "worker",
	requestId: "request",
	result: { status: "done", replyId: "reply", envelopePath: "/reply" },
};
test("context-bearing close seam preserves partial/error text; no duplicate window controls", async () => {
	const tmux = new FakeTmux();
	tmux.addWindow("@1", "worker");
	const results = { list: () => [record], find: () => record } as unknown as Results;
	const notes: { text: string; type: string }[] = [];
	let closes = 0;
	let chosen = false;
	const ctx = {
		mode: "tui",
		sessionManager: { getSessionId: () => "parent" },
		ui: {
			notify: (text: string, type: string) => notes.push({ text, type }),
			custom: async () => {
				if (chosen) return undefined;
				chosen = true;
				return { action: "close", id: "launch" };
			},
		},
	} as unknown as ExtensionContext;
	const navigator = createNavigator(
		results,
		tmux,
		{
			close: async () => {
				throw Error("old close must not run");
			},
		},
		() => {},
		{
			close: async (id, context) => {
				assert.equal(id, "launch");
				assert.equal(context, ctx);
				closes++;
				return { text: "Partial: one window uncertain; no replacement was killed", isError: true };
			},
		},
	);
	await navigator.panel(ctx);
	assert.equal(closes, 1);
	assert.equal(tmux.killed.length, 0);
	assert.deepEqual(notes, [
		{ text: "delegate: Partial: one window uncertain; no replacement was killed", type: "error" },
	]);
});
test("ownership lost during async window listing cannot mount a stale dashboard", async () => {
	const tmux = new FakeTmux();
	let active = true;
	const list = tmux.listWindows.bind(tmux);
	tmux.listWindows = async () => {
		active = false;
		return list();
	};
	const results = { list: () => [record] } as unknown as Results;
	let screens = 0;
	const ctx = {
		mode: "tui",
		ui: {
			custom: () => {
				screens++;
			},
			notify: () => {},
		},
	} as unknown as ExtensionContext;
	const navigator = createNavigator(
		results,
		tmux,
		{
			close: async () => {
				throw Error("unused");
			},
		},
		() => {},
		{
			assertActive: () => {
				if (!active) throw Error("inactive");
			},
		},
	);
	await assert.rejects(navigator.panel(ctx), /inactive/);
	assert.equal(screens, 0);
});
