import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CloseResult } from "../src/tree-close.ts";
import { type TreeIntent, type TreeState, treeCounts } from "../src/tree-registry.ts";
import { TreeProcess } from "./tree-process-harness.ts";

const intent = (id: string, parent = "root", root = "root"): TreeIntent => ({
	id,
	sessionId: id,
	identity: {
		parent,
		root,
		rootPlacement: "fixture-delegate-session",
		depth: parent === root ? 1 : 2,
		agent: "worker",
		chain: ["worker"],
		autoExit: false,
	},
});
const window = (id: string, name: string) => ({ id, name, exited: false, session: "shared-companion" });
type Closed = CloseResult & { killed: string[] };
async function isolated(body: (a: TreeProcess, b: TreeProcess, dir: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "squire-close-process-"));
	const a = new TreeProcess(dir),
		b = new TreeProcess(dir);
	try {
		await Promise.all([a.ready, b.ready]);
		await body(a, b, dir);
	} finally {
		await Promise.all([a.kill(), b.kill()]);
		rmSync(dir, { recursive: true, force: true });
	}
}
async function start(a: TreeProcess, id: string, parent = "root"): Promise<void> {
	const token = await a.command("reserve", { root: "root", intent: intent(id, parent) });
	await a.command("bind", { root: "root", token, windowId: id, requestId: `task-${id}` });
	await a.command("dispatch", { root: "root", token });
	await a.command("open", { root: "root", token, windowId: `@${id}` });
}

test("separate-process close fences a reserved target's OWN dispatch and root close-all admission", async () => {
	await isolated(async (a, b) => {
		const own = intent("c");
		await a.command("reserve", { root: "root", intent: own });
		await b.command("fence", { root: "root", id: "c" });
		await assert.rejects(a.command("dispatch", { root: "root", token: { root: "root", id: "c" } }), /dispatchable/);
		let state = await b.command<TreeState>("read", { root: "root" });
		assert.equal(state.entries[0].phase, "not-started");
		assert.deepEqual(treeCounts(state), { concurrent: 0, lifetime: 0 });
		await b.command("close", { root: "root", id: "c" });
		await b.command("fence", { root: "root" });
		await assert.rejects(a.command("reserve", { root: "root", intent: intent("new") }), /closing/);
		await b.command("close", { root: "root" });
		await a.command("reserve", { root: "root", intent: intent("after") });
		state = await b.command<TreeState>("read", { root: "root" });
		assert.equal(state.closes?.length, 0);
	});
});

test("real concurrent reserve versus root close-all never lets a late direct child escape", async () => {
	await isolated(async (a, b) => {
		for (let n = 0; n < 15; n++) {
			const root = `root-${n}`;
			const results = await Promise.allSettled([
				a.command("reserve", { root, intent: intent("late", root, root) }),
				b.command("fence", { root }),
			]);
			assert.equal(results[1].status, "fulfilled");
			const state = await b.command<TreeState>("read", { root });
			if (results[0].status === "fulfilled") {
				assert.equal(state.entries[0].phase, "not-started");
				await assert.rejects(a.command("dispatch", { root, token: { root, id: "late" } }), /dispatchable/);
			} else assert.match(String(results[0].reason), /closing/);
		}
	});
});

test("dispatched unknown create remains charged/fenced after closer restart; late locator is explicitly closed", async () => {
	await isolated(async (a, b, dir) => {
		await start(a, "c");
		const token = await a.command("reserve", { root: "root", intent: intent("w", "c") });
		await a.command("bind", { root: "root", token, windowId: "w", requestId: "task-w" });
		await a.command("dispatch", { root: "root", token });
		const first = await b.command<Closed>("close", { root: "root", id: "c", windows: [window("@c", "c")] });
		assert.equal(first.details.complete, false);
		assert.equal(first.details.members.find((m) => m.id === "w")?.outcome, "pending");
		assert.deepEqual(treeCounts(await b.command<TreeState>("read", { root: "root" })), { concurrent: 1, lifetime: 2 });
		await assert.rejects(a.command("reserve", { root: "root", intent: intent("escape", "c") }), /closing/);
		await assert.rejects(
			a.command("reserve", { root: "root", intent: { ...intent("resume"), sessionId: "c", resumedFrom: "c" } }),
			/closing/,
		);
		await b.kill();
		const restarted = new TreeProcess(dir);
		try {
			const stillUnknown = await restarted.command<Closed>("close", { root: "root", id: "c", windows: [] });
			assert.equal(stillUnknown.details.complete, false, "absent server listing is not proof a dispatch cannot create");
			await a.command("open", { root: "root", token, windowId: "@w" });
			const final = await restarted.command<Closed>("close", { root: "root", id: "c", windows: [window("@w", "w")] });
			assert.equal(final.details.complete, true);
			assert.deepEqual(final.killed, ["@w"]);
			assert.deepEqual(treeCounts(await restarted.command<TreeState>("read", { root: "root" })), {
				concurrent: 0,
				lifetime: 2,
			});
		} finally {
			await restarted.kill();
		}
	});
});

