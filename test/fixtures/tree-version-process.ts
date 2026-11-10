// Separate old/new actors over one registry path and the same production mutex.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import type { Recorded } from "../../src/results.ts";
import { windowLocator } from "../../src/tmux.ts";
import { closeTree as currentClose } from "../../src/tree-close.ts";
import * as current from "../../src/tree-registry.ts";
import type { Reservation, TreeIntent } from "../../src/tree-types.ts";
import { FakeTmux } from "../fake-tmux.ts";

// Dynamic URLs load immutable JavaScript snapshots, not current typed adapters.
const released: typeof current = await import(new URL("./released-v1/tree-registry.mjs", import.meta.url).href);
const releasedClose: typeof currentClose = (await import(new URL("./released-v1/tree-close.mjs", import.meta.url).href))
	.closeTree;
type Command = {
	key: number;
	op: string;
	root: string;
	id: string;
	released?: boolean;
	records: Recorded[];
	intent: TreeIntent;
	windows?: { id: string; name: string }[];
	gated?: boolean;
	gatedKill?: boolean;
	release: string;
};
const pause: Int32Array = new Int32Array(new SharedArrayBuffer(4));
function waitForFile(path: string): void {
	const deadline: number = Date.now() + 10000;
	while (!fs.existsSync(path)) {
		if (Date.now() >= deadline) throw new Error("fixture release timed out");
		Atomics.wait(pause, 0, 0, 5);
	}
}
async function listGate(command: Command): Promise<void> {
	process.send?.({ key: command.key, acquired: true });
	const deadline: number = Date.now() + 10000;
	while (!fs.existsSync(command.release)) {
		if (Date.now() >= deadline) throw new Error("fixture list release timed out");
		await delay(5);
	}
}
function fake(command: Command): FakeTmux {
	const tmux = new FakeTmux();
	for (const item of command.windows ?? []) tmux.addWindow(item.id, item.name);
	if (command.gated) {
		const list = tmux.listWindows.bind(tmux);
		tmux.listWindows = async () => {
			await listGate(command);
			return list();
		};
	}
	if (command.gatedKill) {
		const kill = tmux.kill.bind(tmux);
		tmux.kill = async (id: string): Promise<void> => {
			await listGate(command);
			await kill(id);
		};
	}
	return tmux;
}
function stageClaim(command: Command): void {
	// Gate the actual atomic rename while the production registry lock is held.
	const rename = fs.renameSync;
	fs.renameSync = (from, to): void => {
		if (to === current.treePath(command.root)) {
			process.send?.({ key: command.key, acquired: true, temporary: from });
			waitForFile(command.release);
		}
		rename(from, to);
	};
	syncBuiltinESMExports();
	try {
		current.claimTree(command.root, command.id, { id: "@72", name: "reopened" });
	} finally {
		fs.renameSync = rename;
		syncBuiltinESMExports();
	}
}
async function close(command: Command): Promise<object> {
	const tmux: FakeTmux = fake(command);
	try {
		const result = await (command.released ? releasedClose : currentClose)({
			root: command.root,
			actor: command.root,
			id: command.id,
			tmux,
			assertActive: () => {},
		});
		return { result, killed: tmux.killed, listCalls: tmux.listCalls, live: [...tmux.windows.keys()] };
	} catch (error) {
		return { error: String(error), killed: tmux.killed, listCalls: tmux.listCalls, live: [...tmux.windows.keys()] };
	}
}
async function execute(command: Command): Promise<unknown> {
	const api: typeof current = command.released ? released : current;
	const token = { root: command.root, id: command.id };
	switch (command.op) {
		case "read":
			return api.readTree(command.root);
		case "display":
			return api.readTreeDisplay(command.root);
		case "publish":
			return api.publishTreeRecords(command.root, command.root, command.records);
		case "reserve":
			return api.reserveTree(command.intent);
		case "bind":
			return api.bindTree(token, { requestId: "stale-request" });
		case "open":
			return command.released
				? (released.openedTree as unknown as (token: Reservation, id: string) => void)(token, "@99")
				: current.openedTree(token, windowLocator({ id: "@99", name: "stale" }));
		case "dispatch":
			return api.dispatchTree(token);
		case "finish":
			return api.finishTree(command.root, command.id, ["released-request"]);
		case "fail":
			return api.failedTree(token);
		case "claim":
			return api.claimTree(command.root, command.id, { id: "@72", name: "reopened" });
		case "downgrade":
			return api.treeTransaction(command.root, (state) => {
				Object.assign(state, { version: 1 });
			});
		case "reconcile":
			return api.reconcileTree(command.root, fake(command));
		case "hold-write":
			return api.treeTransaction(command.root, (state) => {
				process.send?.({ key: command.key, acquired: true });
				waitForFile(command.release);
				state.entries[0].requestId = "older-committed";
			});
		case "stage-claim":
			return stageClaim(command);
		case "close":
			return close(command);
		default:
			throw new Error("unknown fixture operation");
	}
}
process.on("message", (command: Command) => {
	void execute(command).then(
		(result) => process.send?.({ key: command.key, result, completed: true }),
		(error: unknown) => process.send?.({ key: command.key, error: String(error), completed: true }),
	);
});
process.send?.({ ready: true });
