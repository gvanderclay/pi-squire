import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import type { PaneLocator } from "../src/tmux.ts";
import { LIVE_MAX_BYTES, LiveActivityPublisher, LiveActivityReader, liveSessionDir } from "../src/widget-live.ts";
import { processStart } from "../src/widget-live-process.ts";
import { titleMirrorPath } from "../src/widget-title.ts";
import { agentDir, cleanup, resetRoot } from "./harness.ts";
import { ActivityProcess } from "./widget-live-process-harness.ts";

const processes: ActivityProcess[] = [];
const publishers: LiveActivityPublisher[] = [];
beforeEach(resetRoot);
afterEach(async () => {
	for (const p of publishers.splice(0)) {
		p.stop();
		await p.closed();
	}
	for (const p of processes.splice(0)) await p.kill();
});
after(cleanup);
function fixture(environment: NodeJS.ProcessEnv = {}) {
	const p = new ActivityProcess(agentDir, "widget-live.ts", environment);
	processes.push(p);
	return p;
}
function publisher(id = "stable", launch = "launch", options?: ConstructorParameters<typeof LiveActivityPublisher>[2]) {
	const p = new LiveActivityPublisher(id, launch, options);
	publishers.push(p);
	return p;
}
test("separate OS processes propagate id-based synthetic activity, text, settlement and shutdown", async () => {
	const writer = fixture(),
		reader = fixture();
	await writer.command("init", { sessionId: "stable", launchId: "launch" });
	await writer.command("start", { id: "p", name: "codemode" });
	await writer.command("start", { id: "p/1", name: "read", parent: "p" });
	await writer.command("start", { id: "p/2", name: "read", parent: "p" });
	assert.deepEqual(await reader.command("read", { sessionId: "stable", launchId: "launch" }), {
		kind: "tools",
		text: "reading…",
	});
	await writer.command("end", { id: "p/2" });
	assert.deepEqual(await reader.command("read", { sessionId: "stable", launchId: "launch" }), {
		kind: "tools",
		text: "reading…",
	});
	await writer.command("settled");
	assert.equal(await reader.command("read", { sessionId: "stable", launchId: "launch" }), null);
	await writer.command("message", { text: "literal response" });
	assert.deepEqual(await reader.command("read", { sessionId: "stable", launchId: "launch" }), {
		kind: "response",
		text: "literal response",
	});
	await writer.command("messageEnd");
	assert.equal(await reader.command("read", { sessionId: "stable", launchId: "launch" }), null);
	await writer.command("stop");
	assert.deepEqual(await readdir(liveSessionDir("stable")), []);
});
test("different process TZ/locale preserves live activity and never deletes its live snapshot", async () => {
	const writer = fixture({ TZ: "Pacific/Auckland", LC_ALL: "fr_FR.UTF-8", LANG: "fr_FR.UTF-8" });
	const reader = fixture({ TZ: "America/New_York", LC_ALL: "C", LANG: "C" });
	const generation = await writer.command<string>("init", { sessionId: "formatted-owner", launchId: "launch" });
	await writer.command("start", { id: "call", name: "read" });
	const path = join(liveSessionDir("formatted-owner"), `${generation}.json`);
	const before = await readFile(path, "utf8");
	for (let pass = 0; pass < 2; pass++) {
		assert.deepEqual(await reader.command("read", { sessionId: "formatted-owner", launchId: "launch" }), {
			kind: "tools",
			text: "reading…",
		});
		assert.equal(await readFile(path, "utf8"), before, "reader must not delete or rewrite the live owner");
		assert.equal(writer.child.exitCode, null);
	}
	await writer.command("stop");
});
test("different process TZ/locale preserves the existing native-title mirror", async () => {
	const writer = fixture({ TZ: "Pacific/Auckland", LC_ALL: "fr_FR.UTF-8", LANG: "fr_FR.UTF-8" });
	const reader = fixture({ TZ: "America/New_York", LC_ALL: "C", LANG: "C" });
	await writer.command("titlePublish", { sessionId: "formatted-title", text: "Native title across environments" });
	const path = titleMirrorPath("formatted-title");
	const before = await readFile(path, "utf8");
	assert.equal(await reader.command("titleRead", { sessionId: "formatted-title" }), "Native title across environments");
	assert.equal(await readFile(path, "utf8"), before);
	await writer.command("stop");
});
test("crashed publisher is rejected and only its positively dead generation is lazily removed", async () => {
	const writer = fixture(),
		reader = fixture();
	await writer.command("init", { sessionId: "crash", launchId: "launch" });
	await writer.command("start", { id: "call", name: "bash" });
	await writer.kill();
	assert.equal(await reader.command("read", { sessionId: "crash", launchId: "launch" }), null);
	assert.deepEqual(await readdir(liveSessionDir("crash")), []);
});
test("live generations are ambiguous; unique shutdown cannot delete replacement; resume launch must match", async () => {
	const a = publisher(),
		b = publisher();
	a.publish({ kind: "tools", text: "reading…" });
	await a.flush();
	b.publish({ kind: "tools", text: "editing…" });
	await b.flush();
	const reader = new LiveActivityReader();
	assert.equal(await reader.read("stable", "launch"), undefined);
	a.stop();
	await a.closed();
	assert.equal((await reader.read("stable", "launch"))?.text, "editing…");
	assert.equal(await reader.read("stable", "old-launch"), undefined);
	const unbound = publisher("unbound", undefined);
	// The helper's default is launch; directly create a genuinely uncorrelated publisher.
	unbound.stop();
	await unbound.closed();
	const manual = new LiveActivityPublisher("manual");
	publishers.push(manual);
	manual.publish({ kind: "tools", text: "reading…" });
	await manual.flush();
	assert.equal(await reader.read("manual", "manual"), undefined);
});
test("pid reuse, unknown probe, malformed/oversized/generation-mismatched files fail closed", async () => {
	const p = publisher();
	p.publish({ kind: "tools", text: "reading…" });
	await p.flush();
	const path = join(liveSessionDir("stable"), `${p.generation}.json`);
	const original = JSON.parse(await readFile(path, "utf8"));
	const unknown = new LiveActivityReader(agentDir, async () => "unknown");
	assert.equal(await unknown.read("stable", "launch"), undefined);
	assert.ok((await readdir(liveSessionDir("stable"))).length > 0, "unknown is never cleanup evidence");
	await writeFile(path, JSON.stringify({ ...original, processStart: "not-current-process" }));
	assert.equal(await new LiveActivityReader().read("stable", "launch"), undefined);
	assert.deepEqual(await readdir(liveSessionDir("stable")), []);
	for (const content of [
		"null",
		"bad",
		"x".repeat(LIVE_MAX_BYTES + 1),
		JSON.stringify({ ...original, generation: randomUUID() }),
	]) {
		await writeFile(path, content);
		assert.equal(await new LiveActivityReader().read("stable", "launch"), undefined);
	}
});
test("directory work is bounded and corrupted storage cannot fail publishers or readers", async () => {
	const p = publisher();
	p.publish({ kind: "tools", text: "reading…" });
	await p.flush();
	for (let i = 0; i < 17; i++) await writeFile(join(liveSessionDir("stable"), `${randomUUID()}.json`), "bad");
	assert.equal(await new LiveActivityReader().read("stable", "launch"), undefined);
	const dir = liveSessionDir("broken");
	await mkdir(join(dir, ".."), { recursive: true });
	await writeFile(dir, "not a directory");
	const broken = publisher("broken");
	broken.publish({ kind: "tools", text: "reading…" });
	await broken.flush();
	assert.equal(await new LiveActivityReader().read("broken", "launch"), undefined);
});
test("stop during delayed rename drains old generation without resurrection or deleting successor", async () => {
	let release!: () => void;
	let entered!: () => void;
	const gate = new Promise<void>((r) => {
			release = r;
		}),
		ready = new Promise<void>((r) => {
			entered = r;
		});
	const old = publisher("race", "launch", {
		rename: async (a, b) => {
			entered();
			await gate;
			await rename(a, b);
		},
	});
	old.publish({ kind: "tools", text: "old" });
	const writing = old.flush();
	await ready;
	old.stop();
	const next = publisher("race");
	next.publish({ kind: "tools", text: "new" });
	await next.flush();
	release();
	await writing;
	await old.closed();
	assert.deepEqual(await readdir(liveSessionDir("race")), [`${next.generation}.json`]);
	assert.equal((await new LiveActivityReader().read("race", "launch"))?.text, "new");
	old.publish({ kind: "tools", text: "resurrect" });
	await old.flush();
	assert.equal((await new LiveActivityReader().read("race", "launch"))?.text, "new");
});
test("text publication coalesces to four writes per second and lifecycle clears bypass the delay", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
	let writes = 0;
	const p = publisher("throttle", "launch", {
		start: async () => "test-start",
		rename: async (a, b) => {
			writes++;
			await rename(a, b);
		},
	});
	p.publish({ kind: "tools", text: "initial" });
	await p.flush();
	for (let n = 0; n < 100; n++) p.publish({ kind: "response", text: String(n) }, false);
	t.mock.timers.tick(249);
	assert.equal(writes, 1, "token burst waits until the text budget");
	t.mock.timers.tick(1);
	await p.flush();
	assert.equal(writes, 2);
	const path = join(liveSessionDir("throttle"), `${p.generation}.json`);
	assert.equal(JSON.parse(await readFile(path, "utf8")).activity.text, "99");
	p.publish({ kind: "response", text: "would be delayed" }, false);
	p.publish(undefined, true);
	t.mock.timers.tick(0);
	await p.flush();
	assert.equal(writes, 3);
	assert.equal(JSON.parse(await readFile(path, "utf8")).activity, null);
});
test("unchanged locator tuples skip disk writes while fresh reads, changes, activity and new generations remain independent", async () => {
	let writes = 0;
	const p = publisher("locator-dedup", "launch", {
		rename: async (a, b) => {
			writes++;
			await rename(a, b);
		},
	});
	const pane: PaneLocator = {
		socket: "private",
		serverPid: 1,
		serverStarted: "1",
		paneId: "%1",
		windowId: "@1",
		windowName: "original",
		exited: false,
	};
	await mkdir(join(agentDir, "squire", "owners"), { recursive: true });
	const ownerPath = join(agentDir, "squire", "owners", "locator-dedup.json");
	await writeFile(ownerPath, JSON.stringify({ pid: process.pid, token: "owner" }));
	p.publish({ kind: "tools", text: "reading…" });
	await p.flush();
	p.publishLocator(pane, "owner", "/session");
	await p.flush();
	const path = join(liveSessionDir("locator-dedup"), `${p.generation}.json`);
	const initial = await readFile(path, "utf8");
	for (let n = 0; n < 10; n++) {
		p.publishLocator({ ...pane }, "owner", "/session");
		await p.flush();
	}
	assert.equal(writes, 2);
	assert.equal(await readFile(path, "utf8"), initial);
	const reader = new LiveActivityReader();
	assert.equal((await reader.locator("locator-dedup"))?.locator.windowName, "original");
	await writeFile(ownerPath, JSON.stringify({ pid: process.pid, token: "replacement" }));
	assert.equal(await reader.locator("locator-dedup"), undefined, "unchanged publication never caches owner liveness");
	await writeFile(ownerPath, JSON.stringify({ pid: process.pid, token: "owner" }));
	assert.equal((await reader.locator("locator-dedup"))?.generation, p.generation);
	// Changing a reused input object must not mutate the publisher's saved comparison state.
	pane.windowName = "renamed";
	p.publishLocator(pane, "owner", "/session");
	await p.flush();
	assert.equal(writes, 3);
	assert.equal((await reader.locator("locator-dedup"))?.locator.windowName, "renamed");
	pane.windowId = "@8";
	p.publishLocator(pane, "owner", "/session");
	await p.flush();
	assert.equal(writes, 4);
	assert.equal((await reader.locator("locator-dedup"))?.locator.windowId, "@8");
	p.publishLocator(undefined, "owner", "/session");
	await p.flush();
	assert.equal(writes, 5);
	assert.equal(await reader.locator("locator-dedup"), undefined);
	assert.equal((await reader.read("locator-dedup", "launch"))?.text, "reading…");
	p.publishLocator(undefined, "owner", "/session");
	await p.flush();
	assert.equal(writes, 5);
	p.publishLocator(undefined, "changed-token", "/session");
	await p.flush();
	assert.equal(writes, 6);
	p.publishLocator(undefined, "changed-token", "/changed-session");
	await p.flush();
	assert.equal(writes, 7);
	p.publish({ kind: "tools", text: "editing…" });
	await p.flush();
	assert.equal(writes, 8);
	p.publishLocator(undefined, "changed-token", "/changed-session");
	await p.flush();
	assert.equal(writes, 8);
	p.stop();
	await p.closed();
	p.publishLocator(pane, "owner", "/session");
	await p.flush();
	assert.equal(writes, 8);
	for (const id of ["locator-dedup", "new-session"]) {
		const next = publisher(id);
		next.publishLocator(undefined, "changed-token", "/changed-session");
		await next.flush();
		const value = JSON.parse(await readFile(join(liveSessionDir(id), `${next.generation}.json`), "utf8"));
		assert.equal(value.ownerToken, "changed-token");
		assert.equal(value.sessionFile, "/changed-session");
		assert.equal(value.activity, null);
		assert.notEqual(value.generation, p.generation);
	}
});