test("IPC barrier holds close after fencing while another process completes an already-dispatched create", async () => {
	await isolated(async (a, b) => {
		await start(a, "c");
		const token = await a.command("reserve", { root: "root", intent: intent("w", "c") });
		await a.command("bind", { root: "root", token, windowId: "w" });
		await a.command("dispatch", { root: "root", token });
		const gated = new Promise<void>((resolve) => {
			const listen = (message: { closeGated?: boolean }) => {
				if (message.closeGated) {
					b.child.off("message", listen);
					resolve();
				}
			};
			b.child.on("message", listen);
		});
		const closing = b.command<Closed>("close", {
			root: "root",
			id: "c",
			gated: true,
			windows: [window("@c", "c"), window("@w", "w")],
		});
		await gated;
		await assert.rejects(a.command("reserve", { root: "root", intent: intent("late", "c") }), /closing/);
		await a.command("open", { root: "root", token, windowId: "@w" });
		await b.command("release-close", { root: "root" });
		const result = await closing;
		assert.equal(result.details.complete, true);
		assert.deepEqual(result.killed, ["@w", "@c"]);
	});
});

test("finished accounting without locator does not complete close; known no-start alone refunds", async () => {
	await isolated(async (a, b) => {
		const token = await a.command("reserve", { root: "root", intent: intent("fast") });
		await a.command("bind", { root: "root", token, requestId: "task-fast" });
		await a.command("dispatch", { root: "root", token });
		await a.command("finish", { root: "root", intent: intent("fast"), requestId: "task-fast" });
		const result = await b.command<Closed>("close", { root: "root", id: "fast" });
		assert.equal(result.details.complete, false);
		let state = await b.command<TreeState>("read", { root: "root" });
		assert.equal(state.entries[0].finished, true);
		assert.equal(state.entries[0].closed, undefined);
		assert.equal(state.entries[0].createPending, true);
		const failed = await a.command("reserve", { root: "root", intent: intent("known") });
		await a.command("dispatch", { root: "root", token: failed });
		await a.command("fail", { root: "root", token: failed });
		assert.equal((await b.command<Closed>("close", { root: "root", id: "known" })).details.complete, true);
		state = await b.command<TreeState>("read", { root: "root" });
		assert.equal(treeCounts(state).lifetime, 1);
	});
});

test("completed close fence supersedes only on valid new resume; failed reservation restores old fence", async () => {
	await isolated(async (a, b) => {
		await start(a, "c");
		await start(a, "w", "c");
		await b.command("close", { root: "root", id: "c", windows: [window("@c", "c"), window("@w", "w")] });
		const resume = { ...intent("again"), sessionId: "c", resumedFrom: "c" };
		const token = await a.command("reserve", { root: "root", intent: resume });
		await a.command("fail", { root: "root", token });
		await assert.rejects(a.command("reserve", { root: "root", intent: intent("escape", "c") }), /closing/);
		const good = await a.command("reserve", { root: "root", intent: { ...resume, id: "success" } });
		await a.command("bind", { root: "root", token: good, windowId: "c-again" });
		await a.command("dispatch", { root: "root", token: good });
		await a.command("open", { root: "root", token: good, windowId: "@again" });
		await a.command("reserve", { root: "root", intent: intent("new-worker", "c") });
		await assert.rejects(a.command("reserve", { root: "root", intent: { ...resume, id: "obsolete" } }), /obsolete/);
		const state = await b.command<TreeState>("read", { root: "root" });
		assert.equal(state.entries.find((e) => e.id === "w")?.closed, true);
		assert.equal(state.entries.find((e) => e.id === "success")?.closing, undefined);
		assert.equal(treeCounts(state).lifetime, 4);
	});
});
