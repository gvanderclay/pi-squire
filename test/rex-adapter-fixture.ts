// Deterministic Rex wire fixture: exercises the production parser, identity,
// launch and close paths, without touching any installed server or user UI.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { WindowSpec } from "../src/host.ts";
import type { WindowRecord } from "../src/locator-rules.ts";
import { createRexClient, type RexContext, type RexRoute } from "../src/rex.ts";
import { rexLocator } from "../src/rex-locator.ts";
import { askWindowStates } from "../src/window-state.ts";
import type { AdapterFixture } from "./adapter-contract.ts";

type Block = { block_id: string; window_id?: string; label: string; placement: string };
export class RexWire {
	readonly context: RexContext;
	constructor(server = "unix:///private/test-rex.sock", session = "session:test") {
		this.context = { server, session, block: "block:parent" };
	}
	readonly blocks = new Map<string, Block>([
		["block:parent", { block_id: "block:parent", window_id: "window:main", label: "shell", placement: "placed" }],
	]);
	readonly labels = new Map<string, string>([["window:main", "main"]]);
	readonly calls: { server: string; args: string[] }[] = [];
	readonly staged: string[] = [];
	failedAsk = false;
	/** When set, `block close` refuses after every identity check passed. */
	failClose = false;
	ambiguous = false;
	ambiguousBlock: string | undefined;
	unavailable = false;
	revision = 16;
	endpoint: string | undefined;
	clients: unknown[] = [{ client_id: "client:app", info: { kind: "app" } }];
	active = "window:main";
	next = 1;
	beforeClose: (() => void) | undefined;
	readonly client = createRexClient({
		run: (route, args) => this.run(route, args),
		context: () => (this.unavailable ? undefined : this.context),
	});
	async run(route: RexRoute, args: string[]): Promise<string> {
		this.calls.push({ server: route.server, args });
		if (route.server !== this.context.server) throw new Error("unscoped Rex call");
		if (this.failedAsk) throw new Error("server unavailable");
		const session = (): void => {
			if (args[args.indexOf("-s") + 1] !== this.context.session) throw new Error("session target not found");
		};
		const group = args.slice(0, 2).join(" ");
		if (args[0] === "whoami")
			return JSON.stringify({ endpoint: this.endpoint ?? this.context.server, api_revision: this.revision });
		if (group === "block ls") {
			session();
			return JSON.stringify({ blocks: [...this.blocks.values()] });
		}
		if (group === "window ls") {
			session();
			const windows = [...this.labels].map(([window_id, label]) => ({
				window_id,
				label,
				layers: [{ blocks: [...this.blocks.values()].filter((block) => block.window_id === window_id) }],
			}));
			return JSON.stringify({ session_id: this.context.session, active_window_id: this.active, windows });
		}
		if (group === "client ls") {
			session();
			return JSON.stringify({ clients: this.clients });
		}
		if (group === "window new") {
			session();
			const id = ++this.next;
			const block = { block_id: `block:${id}`, window_id: `window:${id}`, label: "shell", placement: "placed" };
			this.blocks.set(block.block_id, block);
			this.labels.set(block.window_id, args[4]);
			if (this.ambiguous) {
				this.ambiguousBlock = block.block_id;
				throw new Error("create reply lost");
			}
			return JSON.stringify({ window_id: block.window_id, block_ids: [block.block_id], revision: id });
		}
		if (group === "block close") {
			session();
			this.beforeClose?.();
			if (this.failClose) throw new Error("block close refused");
			if (!this.blocks.delete(args[4])) throw new Error(`block target "${args[4]}" not found`);
			return "";
		}
		if (args[0] === "focus") {
			session();
			this.active = this.blocks.get(args[3])?.window_id ?? this.active;
			return "";
		}
		if (args[0] === "capture") {
			session();
			return "SQUIRE-ADAPTER-SCREEN\n";
		}
		throw new Error(`unhandled Rex request ${args.join(" ")}`);
	}
	async open(name: string, extra: Partial<WindowSpec> = {}): Promise<WindowRecord> {
		const opened = await this.client.openWindow(
			{ name, cwd: process.cwd(), argv: [process.execPath, "unused"], env: {}, ...extra },
			"companion",
			"unused-delegates",
		);
		const own = rexLocator(opened.locator);
		if (!own) throw new Error("missing Rex locator");
		this.staged.push(dirname(own.launchFile));
		return { locator: own };
	}
	dispose(): void {
		for (const path of this.staged) rmSync(path, { recursive: true, force: true });
	}
}

export async function rexAdapter(): Promise<AdapterFixture> {
	const wire = new RexWire();
	const located = (record: WindowRecord) => {
		const own = rexLocator(record.locator);
		if (!own) throw new Error("invalid Rex record");
		return own;
	};
	return {
		adapter: {
			open: (name) => wire.open(name),
			state: async (record) => (await askWindowStates(wire.client)).state(record),
			close: async (record) => (await askWindowStates(wire.client)).close(record),
			show: (record, verify) => {
				const own = located(record);
				return wire.client.show({ windowId: own.window, paneId: own.block, locator: own }, verify);
			},
			peek: (record) => {
				const own = located(record);
				return wire.client.peek({ windowId: own.window, paneId: own.block, locator: own });
			},
			unavailable: wire.client.unavailable.bind(wire.client),
		},
		async exit(record) {
			// Rex closes a terminal whose program exits.
			wire.blocks.delete(located(record).block);
		},
		async replace(record) {
			// Rex never reuses an id: whatever replaces a closed terminal is another block.
			const own = located(record);
			wire.blocks.delete(own.block);
			const block = `${own.block}-replacement`;
			wire.blocks.set(block, { block_id: block, window_id: own.window, label: "shell", placement: "placed" });
			return { locator: { ...own, block } };
		},
		failAsk: (fail) => {
			wire.failedAsk = fail;
		},
		ambiguousOpen: () => {
			wire.ambiguous = true;
		},
		ambiguousSurvives: async () => !!wire.ambiguousBlock && wire.blocks.has(wire.ambiguousBlock),
		setUnavailable: (value) => {
			wire.unavailable = value;
		},
		isShown: async (record) => wire.active === wire.blocks.get(located(record).block)?.window_id,
		async dispose() {
			wire.dispose();
		},
		host: wire.client,
		spec: (name) => ({ name, cwd: process.cwd(), argv: [process.execPath, "unused"], env: {} }),
		async openHost(spec) {
			const opened = await wire.client.openWindow(spec, "companion", "unused-delegates");
			const own = rexLocator(opened.locator);
			if (!own) throw new Error("missing Rex locator");
			wire.staged.push(dirname(own.launchFile));
			return opened;
		},
		async started(opened) {
			// Rex starts node on the staged runner, which spawns exactly this argv/env/cwd.
			const own = rexLocator(opened.locator);
			if (!own) throw new Error("missing Rex locator");
			const line = readFileSync(own.launchFile, "utf8")
				.split("\n")
				.find((text) => text.startsWith("const spec = "));
			if (!line) throw new Error("Rex launch file has no spec");
			return JSON.parse(line.slice("const spec = ".length, -1));
		},
		failClose: (fail) => {
			wire.failClose = fail;
		},
		async noViewer() {
			wire.clients = [];
		},
		async exitRetained(record) {
			// The runner failed at once and published its exit; Rex keeps that terminal.
			writeFileSync(`${located(record).launchFile}.status`, JSON.stringify({ pid: 10, exit: 1 }));
		},
	};
}
