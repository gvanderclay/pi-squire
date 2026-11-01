import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type TreeIntent, type TreeState, treeCounts } from "../src/tree-registry.ts";
import { TreeProcess } from "./tree-process-harness.ts";

const intent = (id: string, parent = "coordinator-a", root = "root"): TreeIntent => ({
	id,
	sessionId: id,
	identity: {
		parent,
		root,
		rootPlacement: "project-delegate-session",
		depth: 2,
		agent: "worker",
		chain: ["coordinator", "worker"],
		autoExit: false,
	},
});
async function isolated(body: (dir: string, a: TreeProcess, b: TreeProcess) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "squire-tree-process-"));
	const a = new TreeProcess(dir),
		b = new TreeProcess(dir);
	try {
		await Promise.all([a.ready, b.ready]);
		await body(dir, a, b);
	} finally {
		await Promise.all([a.kill(), b.kill()]);
		rmSync(dir, { recursive: true, force: true });
	}
}
function settings(dir: string, values: Record<string, unknown>): void {
	mkdirSync(join(dir, "squire"), { recursive: true });
	writeFileSync(join(dir, "squire", "settings.json"), JSON.stringify({ maxDepth: 2, ...values }));
}

test("separate coordinators contend for the final slot at each cap", async () => {
	for (const cap of ["maxConcurrentDelegates", "maxDelegatesPerRoot"])
		await isolated(async (dir, a, b) => {
			settings(dir, { [cap]: 1 });
			const attempts = await Promise.allSettled([
				a.command("reserve", { root: "root", intent: intent("one") }),
				b.command("reserve", { root: "root", intent: intent("two", "coordinator-b") }),
			]);
			assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
			const refused = attempts.find((item) => item.status === "rejected");
			assert.match(String(refused?.status === "rejected" && refused.reason), new RegExp(`${cap}.*count 1, limit 1`));
			assert.deepEqual(treeCounts(await a.command<TreeState>("read", { root: "root" })), {
				concurrent: 1,
				lifetime: 1,
			});
		});
});

test("repeated independent-process races serialize reads and writes and isolate roots", async () => {
	await isolated(async (dir, a, b) => {
		settings(dir, { maxConcurrentDelegates: 1, maxDelegatesPerRoot: 1 });
		for (let round = 0; round < 20; round++) {
			const root = `root-${round}`;
			const result = await Promise.allSettled([
				a.command("reserve", { root, intent: intent("a", "coordinator-a", root) }),
				b.command("reserve", { root, intent: intent("b", "coordinator-b", root) }),
			]);
			assert.equal(result.filter((item) => item.status === "fulfilled").length, 1);
			assert.deepEqual(treeCounts(await a.command<TreeState>("read", { root })), { concurrent: 1, lifetime: 1 });
		}
	});
});

test("a paused live mutex owner cannot be evicted by lease expiry", async () => {
	await isolated(async (_dir, a, b) => {
		assert.equal(await a.command("hold", { root: "root" }), "acquired");
		await assert.rejects(b.command("reserve", { root: "root", intent: intent("b") }), /registry is busy/);
		assert.equal(a.child.signalCode, null);
		await a.kill();
		await b.command("reserve", { root: "root", intent: intent("after") });
		assert.deepEqual(treeCounts(await b.command<TreeState>("read", { root: "root" })), { concurrent: 1, lifetime: 1 });
	});
});