test("a failed locator write retries on the next unchanged observation without a retry loop", async () => {
	let attempts = 0;
	const p = publisher("locator-write-retry", "launch", {
		rename: async (a, b) => {
			if (++attempts === 1) throw Error("fail first locator write");
			await rename(a, b);
		},
	});
	const pane: PaneLocator = {
		socket: "private",
		serverPid: 1,
		serverStarted: "1",
		paneId: "%1",
		windowId: "@1",
		windowName: "retry",
		exited: false,
	};
	p.publishLocator(pane, "owner", "/session");
	await p.flush();
	assert.equal(attempts, 1, "failure does not schedule an autonomous retry");
	assert.deepEqual(await readdir(liveSessionDir("locator-write-retry")), []);
	p.publishLocator({ ...pane }, "owner", "/session"); // Next ordinary locator tick observes identical facts.
	await p.flush();
	assert.equal(attempts, 2, "unchanged locator must be eligible again after failed persistence");
	const path = join(liveSessionDir("locator-write-retry"), `${p.generation}.json`);
	const saved = JSON.parse(await readFile(path, "utf8"));
	assert.deepEqual(saved.locator, pane);
	assert.equal(saved.ownerToken, "owner");
	assert.equal(saved.sessionFile, "/session");
	p.publishLocator({ ...pane }, "owner", "/session");
	await p.flush();
	assert.equal(attempts, 2, "successful persistence restores unchanged-value suppression");
});

