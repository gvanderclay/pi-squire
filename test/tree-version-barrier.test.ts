import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Delegation } from "../src/results.ts";
import { windowPresentation } from "../src/tmux.ts";
import {
	claimTree,
	publishTreeRecords,
	readTree,
	readTreeDisplay,
	reserveTree,
	treeCounts,
	treePath,
	treeTransaction,
} from "../src/tree-registry.ts";
import type { TreeEntry, TreeIntent, TreeState } from "../src/tree-types.ts";
import { agentDir, cleanup, resetRoot } from "./harness.ts";
import { TreeProcess } from "./tree-process-harness.ts";

const ROOT = "released-parent";
const ID = "released-child";
type Fixture = { started: Delegation; tree: { version: number; root: string; entries: TreeEntry[] } };
type CloseEvidence = {
	error?: string;
	killed: string[];
	listCalls: number;
	live: string[];
	result?: { details: { complete: boolean; closed: boolean } };
};
type Completion = { completed?: boolean; error?: string; result?: CloseEvidence };
beforeEach(resetRoot);
after(cleanup);
function save(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value));
}
function raw(): TreeState {
	return JSON.parse(bytes());
}
function bytes(): string {
	return readFileSync(treePath(ROOT), "utf8");
}
function seed(): Fixture {
	const fixture: Fixture = JSON.parse(
		readFileSync(new URL("./fixtures/released-window-records.json", import.meta.url), "utf8"),
	);
	Object.assign(fixture.tree.entries[0], { gone: true, launch: { ...fixture.started } });
	save(treePath(ROOT), fixture.tree);
	// The exact-session owner is live: disappearance of the historical window
	// must not refund this manually reattached coordinator's concurrency charge.
	save(join(agentDir, "squire", "owners", `${ID}.json`), { pid: process.pid, token: "live-coordinator" });
	return fixture;
}
function intent(): TreeIntent {
	return {
		id: "another",
		sessionId: "another",
		identity: {
			parent: ROOT,
			root: ROOT,
			rootPlacement: "project-delegate-session",
			depth: 1,
			agent: "scout",
			chain: ["scout"],
			autoExit: false,
		},
	};
}
async function isolated(
	work: (old: TreeProcess, modern: TreeProcess, fixture: Fixture) => Promise<void>,
): Promise<void> {
	const fixture = seed();
	const old = new TreeProcess(agentDir, "./fixtures/tree-version-process.ts");
	const modern = new TreeProcess(agentDir, "./fixtures/tree-version-process.ts");
	try {
		await Promise.all([old.ready, modern.ready]);
		await work(old, modern, fixture);
	} finally {
		await Promise.all([old.kill(), modern.kill()]);
	}
}
function act<T = unknown>(
	actor: TreeProcess,
	op: string,
	released: boolean,
	args: Record<string, unknown> = {},
): Promise<T> {
	return actor.command<T>(op, { root: ROOT, id: ID, released, ...args });
}
function completion(actor: TreeProcess): Promise<Completion> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			actor.child.off("message", receive);
			reject(new Error("completion timed out"));
		}, 10000);
		function receive(reply: Completion): void {
			if (!reply.completed) return;
			clearTimeout(timer);
			actor.child.off("message", receive);
			resolve(reply);
		}
		actor.child.on("message", receive);
	});
}
async function queued(): Promise<void> {
	const deadline = Date.now() + 5000;
	while (readdirSync(`${treePath(ROOT)}.lock`).filter((name) => name.endsWith(".json")).length < 2) {
		if (Date.now() >= deadline) throw new Error("second actor did not contend on the shared lock");
		await delay(5);
	}
}
function charged(): void {
	const state = readTree(ROOT);
	assert.equal(state.entries[0].closed, undefined);
	assert.equal(windowPresentation(state.entries[0]).windowId, "@72");
	assert.deepEqual(treeCounts(state), { lifetime: 1, concurrent: 1 });
}
const live = [{ id: "@72", name: "reopened" }];