test("dead reservation refunds only pre-dispatch; ambiguous dispatch survives restart and later completion", async () => {
	await isolated(async (dir, a, b) => {
		settings(dir, { maxConcurrentDelegates: 1 });
		await a.command("reserve", { root: "root", intent: intent("pre") });
		await a.kill();
		await b.command("reconcile", { root: "root" });
		await b.command("reserve", { root: "root", intent: intent("unknown") });
		await b.command("bind", { root: "root", token: { root: "root", id: "unknown" }, requestId: "task" });
		await b.command("dispatch", { root: "root", token: { root: "root", id: "unknown" } });
		await b.kill();
		const restarted = new TreeProcess(dir);
		try {
			let state = await restarted.command<TreeState>("reconcile", { root: "root", windows: [] });
			assert.deepEqual(treeCounts(state), { concurrent: 1, lifetime: 1 });
			await assert.rejects(
				restarted.command("reserve", { root: "root", intent: intent("blocked") }),
				/count 1, limit 1/,
			);
			// Positive frozen-answer evidence, not a foreign mailbox or elapsed time.
			await restarted.command("write", {
				path: join(dir, "squire", "task-replies", "unknown.json"),
				requestId: JSON.stringify({
					parent: "coordinator-a",
					requests: [{ id: "task" }],
					outbox: [{ ids: ["task"], body: "done", status: "done" }],
				}),
			});
			state = await restarted.command<TreeState>("reconcile", { root: "root" });
			assert.deepEqual(treeCounts(state), { concurrent: 0, lifetime: 1 });
		} finally {
			await restarted.kill();
		}
	});
});

test("worker vanishes while coordinator/root are absent; concurrent reconciliation releases once", async () => {
	await isolated(async (dir, a, b) => {
		settings(dir, {});
		await a.command("reserve", { root: "root", intent: intent("worker") });
		await a.command("bind", { root: "root", token: { root: "root", id: "worker" }, windowId: "worker-name" });
		await a.command("dispatch", { root: "root", token: { root: "root", id: "worker" } });
		await a.command("open", { root: "root", token: { root: "root", id: "worker" }, windowId: "@41" });
		await a.kill();
		const unknown = await b.command<TreeState>("reconcile", { root: "root", unknown: true });
		assert.equal(treeCounts(unknown).concurrent, 1);
		const c = new TreeProcess(dir);
		try {
			await Promise.all([b.command("reconcile", { root: "root" }), c.command("reconcile", { root: "root" })]);
			const state = await b.command<TreeState>("read", { root: "root" });
			assert.deepEqual(treeCounts(state), { concurrent: 0, lifetime: 1 });
			assert.equal(state.entries[0].gone, true);
		} finally {
			await c.kill();
		}
	});
});

test("child startup resolves an ambiguous dead opener before disappearing", async () => {
	await isolated(async (dir, a, b) => {
		settings(dir, {});
		const launch = intent("worker");
		const token = await a.command("reserve", { root: "root", intent: launch });
		await a.command("dispatch", { root: "root", token });
		await a.kill();
		await b.command("claim", { root: "root", intent: launch, windowId: "@71", requestId: "worker-name" });
		await b.command("reconcile", {
			root: "root",
			windows: [{ id: "@71", name: "worker-name", exited: false, session: "work" }],
		});
		assert.deepEqual(treeCounts(await b.command<TreeState>("read", { root: "root" })), { concurrent: 1, lifetime: 1 });
		await b.command("reconcile", { root: "root", windows: [] });
		assert.deepEqual(treeCounts(await b.command<TreeState>("read", { root: "root" })), { concurrent: 0, lifetime: 1 });
	});
});

test("SIGKILL inside the mutex allows two reclaimers without unlinking a replacement owner", async () => {
	await isolated(async (dir, a, b) => {
		settings(dir, { maxConcurrentDelegates: 1 });
		assert.equal(await a.command("hold", { root: "root" }), "acquired");
		await a.kill();
		const c = new TreeProcess(dir);
		try {
			const attempts = await Promise.allSettled([
				b.command("reserve", { root: "root", intent: intent("b") }),
				c.command("reserve", { root: "root", intent: intent("c") }),
			]);
			assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
			assert.deepEqual(treeCounts(await b.command<TreeState>("read", { root: "root" })), {
				concurrent: 1,
				lifetime: 1,
			});
		} finally {
			await c.kill();
		}
	});
});
