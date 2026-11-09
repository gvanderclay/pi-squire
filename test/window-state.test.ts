import assert from "node:assert/strict";
import { test } from "node:test";
import { askPaneStates, askToClose, askWindowStates, UNASKED, windowStates } from "../src/window-state.ts";
import { FakeTmux } from "./fake-tmux.ts";

const record = { windowId: "@1", windowName: "worker-ab12" };

test("a window matches on both id and name, and an exited program counts as gone", () => {
	const listed = (name: string, exited = false) => [{ id: "@1", name, exited, session: "work" }];
	assert.deepEqual(windowStates(listed("worker-ab12")).look(record), { state: "running", session: "work" });
	// tmux ids restart with the server: the same id under another name is someone else's window.
	assert.deepEqual(windowStates(listed("other")).look(record), { state: "gone" });
	assert.deepEqual(windowStates(listed("worker-ab12", true)).look(record), { state: "gone", session: "work" });
	assert.equal(windowStates([]).state(record), "gone");
});

test("no listing, or nothing asked, is unknown and never gone", () => {
	assert.deepEqual(windowStates(undefined).look(record), { state: "unknown" });
	assert.equal(UNASKED.state(record), "unknown");
	assert.equal(UNASKED.listing, undefined);
});

test("one ask serves every record, and a failed ask is unknown", async () => {
	const tmux = new FakeTmux();
	tmux.addWindow("@1", "worker-ab12", "work");
	tmux.addWindow("@2", "worker-cd34", "work");
	tmux.exit("@2");
	const states = await askWindowStates(tmux);
	assert.equal(tmux.listCalls, 1);
	assert.deepEqual(
		[record, { windowId: "@2", windowName: "worker-cd34" }, { windowId: "@3", windowName: "x" }].map((r) =>
			states.state(r),
		),
		["running", "gone", "gone"],
	);
	tmux.failList = "no server";
	assert.equal((await askWindowStates(tmux)).state(record), "unknown");
	assert.equal(tmux.listCalls, 2);
});

test("a pane ask gives states from its window listing and keeps the listing", async () => {
	const tmux = new FakeTmux();
	tmux.addWindow("@1", "worker-ab12", "work");
	const panes = await askPaneStates(tmux);
	assert.equal(tmux.paneListCalls, 1);
	assert.equal(tmux.listCalls, 0);
	assert.equal(panes.state(record), "running");
	assert.ok(panes.listing);
	tmux.failList = "no server";
	const failed = await askPaneStates(tmux);
	assert.equal(failed.state(record), "unknown");
	assert.equal(failed.listing, undefined);
});

test("listed distinguishes an exited window from an absent or unknown one without another ask", async () => {
	const tmux = new FakeTmux();
	tmux.addWindow(record.windowId, record.windowName, "work");
	tmux.exit(record.windowId);
	const states = await askWindowStates(tmux);
	assert.equal(states.answered, true);
	assert.equal(states.state(record), "gone");
	assert.equal(states.listed(record), true);
	assert.equal(states.listed({ ...record, windowName: "replacement" }), false);
	assert.equal(states.listed({}), false);
	assert.equal(tmux.listCalls, 1);
	tmux.failList = "no server";
	const failed = await askWindowStates(tmux);
	assert.equal(failed.answered, false);
	assert.equal(failed.listed(record), false);
	assert.equal(failed.state(record), "unknown");
});

test("close uses its one ask, closes running and exited owned windows, and is idempotent when gone", async () => {
	const tmux = new FakeTmux();
	tmux.addWindow(record.windowId, record.windowName, "work");
	const exited = { windowId: "@2", windowName: "exited" };
	tmux.addWindow(exited.windowId, exited.windowName, "work");
	tmux.exit(exited.windowId);
	const states = await askToClose(tmux);
	assert.equal(await states.close(record), true);
	assert.equal(await states.close(exited), true);
	assert.equal(tmux.listCalls, 1);
	assert.deepEqual(tmux.killed, ["@1", "@2"]);
	assert.equal(await (await askToClose(tmux)).close(record), false);
	assert.equal(tmux.listCalls, 2);
	assert.deepEqual(tmux.killed, ["@1", "@2"]);
});

test("close never kills an id reused under another name, or guesses when its ask failed", async () => {
	const tmux = new FakeTmux();
	tmux.addWindow(record.windowId, "someone-else", "work");
	assert.equal(await (await askToClose(tmux)).close(record), false);
	tmux.failList = "no server";
	await assert.rejects(askToClose(tmux), /no server/);
	const unknown = await askWindowStates(tmux);
	await assert.rejects(unknown.close(record), /could not ask tmux/);
	assert.deepEqual(tmux.killed, []);
});

test("close propagates kill failures without repeating the ask or kill", async () => {
	const tmux = new FakeTmux();
	tmux.addWindow(record.windowId, record.windowName, "work");
	let kills = 0;
	tmux.kill = async () => {
		kills++;
		throw new Error("kill failed");
	};
	const states = await askToClose(tmux);
	await assert.rejects(states.close(record), /kill failed/);
	assert.equal(tmux.listCalls, 1);
	assert.equal(kills, 1);
});
