// Deterministic Rex wire fixture: exercises the production parser, identity,
// launch, companion receipt, cross-session observation and close paths, without
// touching any installed server or user UI. Sessions, labels, blocks, windows
// and clients are all scoped the way the installed server scopes them.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { DelegateHost, WindowSpec } from "../src/host.ts";
import { writeState } from "../src/local-state.ts";
import type { WindowRecord } from "../src/locator-rules.ts";
import { createRexClient, type RexContext, type RexRoute } from "../src/rex.ts";
import { createRexCompanions, type RexCompanions } from "../src/rex-companions.ts";
import { rexLocator } from "../src/rex-locator.ts";
import { processAlive } from "../src/tree-lock.ts";
import { askWindowStates } from "../src/window-state.ts";
import type { AdapterFixture } from "./adapter-contract.ts";

type Block = { block_id: string; window_id?: string; label: string; placement: string };
type WireWindow = { id: string; label: string };
type WireSession = {
	id: string;
	label: string;
	blocks: Map<string, Block>;
	windows: Map<string, WireWindow>;
	/** This session's server-side active window; the app's visible tab is separate. */
	active: string | undefined;
	/** This session's block query fails: its records are unknown, never gone. */
	failBlocks: boolean;
};

export type RexWireOptions = {
	server?: string;
	session?: string;
	block?: string;
	/** Receipt root; defaults to this Pi agent directory. */
	agentDir?: string;
};

