// Actual separate-process06 owners and released provider; no models/live sessions.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Identity } from "../src/identity.ts";
import type { Delegation } from "../src/results.ts";
import type { CloseResult } from "../src/tree-close.ts";
import { TreeProcess } from "./tree-process-harness.ts";

test("ancestor closes worker while its real coordinator owner is dead; same-id replacement processes cancellation first", async () => {
	const dir = mkdtempSync(join(tmpdir(), "squire-close-owner-"));
	const tree = new TreeProcess(dir);
	const root = new TreeProcess(dir, "./fixtures/session-owner.ts");
	const coordinator = new TreeProcess(dir, "./fixtures/session-owner.ts");
	let replacement: TreeProcess | undefined;
	const identity: Identity = {
		parent: "root",
		root: "root",
		rootPlacement: "fixture-delegate-session",
		depth: 1,
		agent: "coordinator",
		chain: ["coordinator"],
		autoExit: false,
	};
	const workerIdentity: Identity = {
		parent: "c",
		root: "root",
		rootPlacement: "fixture-delegate-session",
		depth: 2,
		agent: "worker",
		chain: ["coordinator", "worker"],
		autoExit: false,
	};
	const json = (path: string, value: unknown) => {
		mkdirSync(join(dir, path, ".."), { recursive: true });
		writeFileSync(join(dir, path), JSON.stringify(value));
	};
	const pendingFinals = (): { from: string; body: string }[] => {
		const inbox = join(dir, "mail-state", "pi-session-mail", "root", "new");
		try {
			return readdirSync(inbox).map((file) => JSON.parse(readFileSync(join(inbox, file), "utf8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	};
	try {
		mkdirSync(join(dir, "agents"), { recursive: true });
		writeFileSync(
			join(dir, "agents", "coordinator.md"),
			"---\nmodel: alpha/fast-model\nallow_nested_delegation: [worker]\nauto_exit: false\n---\nCoordinate.\n",
		);
		json("squire/settings.json", { maxDepth: 2 });
		json("squire/identity/c.json", identity);
		json("squire/identity/w.json", workerIdentity);
		const worker: Delegation = {
			id: "w",
			identity: workerIdentity,
			requestId: "task-w",
			windowId: "@w",
			windowName: "w",
			agent: "worker",
			model: "alpha/fast-model",
			thinking: "medium",
		};
		json("squire/child-tasks/c.json", { records: [worker], outcomes: [] });
		await root.command("boot", { session: "root" });
		await coordinator.command("boot", { session: "c" });
		const task = await root.command<{ envelope: { id: string } }>("request", { to: "c" });
		await coordinator.command("scan");
		assert.equal(JSON.parse(readFileSync(join(dir, "squire", "task-replies", "c.json"), "utf8")).requests.length, 1);
		await coordinator.kill(); // no dying-process hook can record its worker's cancellation
		for (const [id, own, parent, request] of [
			["c", identity, "root", task.envelope.id],
			["w", workerIdentity, "c", "task-w"],
		] as const) {
			const token = await tree.command("reserve", {
				root: "root",
				intent: { id, sessionId: id, identity: { ...own, parent } },
			});
			await tree.command("bind", { root: "root", token, windowId: id, requestId: request });
			await tree.command("dispatch", { root: "root", token });
			await tree.command("open", { root: "root", token, windowId: `@${id}` });
		}
		const closed = await tree.command<CloseResult>("close", {
			root: "root",
			actor: "root",
			id: "w",
			windows: [{ id: "@w", name: "w", exited: false, session: "shared" }],
		});
		assert.equal(closed.details.complete, true);
		assert.equal(
			JSON.parse(readFileSync(join(dir, "squire", "child-tasks", "c.json"), "utf8")).records[0].closed,
			undefined,
		);
		replacement = new TreeProcess(dir, "./fixtures/session-owner.ts");
		await replacement.command("boot", { session: "c" });
		const before = JSON.parse(readFileSync(join(dir, "squire", "child-tasks", "c.json"), "utf8"));
		assert.equal(before.records[0].closed, true);
		assert.equal(before.records[0].result, undefined);
		assert.equal(before.outcomes.length, 1);
		assert.match(before.outcomes[0].content, /canceled.*missing work/);
		assert.equal(pendingFinals().length, 0, "restoration alone cannot settle the task");
		await replacement.command("run");
		const after = JSON.parse(readFileSync(join(dir, "squire", "child-tasks", "c.json"), "utf8"));
		assert.equal(after.outcomes.length, 0, "non-stopped processing run acknowledges cancellation");
		assert.equal(pendingFinals().length, 1);
		assert.equal(pendingFinals()[0].from, "c");
		assert.equal(after.records[0].result, undefined, "no fabricated successful worker result");
	} finally {
		await Promise.all([tree.kill(), root.kill(), coordinator.kill(), replacement?.kill()]);
		rmSync(dir, { recursive: true, force: true });
	}
});