test("an older failed in-flight write preserves queued locator dedupe, and a failed latest write can retry", async () => {
	for (const failQueued of [false, true]) {
		let attempts = 0;
		let entered!: () => void, release!: () => void;
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const id = `locator-write-queued-${failQueued}`;
		const p = publisher(id, "launch", {
			rename: async (a, b) => {
				attempts++;
				if (attempts === 1) {
					entered();
					await gate;
					throw Error("old in-flight failure");
				}
				if (failQueued && attempts === 2) throw Error("queued locator failure");
				await rename(a, b);
			},
		});
		const pane: PaneLocator = {
			socket: "private",
			serverPid: 1,
			serverStarted: "1",
			paneId: "%1",
			windowId: "@1",
			windowName: "old",
			exited: false,
		};
		p.publishLocator(pane, "owner", "/session");
		const writing = p.flush();
		await ready;
		const newer = { ...pane, windowId: "@8", windowName: "newer" };
		p.publishLocator(newer, "owner", "/session");
		release();
		await writing;
		await p.flush(); // Persist the already-queued latest revision, without another observation.
		assert.equal(attempts, 2);
		p.publishLocator({ ...newer }, "owner", "/session");
		await p.flush();
		const expected = failQueued ? 3 : 2;
		assert.equal(attempts, expected, "only a failed latest snapshot invalidates its dedupe key");
		const saved = JSON.parse(await readFile(join(liveSessionDir(id), `${p.generation}.json`), "utf8"));
		assert.deepEqual(saved.locator, newer, "old failure cannot suppress or replace newer locator data");
		p.publishLocator({ ...newer }, "owner", "/session");
		await p.flush();
		assert.equal(attempts, expected);
	}
});

