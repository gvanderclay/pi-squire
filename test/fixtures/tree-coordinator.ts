// Separate-process driver shared with subtree-close tests. No Pi session,
// provider mailbox or real tmux server is opened by this fixture.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { withTreeLock } from "../../src/tree-lock.ts";
import {
	bindTree,
	claimTree,
	dispatchTree,
	failedTree,
	finishTree,
	openedTree,
	type Reservation,
	readTree,
	reconcileTree,
	reserveTree,
	type TreeIntent,
	treeTransaction,
} from "../../src/tree-registry.ts";
import { FakeTmux } from "../fake-tmux.ts";

type Command = {
	key: number;
	op: string;
	root: string;
	intent?: TreeIntent;
	token?: Reservation;
	requestId?: string;
	windowId?: string;
	windows?: { id: string; name: string; exited: boolean; session: string }[];
	path?: string;
	unknown?: boolean;
};
const wait = new Int32Array(new SharedArrayBuffer(4));
process.on("message", (command: Command) => {
	void execute(command).then(
		(result) => process.send?.({ key: command.key, result }),
		(error: unknown) => process.send?.({ key: command.key, error: String(error) }),
	);
});
async function execute(command: Command): Promise<unknown> {
	const token = command.token ?? { root: command.root, id: command.intent?.id ?? "missing" };
	switch (command.op) {
		case "reserve":
			return reserveTree(command.intent!);
		case "dispatch":
			dispatchTree(token);
			return true;
		case "bind":
			bindTree(token, { requestId: command.requestId, windowName: command.windowId });
			return true;
		case "claim":
			claimTree(command.root, command.intent!.sessionId, { id: command.windowId!, name: command.requestId! });
			return true;
		case "open":
			openedTree(token, command.windowId!);
			return true;
		case "finish":
			finishTree(command.root, command.intent!.sessionId, [command.requestId!]);
			return true;
		case "fail":
			failedTree(token, !command.unknown);
			return true;
		case "read":
			return readTree(command.root);
		case "reconcile": {
			const tmux = new FakeTmux();
			tmux.listWindows = () =>
				command.unknown ? Promise.reject(new Error("unknown")) : Promise.resolve(command.windows ?? []);
			await reconcileTree(command.root, tmux);
			return readTree(command.root);
		}
		case "hold":
			return treeTransaction(command.root, () => {
				process.send?.({ key: command.key, acquired: true });
				Atomics.wait(wait, 0, 0, 30000);
				return true;
			});
		case "hold-ticket":
			return withTreeLock(command.path!, () => {
				process.send?.({ key: command.key, acquired: true });
				Atomics.wait(wait, 0, 0, 30000);
				return true;
			});
		case "write":
			mkdirSync(dirname(command.path!), { recursive: true });
			writeFileSync(command.path!, command.requestId!);
			return true;
		default:
			throw new Error(`unknown fixture operation ${command.op}`);
	}
}
process.send?.({ ready: true });
