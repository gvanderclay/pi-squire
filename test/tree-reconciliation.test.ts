import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import {
	bindTree,
	claimTree,
	descendants,
	dispatchTree,
	finishTree,
	openedTree,
	readTree,
	reconcileTree,
	reserveTree,
	type TreeIntent,
	treeCounts,
	treeTransaction,
} from "../src/tree-registry.ts";
import { FakeTmux } from "./fake-tmux.ts";
import { agentDir, cleanup, resetRoot } from "./harness.ts";

const intent = (id: string, parent = "root", depth = 1): TreeIntent => ({
	id,
	sessionId: id,
	identity: {
		parent,
		root: "root",
		rootPlacement: "project-delegate-session",
		depth,
		agent: id,
		chain: [id],
		autoExit: false,
	},
});
beforeEach(resetRoot);
after(cleanup);

test("ambiguous opener loses response; child locates its own window and disappearance releases accounting", async () => {
	const token = reserveTree(intent("worker"));
	bindTree(token, { requestId: "task" });
	dispatchTree(token);
	claimTree("root", "worker", { id: "@9", name: "worker" });
	const tmux = new FakeTmux();
	tmux.addWindow("@9", "worker");
	await reconcileTree("root", tmux);
	assert.deepEqual(treeCounts(readTree("root")), { concurrent: 1, lifetime: 1 });
	tmux.windows.clear();
	await reconcileTree("root", tmux);
	await reconcileTree("root", tmux);
	assert.deepEqual(treeCounts(readTree("root")), { concurrent: 0, lifetime: 1 });
});

test("unresolved resume refusal describes uncertainty without prescribing a nonexistent repair action", () => {
	const previous = reserveTree(intent("worker"));
	dispatchTree(previous);
	assert.throws(
		() => reserveTree({ ...intent("resume"), sessionId: "worker" }),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /earlier launch whose outcome is unknown/);
			assert.match(error.message, /reservation remains charged/);
			assert.match(error.message, /start in a window or a terminal result/);
			assert.doesNotMatch(error.message, /reconcile it before/);
			return true;
		},
	);
	assert.deepEqual(treeCounts(readTree("root")), { concurrent: 1, lifetime: 1 });
});

test("fast worker finalization cannot be undone by later successful-open publication", () => {
	const token = reserveTree(intent("fast"));
	bindTree(token, { requestId: "task" });
	dispatchTree(token);
	finishTree("root", "fast", ["task"]);
	finishTree("root", "fast", ["task"]);
	openedTree(token, "@9");
	assert.deepEqual(treeCounts(readTree("root")), { concurrent: 0, lifetime: 1 });
});

test("reconciliation never judges a newly opened window using a stale listing", async () => {
	const first = reserveTree(intent("first"));
	bindTree(first, { windowName: "first" });
	dispatchTree(first);
	openedTree(first, "@1");
	const tmux = new FakeTmux();
	tmux.addWindow("@1", "first");
	tmux.listWindows = async () => {
		const second = reserveTree(intent("second"));
		bindTree(second, { windowName: "second" });
		dispatchTree(second);
		openedTree(second, "@2");
		return [{ id: "@1", name: "first", exited: false, session: "work" }];
	};
	await reconcileTree("root", tmux);
	assert.deepEqual(treeCounts(readTree("root")), { concurrent: 2, lifetime: 2 });
});

test("resume send/bind crash gap recovers from a unique frozen worker request", async () => {
	const token = reserveTree(intent("worker"));
	dispatchTree(token);
	openedTree(token, "@9");
	mkdirSync(join(agentDir, "squire", "task-replies"), { recursive: true });
	writeFileSync(
		join(agentDir, "squire", "task-replies", "worker.json"),
		JSON.stringify({
			parent: "root",
			requests: [{ id: "task" }],
			outbox: [{ ids: ["task"], status: "done", body: "answer" }],
		}),
	);
	await reconcileTree("root", new FakeTmux());
	assert.deepEqual(treeCounts(readTree("root")), { concurrent: 0, lifetime: 1 });
	assert.equal(readTree("root").entries[0].requestId, "task");
	assert.equal(JSON.stringify(readTree("root")).includes("answer"), false);
});

test("tree index resolves ancestry and shared closing fence covers both reserve and dispatch", () => {
	const coordinator = reserveTree(intent("coordinator"));
	dispatchTree(coordinator);
	openedTree(coordinator, "@1");
	const worker = reserveTree(intent("worker", "coordinator", 2));
	reserveTree(intent("other"));
	assert.deepEqual(
		descendants(readTree("root"), "coordinator").map((entry) => entry.id),
		["worker"],
	);
	treeTransaction("root", (state) => {
		state.entries[0].closing = true;
	});
	assert.throws(() => dispatchTree(worker), /no longer dispatchable/);
	assert.throws(() => reserveTree(intent("late", "coordinator", 2)), /closing/);
	assert.equal(readTree("root").entries[1].phase, "reserved");
});
