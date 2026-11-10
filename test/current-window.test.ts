import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { currentChildWindows } from "../src/current-window.ts";
import type { DelegateHost } from "../src/host.ts";
import { NavigatorView } from "../src/navigator-view.ts";
import type { Results, StartedRecorded } from "../src/results.ts";
import { windowLocator } from "../src/tmux.ts";
import { LiveActivityReader, liveSessionDir } from "../src/widget-live.ts";
import { askPaneStates } from "../src/window-state.ts";
import { FakeTmux } from "./fake-tmux.ts";
import { agentDir, cleanup, resetRoot } from "./harness.ts";

beforeEach(resetRoot);
after(cleanup);

const record: StartedRecorded = {
	id: "child",
	sessionId: "stable",
	agent: "worker",
	model: "m",
	thinking: "off",
	windowId: "@1",
	windowName: "child",
	requestId: "request",
};
function results(records: StartedRecorded[]): Results {
	return { list: () => records } as unknown as Results;
}
function save(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value));
}
/** A released publisher's file: an untagged tmux PaneLocator. */
function releasedLive(tmux: FakeTmux): void {
	save(join(agentDir, "squire", "owners", "stable.json"), { pid: process.pid, token: "owner" });
	const generation = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
	save(join(liveSessionDir("stable"), `${generation}.json`), {
		version: 1,
		sessionId: "stable",
		generation,
		pid: process.pid,
		revision: 1,
		observedAt: Date.now(),
		activity: null,
		ownerToken: "owner",
		locator: { ...tmux.scope, paneId: "%7", windowId: "@70", windowName: "old", exited: false },
	});
}
function terminal(): FakeTmux {
	const tmux = new FakeTmux();
	tmux.addWindow("@0", "caller");
	tmux.addWindow("@8", "renamed");
	tmux.ownPane = "%0";
	tmux.panes.set("%0", { windowId: "@0" });
	tmux.panes.set("%7", { windowId: "@8" });
	return tmux;
}
/** The same terminal seen through a host that has no live pane to observe, verify or snapshot. */
function paneFree(tmux: FakeTmux): DelegateHost {
	return Object.assign(Object.create(tmux), {
		observeLivePane: undefined,
		verifyLivePane: undefined,
		paneStates: undefined,
	}) as DelegateHost;
}

test("released bare live telemetry places the delegation in its pane's current window for the widget and navigator", async () => {
	const tmux = terminal();
	releasedLive(tmux);
	const found = await currentChildWindows(results([record]), await askPaneStates(tmux), new LiveActivityReader());
	assert.deepEqual(found.get(record.id), { locator: windowLocator({ id: "@8", name: "renamed" }) });
	const [item] = (await new NavigatorView(results([record]), tmux).items())!;
	assert.equal(item.window.id, "@8");
	assert.equal(item.navigable, true);
});

test("a host with no live pane reads no live evidence for the widget and never navigates by it", async (t) => {
	const tmux = terminal();
	releasedLive(tmux);
	const host = paneFree(tmux);
	const reader = new LiveActivityReader();
	const locate = t.mock.method(reader, "locator");
	assert.equal((await currentChildWindows(results([record]), await askPaneStates(host), reader)).size, 0);
	assert.equal(locate.mock.callCount(), 0);

	tmux.addWindow("@1", "child");
	const unverified = await new NavigatorView(results([record]), host, reader).items();
	assert.deepEqual(unverified, [], "live evidence the host cannot verify never falls back to the recorded window");
	const recorded = (await new NavigatorView(results([record]), host, { locator: async () => undefined }).items())!;
	assert.equal(recorded[0].window.id, "@1");
	assert.equal(recorded[0].navigable, true);
});