test("frozen released implementation reproduces the unsafe v1 historical publication and close (control)", async () => {
	await isolated(async (old, _modern, fixture) => {
		claimTree(ROOT, ID, live[0]);
		// Reproduce PR #156's original unsafe format, not a supported downgrade.
		const unsafe = raw();
		Object.assign(unsafe, { version: 1 });
		save(treePath(ROOT), unsafe);
		await act(old, "publish", true, { records: [fixture.started] });
		assert.equal(raw().entries[0].windowId, "@71", "old applyRecord resurrects stale routing");
		const close = await act<CloseEvidence>(old, "close", true, { windows: live });
		assert.equal(close.result?.details.closed, true, "old close wrongly confirms historical absence");
		assert.deepEqual(close.killed, []);
		assert.deepEqual(close.live, ["@72"], "actual reopened window remains alive");
		assert.deepEqual(treeCounts(readTree(ROOT)), { lifetime: 1, concurrent: 0 }, "control reproduces the bad refund");
	});
});

test("reattachment migrates to v2; every frozen released writer rejects before mutation or close side effects", async () => {
	await isolated(async (old, _modern, fixture) => {
		assert.equal((await act<{ version: number }>(old, "read", true)).version, 1, "real released reader accepts v1");
		claimTree(ROOT, ID, live[0]);
		assert.equal(raw().version, 2);
		const migrated = bytes();
		for (const op of [
			"read",
			"display",
			"publish",
			"reserve",
			"bind",
			"open",
			"dispatch",
			"finish",
			"fail",
			"claim",
			"downgrade",
			"reconcile",
		]) {
			await assert.rejects(
				act(old, op, true, { records: [fixture.started], intent: intent(), windows: live }),
				/invalid tree registry/,
			);
			assert.equal(bytes(), migrated, op);
		}
		const close = await act<CloseEvidence>(old, "close", true, { windows: live });
		assert.match(close.error ?? "", /invalid tree registry/);
		assert.equal(close.listCalls, 0);
		assert.deepEqual(close.killed, []);
		assert.deepEqual(close.live, ["@72"]);
		assert.equal(bytes(), migrated, "even closing fences must not be written");
		assert.equal(raw().entries[0].closing, undefined);
		assert.equal(raw().closes, undefined);
		charged();
		save(join(agentDir, "squire", "settings.json"), { maxConcurrentDelegates: 1 });
		assert.throws(() => reserveTree(intent()), /count 1, limit 1/);
		assert.equal(bytes(), migrated, "refused admission cannot rewrite accounting");
		publishTreeRecords(ROOT, ROOT, [fixture.started]);
		charged();
	});
});

test("legacy reads/projected restore are nonmutating; failed migration and downgrade attempts leave bytes unchanged", async () => {
	await isolated(async (old) => {
		const before = bytes();
		assert.equal(readTree(ROOT).version, 2);
		assert.equal(readTreeDisplay(ROOT).version, 2);
		assert.ok(readTree(ROOT).entries[0].launch?.locator);
		assert.equal(bytes(), before, "read projection must not publish a half migration");
		assert.throws(
			() =>
				treeTransaction(ROOT, () => {
					throw new Error("cancel before commit");
				}),
			/cancel/,
		);
		assert.equal(bytes(), before);
		const temporary = `${treePath(ROOT)}.${process.pid}.tmp`;
		mkdirSync(temporary);
		assert.throws(() => claimTree(ROOT, ID, live[0]), /EISDIR/);
		assert.equal(bytes(), before);
		rmSync(temporary, { recursive: true });
		assert.equal((await act<{ version: number }>(old, "read", true)).version, 1);
		claimTree(ROOT, ID, live[0]);
		const migrated = bytes();
		assert.throws(
			() =>
				treeTransaction(ROOT, (state) => {
					Object.assign(state, { version: 1 });
				}),
			/downgrade/,
		);
		assert.equal(bytes(), migrated);
		const unsupported = { ...raw(), version: 3 };
		save(treePath(ROOT), unsupported);
		const future = bytes();
		assert.throws(() => readTree(ROOT), /unsupported tree registry/);
		assert.throws(() => claimTree(ROOT, ID, live[0]), /unsupported tree registry/);
		assert.equal(bytes(), future);
	});
});

test("an old transaction already holding the shared mutex commits before migration without losing its facts", async () => {
	await isolated(async (old, modern) => {
		const release = join(agentDir, "release-old-write");
		const finished = completion(old);
		assert.equal(await act(old, "hold-write", true, { release }), "acquired");
		const claim = act(modern, "claim", false);
		void claim.catch(() => {});
		await queued();
		assert.equal(raw().version, 1);
		writeFileSync(release, "");
		assert.equal((await finished).error, undefined);
		await claim;
		assert.equal(raw().version, 2);
		assert.equal(raw().entries[0].requestId, "older-committed");
		charged();
	});
});

