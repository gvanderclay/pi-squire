import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { writeIdentity } from "../src/identity.ts";
import type { LiveLocator } from "../src/widget-live.ts";
import { liveSessionDir } from "../src/widget-live.ts";
import { agentDir, cleanup, resetRoot } from "./harness.ts";
import { TreeProcess } from "./tree-process-harness.ts";

const active: TreeProcess[] = [];
beforeEach(resetRoot);
afterEach(async () => {
	for (const p of active.splice(0)) await p.kill();
});
after(cleanup);
function processFixture(): TreeProcess {
	const p = new TreeProcess(agentDir, "./fixtures/widget-ancestor.ts");
	active.push(p);
	return p;
}
function server(windowId = "@1", name = "root", session = "original") {
	return {
		ownPane: "%1",
		windows: [
			{ id: windowId, name, session },
			{ id: "@2", name: "child", session: "children" },
		],
		panes: [
			{ id: "%1", windowId },
			{ id: "%2", windowId: "@2" },
		],
	};
}
function identity(session: string, parent: string, root: string, depth: number): void {
	writeIdentity(session, {
		parent,
		root,
		depth,
		agent: "coord",
		chain: ["coord"],
		autoExit: false,
		rootPlacement: "original-delegate-session",
	});
}
async function locator(
	reader: TreeProcess,
	id: string,
	accept: (value: LiveLocator) => boolean = () => true,
): Promise<LiveLocator> {
	const end = Date.now() + 7000;
	let value: LiveLocator | null = null;
	while (Date.now() < end) {
		value = await reader.command<LiveLocator | null>("locator", { target: id });
		if (value && accept(value)) return value;
		await new Promise((r) => setTimeout(r, 20));
	}
	assert.fail(`no current locator for ${id}: ${JSON.stringify(value)}`);
}
test("actual processes: root without launch/registry publishes, leaf switches directly, current pane names/moves and server mismatches fail closed", async () => {
	const root = processFixture();
	const first = await root.command<{ entries: unknown[] }>("boot", { session: "root", server: server() });
	assert.deepEqual(first.entries, []);
	identity("parent", "root", "root", 1);
	identity("leaf", "parent", "root", 2);
	const child = processFixture();
	const childServer = { ...server(), ownPane: "%2" };
	await child.command("boot", { session: "leaf", server: childServer });
	const initial = await locator(child, "root");
	assert.equal(initial.locator.windowId, "@1");
	assert.equal(initial.sessionFile, undefined, "unflushed root does not need a transcript");
	await root.command("start-tool");
	assert.equal(await child.command("activity", { target: "root", launch: "invented" }), null);
	assert.deepEqual(await child.command("switch", { target: "root" }), [{ client: "fixture-client", windowId: "@1" }]);
	await assert.rejects(child.command("switch", { target: "unrelated" }), /not a current ancestor/);
	const renamed = server("@1", "renamed");
	await child.command("server", { server: { ...renamed, ownPane: "%2" } });
	await assert.rejects(child.command("switch", { target: "root" }), /verified live window|changed/);
	await root.command("server", { server: renamed });
	await locator(child, "root", (v) => v.locator.windowName === "renamed");
	await child.command("switch", { target: "root" });
	await child.command("fail-list", { text: "unknown listing" });
	await assert.rejects(child.command("switch", { target: "root" }), /verified live window/);
	await child.command("fail-list");
	// Window-level pane_dead may describe another active pane; exact owner pane remains live.
	const split = {
		...renamed,
		ownPane: "%2",
		windows: renamed.windows.map((w) => ({ ...w, exited: w.id === "@1" })),
		panes: [
			{ id: "%1", windowId: "@1", exited: false },
			{ id: "%2", windowId: "@2" },
		],
	};
	await child.command("server", { server: split });
	await child.command("switch", { target: "root" });
	await child.command("server", {
		server: {
			...split,
			panes: [
				{ id: "%1", windowId: "@1", exited: true },
				{ id: "%2", windowId: "@2" },
			],
		},
	});
	await assert.rejects(child.command("switch", { target: "root" }), /verified live window/);
	const moved = server("@8", "moved", "new-current-session");
	await child.command("server", { server: { ...moved, ownPane: "%2" } });
	await assert.rejects(child.command("switch", { target: "root" }), /verified live window|changed/);
	await root.command("server", { server: moved });
	await locator(child, "root", (v) => v.locator.windowId === "@8");
	await child.command("switch", { target: "root" });
	await child.command("server", {
		server: { ...moved, ownPane: "%2", scope: { socket: "other", serverPid: 1, serverStarted: "1" } },
	});
	await assert.rejects(child.command("switch", { target: "root" }), /verified live window/);
	await child.command("server", {
		server: { ...moved, ownPane: "%2", scope: { socket: "fake-socket", serverPid: 1, serverStarted: "2" } },
	});
	await assert.rejects(child.command("switch", { target: "root" }), /verified live window/);
	const snapshot = await child.command<{ opened: unknown[]; killed: unknown[]; entries: unknown[] }>("snapshot");
	assert.deepEqual(snapshot.opened, []);
	assert.deepEqual(snapshot.killed, []);
	assert.deepEqual(snapshot.entries, []);
});