test("failed replacement removes its old snapshot without retry loops or task errors", async () => {
	let fail = false;
	const p = publisher("write-failure", "launch", {
		rename: async (a, b) => {
			if (fail) throw Error("disk failure");
			await rename(a, b);
		},
	});
	p.publish({ kind: "tools", text: "reading…" });
	await p.flush();
	assert.equal((await new LiveActivityReader().read("write-failure", "launch"))?.text, "reading…");
	fail = true;
	p.publish(undefined);
	await p.flush();
	assert.equal(await new LiveActivityReader().read("write-failure", "launch"), undefined);
});

test("startup probe failure is unavailable; early stop cancels delayed initialization", async () => {
	const missing = publisher("missing", "launch", { start: async () => undefined });
	missing.publish({ kind: "tools", text: "read" });
	await missing.flush();
	assert.equal(await new LiveActivityReader().read("missing", "launch"), undefined);
	let release!: (start: string | undefined) => void;
	const pending = publisher("pending", "launch", {
		start: () =>
			new Promise((r) => {
				release = r;
			}),
	});
	pending.publish({ kind: "tools", text: "read" });
	const writing = pending.flush();
	pending.stop();
	release(await processStart(process.pid));
	await writing;
	await pending.closed();
	assert.equal(await new LiveActivityReader().read("pending", "launch"), undefined);
});