test("v2 and opaque identity publish in the same atomic rename; queued released publication rejects", async () => {
	await isolated(async (old, modern, fixture) => {
		const release = join(agentDir, "release-new-rename");
		const before = bytes();
		const finished = completion(modern);
		assert.equal(await act(modern, "stage-claim", false, { release }), "acquired");
		assert.equal(bytes(), before);
		const staged = JSON.parse(readFileSync(`${treePath(ROOT)}.${modern.child.pid}.tmp`, "utf8"));
		assert.equal(staged.version, 2);
		assert.equal(windowPresentation(staged.entries[0]).windowId, "@72");
		assert.equal("windowId" in staged.entries[0], false);
		const refused = assert.rejects(act(old, "publish", true, { records: [fixture.started] }), /invalid tree registry/);
		await queued();
		assert.equal(bytes(), before);
		writeFileSync(release, "");
		assert.equal((await finished).error, undefined);
		await refused;
		assert.equal(raw().version, 2);
		assert.equal(raw().entries[0].closing, undefined);
		charged();
	});
});

test("a crash before migration rename leaves complete readable v1, never locator-only state under v1", async () => {
	await isolated(async (old, modern, fixture) => {
		const before = bytes();
		await act(modern, "stage-claim", false, { release: join(agentDir, "never-release") });
		await modern.kill();
		assert.equal(bytes(), before);
		assert.equal((await act<{ version: number }>(old, "read", true)).version, 1);
		await act(old, "publish", true, { records: [fixture.started] });
		assert.equal(raw().version, 1);
		assert.equal(raw().entries[0].windowId, "@71");
		claimTree(ROOT, ID, live[0]);
		assert.equal(raw().version, 2);
		charged();
	});
});

test("released close fenced before migration cannot confirm absence or refund the reattached coordinator", async () => {
	await isolated(async (old, modern) => {
		const release = join(agentDir, "release-old-close");
		const finished = completion(old);
		assert.equal(await act(old, "close", true, { windows: live, gated: true, release }), "acquired");
		assert.equal(raw().version, 1);
		assert.equal(raw().entries[0].closing, true, "a legitimate pre-migration close fence is preserved");
		await act(modern, "claim", false);
		const migrated = bytes();
		writeFileSync(release, "");
		const close = (await finished).result;
		assert.equal(close?.result?.details.complete, false);
		assert.deepEqual(close?.killed, []);
		assert.deepEqual(close?.live, ["@72"]);
		assert.equal(bytes(), migrated);
		charged();
		const retry = await act<CloseEvidence>(modern, "close", false, { windows: live });
		assert.equal(retry.result?.details.complete, true);
		assert.deepEqual(retry.killed, ["@72"]);
		assert.deepEqual(treeCounts(readTree(ROOT)), { lifetime: 1, concurrent: 0 });
	});
});

test("released close already past revalidation cannot confirm/refund after migration, even when its old-window kill completes", async () => {
	await isolated(async (old, modern) => {
		const release = join(agentDir, "release-old-kill");
		const finished = completion(old);
		const windows = [{ id: "@71", name: "scout-released" }, ...live];
		assert.equal(await act(old, "close", true, { windows, gatedKill: true, release }), "acquired");
		await act(modern, "claim", false);
		const migrated = bytes();
		writeFileSync(release, "");
		const close = (await finished).result;
		assert.equal(close?.result?.details.complete, false);
		assert.deepEqual(close?.killed, ["@71"], "only its previously verified historical window was killed");
		assert.deepEqual(close?.live, ["@72"]);
		assert.equal(bytes(), migrated, "old confirmation and fence cleanup both reject v2");
		charged();
	});
});

test("released reconciliation with a pre-migration snapshot re-reads the version inside its write lock", async () => {
	await isolated(async (old, modern, fixture) => {
		// Reconcile only asks for windows for entries not yet marked gone.
		delete fixture.tree.entries[0].gone;
		save(treePath(ROOT), fixture.tree);
		const release = join(agentDir, "release-old-list");
		const finished = completion(old);
		assert.equal(await act(old, "reconcile", true, { windows: [], gated: true, release }), "acquired");
		await act(modern, "claim", false);
		const migrated = bytes();
		writeFileSync(release, "");
		assert.match((await finished).error ?? "", /invalid tree registry/);
		assert.equal(bytes(), migrated);
		charged();
	});
});