test("actual processes: duplicate owner cannot publish, SIGKILL root/reopen changes locator without launch seed, old shutdown cannot erase replacement", async () => {
	const root = processFixture();
	await root.command("boot", { session: "root", server: server() });
	const old = await locator(root, "root");
	const duplicate = processFixture();
	const losing = await duplicate.command<{ shutdowns: number }>("boot", {
		session: "root",
		server: server("@9", "loser"),
	});
	assert.equal(losing.shutdowns, 1);
	await duplicate.command("start-tool");
	await duplicate.command("shutdown");
	assert.equal((await locator(root, "root")).generation, old.generation);
	await root.kill();
	const replacement = processFixture();
	await replacement.command("boot", { session: "root", server: server("@3", "reopened") });
	const next = await locator(replacement, "root", (v) => v.generation !== old.generation);
	assert.equal(next.locator.windowId, "@3");
	await duplicate.command("shutdown");
	assert.equal((await locator(replacement, "root")).generation, next.generation);
	await replacement.command("shutdown");
	const orderly = processFixture();
	await orderly.command("boot", { session: "root", server: server("@4", "orderly") });
	assert.equal((await locator(orderly, "root")).locator.windowId, "@4");
});

test("actual processes: exact-id coordinator reattachment stays separate from gone history and corrupt owner/metadata is unavailable", async () => {
	mkdirSync(join(agentDir, "squire", "child-tasks"), { recursive: true });
	identity("coord", "root", "root", 1);
	identity("leaf", "coord", "root", 2);
	const historical = { records: [{ id: "launch", sessionId: "coord", gone: true, windowId: "@old" }], outcomes: [] };
	const historyPath = join(agentDir, "squire", "child-tasks", "root.json");
	writeFileSync(historyPath, JSON.stringify(historical));
	const coord = processFixture();
	await coord.command("boot", { session: "coord", server: server("@7", "reattached") });
	const child = processFixture();
	await child.command("boot", { session: "leaf", server: { ...server("@7", "reattached"), ownPane: "%2" } });
	const live = await locator(child, "coord");
	await child.command("switch", { target: "coord" });
	assert.deepEqual(JSON.parse(readFileSync(historyPath, "utf8")), historical);
	assert.equal(await child.command("activity", { target: "coord", launch: "launch" }), null);
	const ownerPath = join(agentDir, "squire", "owners", "coord.json");
	const saved = readFileSync(ownerPath, "utf8");
	writeFileSync(ownerPath, "broken");
	assert.equal(await child.command("locator", { target: "coord" }), null);
	writeFileSync(ownerPath, saved);
	const snapshotPath = join(liveSessionDir("coord"), `${live.generation}.json`);
	writeFileSync(snapshotPath, "x".repeat(9000));
	assert.equal(await child.command("locator", { target: "coord" }), null);
});