export class RexWire {
	readonly context: RexContext;
	readonly agentDir: string;
	readonly sessions = new Map<string, WireSession>();
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
	/** The caller session's attached clients. */
	clients: unknown[] = [{ client_id: "client:app", info: { kind: "app" } }];
	/** Attached clients per session; a session with no entry has none. */
	readonly attached = new Map<string, unknown[]>();
	/** The app's visible tab, which server-side focus does not change. */
	visibleSession: string;
	visibleWindow: string | undefined;
	failSelect = false;
	/** The next `session.create` creates the session, then loses its acknowledgement. */
	lostCreateAck = false;
	/** `session.create` itself fails with this message. */
	failCreate: string | undefined;
	/** `window new` fails with this message before creating anything. */
	failWindowNew: string | undefined;
	/** Sessions whose window list fails. */
	readonly failWindows = new Set<string>();
	next = 1;
	beforeClose: (() => void) | undefined;
	/** Receipt write seam: a test can fail one exact commit. */
	writeState: (path: string, state: unknown) => void = writeState;
	alive: (pid: number) => boolean = processAlive;
	pid = process.pid;
	readonly companions: RexCompanions;
	readonly client: DelegateHost;
	constructor(options: RexWireOptions = {}) {
		this.agentDir = options.agentDir ?? getAgentDir();
		this.context = {
			server: options.server ?? "unix:///private/test-rex.sock",
			session: options.session ?? "session:test",
			block: options.block ?? "block:parent",
		};
		this.visibleSession = this.context.session;
		const caller = this.addSession("main", this.context.session);
		caller.blocks.set(this.context.block, {
			block_id: this.context.block,
			window_id: "window:main",
			label: "shell",
			placement: "placed",
		});
		caller.windows.set("window:main", { id: "window:main", label: "main" });
		caller.active = "window:main";
		this.visibleWindow = "window:main";
		const run = (route: RexRoute, args: string[]): Promise<string> => this.run(route, args);
		this.companions = createRexCompanions({
			run,
			agentDir: () => this.agentDir,
			alive: (pid) => this.alive(pid),
			pid: () => this.pid,
			write: (path, state) => this.writeState(path, state),
		});
		this.client = createRexClient({
			run,
			context: () => (this.unavailable ? undefined : this.context),
			companions: this.companions,
		});
	}
	/** The caller's own session. */
	get session(): WireSession {
		const own = this.sessions.get(this.context.session);
		if (!own) throw new Error("the caller session is missing");
		return own;
	}
	/** The caller session's blocks, for the single-session tests. */
	get blocks(): Map<string, Block> {
		return this.session.blocks;
	}
	get active(): string | undefined {
		return this.session.active;
	}
	set active(value: string | undefined) {
		this.session.active = value;
	}
	get visible(): string | undefined {
		return this.visibleWindow;
	}
	set visible(value: string | undefined) {
		this.visibleSession = this.context.session;
		this.visibleWindow = value;
	}
	addSession(label: string, id = `session:${++this.next}`): WireSession {
		const session: WireSession = {
			id,
			label,
			blocks: new Map(),
			windows: new Map(),
			active: undefined,
			failBlocks: false,
		};
		this.sessions.set(id, session);
		return session;
	}
	removeSession(id: string): void {
		this.sessions.delete(id);
	}
	/** The sessions a companion base could see, in creation order. */
	sessionList(): { session_id: string; label: string }[] {
		return [...this.sessions.values()].map(({ id, label }) => ({ session_id: id, label }));
	}
	receipts(base: string): { session: string; createdLabel: string }[] {
		return this.companions.receipts({ server: this.context.server }, base);
	}
	/** A session's windows: the ones it was created with, plus any a block was moved into. */
	windowsOf(session: WireSession): WireWindow[] {
		const found = new Map(session.windows);
		for (const block of session.blocks.values())
			if (block.window_id !== undefined && !found.has(block.window_id))
				found.set(block.window_id, { id: block.window_id, label: block.window_id });
		return [...found.values()];
	}
	attachedFor(session: string): unknown[] {
		return this.attached.get(session) ?? (session === this.context.session ? this.clients : []);
	}
	async run(route: RexRoute, args: string[]): Promise<string> {
		this.calls.push({ server: route.server, args });
		if (route.server !== this.context.server) throw new Error("unscoped Rex call");
		if (this.failedAsk) throw new Error("server unavailable");
		const target = (): WireSession => {
			const id = args[args.indexOf("-s") + 1];
			const session = this.sessions.get(id ?? "");
			if (!session) throw new Error("session_not_found");
			return session;
		};
		const group = args.slice(0, 2).join(" ");
		if (args[0] === "whoami")
			return JSON.stringify({ endpoint: this.endpoint ?? this.context.server, api_revision: this.revision });
		if (group === "api call") {
			const method = args[2];
			if (method === "session.list") return JSON.stringify({ sessions: this.sessionList() });
			if (method === "session.create") {
				if (this.failCreate !== undefined) throw new Error(this.failCreate);
				const input = JSON.parse(args[3] ?? "{}") as { label?: string };
				// An empty create adds no window and no block.
				const session = this.addSession(input.label ?? "quiet-meadow");
				if (this.lostCreateAck) throw new Error("create reply lost");
				return JSON.stringify({ session_id: session.id });
			}
			throw new Error(`unhandled Rex API method ${method}`);
		}
		if (group === "block ls") {
			const session = target();
			if (session.failBlocks) throw new Error("session blocks unavailable");
			return JSON.stringify({ blocks: [...session.blocks.values()] });
		}
		if (group === "window ls") {
			const session = target();
			if (this.failWindows.has(session.id)) throw new Error("window query failed");
			const windows = this.windowsOf(session).map((window) => ({
				window_id: window.id,
				label: window.label,
				layers: [{ blocks: [...session.blocks.values()].filter((block) => block.window_id === window.id) }],
			}));
			return JSON.stringify({ session_id: session.id, active_window_id: session.active, windows });
		}
		if (group === "client ls") {
			const session = target();
			return JSON.stringify({ clients: this.attachedFor(session.id) });
		}
		if (group === "window new") {
			const session = target();
			if (this.failWindowNew !== undefined) throw new Error(this.failWindowNew);
			const id = ++this.next;
			const windowId = `window:${id}`;
			const block = { block_id: `block:${id}`, window_id: windowId, label: "shell", placement: "placed" };
			session.blocks.set(block.block_id, block);
			session.windows.set(windowId, { id: windowId, label: args[4] });
			if (this.ambiguous) {
				this.ambiguousBlock = block.block_id;
				throw new Error("create reply lost");
			}
			return JSON.stringify({ window_id: windowId, block_ids: [block.block_id], revision: id });
		}
		if (group === "block close") {
			const session = target();
			this.beforeClose?.();
			if (this.failClose) throw new Error("block close refused");
			if (!session.blocks.delete(args[4])) throw new Error(`block target "${args[4]}" not found`);
			return "";
		}
		if (args[0] === "-C" && args[2] === "do" && args[3] === "session.select") {
			if (this.failSelect) throw new Error("Remote Control is disabled");
			const session = this.sessions.get(args[4].replace("session_id=", ""));
			const window = args[5].replace("window_id=", "");
			if (!session) throw new Error("session_not_found");
			if (!this.windowsOf(session).some((entry) => entry.id === window)) throw new Error("window_not_found");
			this.visibleSession = session.id;
			this.visibleWindow = window;
			return "";
		}
		if (args[0] === "focus") {
			const session = target();
			session.active = session.blocks.get(args[3])?.window_id ?? session.active;
			return "";
		}
		if (args[0] === "capture") {
			target();
			return "SQUIRE-ADAPTER-SCREEN\n";
		}
		throw new Error(`unhandled Rex request ${args.join(" ")}`);
	}
	/** Whether the app currently shows the record's block in its own session. */
	isShown(record: WindowRecord): boolean {
		const own = rexLocator(record.locator);
		if (!own) return false;
		const block = this.sessions.get(own.session)?.blocks.get(own.block);
		return this.visibleSession === own.session && this.visibleWindow === block?.window_id;
	}
	/** Single-session convenience: opens in the caller's own session unless a test says otherwise. */
	async open(name: string, extra: Partial<WindowSpec> = {}): Promise<WindowRecord> {
		const opened = await this.client.openWindow(
			{ name, cwd: process.cwd(), argv: [process.execPath, "unused"], env: {}, ...extra },
			"current",
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
			const own = located(record);
			wire.sessions.get(own.session)?.blocks.delete(own.block);
		},
		async replace(record) {
			// Rex never reuses an id: whatever replaces a closed terminal is another block.
			const own = located(record);
			const session = wire.sessions.get(own.session);
			if (!session) throw new Error("missing Rex session");
			session.blocks.delete(own.block);
			const block = `${own.block}-replacement`;
			session.blocks.set(block, { block_id: block, window_id: own.window, label: "shell", placement: "placed" });
			return { locator: { ...own, block } };
		},
		failAsk: (fail) => {
			wire.failedAsk = fail;
		},
		ambiguousOpen: () => {
			wire.ambiguous = true;
		},
		ambiguousSurvives: async () =>
			!!wire.ambiguousBlock && [...wire.sessions.values()].some((session) => session.blocks.has(wire.ambiguousBlock!)),
		setUnavailable: (value) => {
			wire.unavailable = value;
		},
		isShown: async (record) => wire.isShown(record),
		async dispose() {
			wire.dispose();
		},
		host: wire.client,
		spec: (name) => ({ name, cwd: process.cwd(), argv: [process.execPath, "unused"], env: {} }),
		async openHost(spec) {
			const opened = await wire.client.openWindow(spec, "current", "unused-delegates");
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
