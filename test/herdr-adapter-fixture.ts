// Deterministic Herdr wire fixture: exercises the production parser, identity,
// launch and close paths, without touching any installed server or user UI.
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { createHerdrClient, type HerdrContext } from "../src/herdr.ts";
import { herdrLocator } from "../src/herdr-locator.ts";
import type { WindowRecord, WindowSpec } from "../src/tmux.ts";
import { askWindowStates } from "../src/window-state.ts";
import type { AdapterFixture } from "./adapter-contract.ts";

type Pane = {
	pane_id: string;
	tab_id: string;
	workspace_id: string;
	terminal_id: string;
	agent?: string | null;
	agent_session?: { source?: string; value?: string } | null;
};
export class HerdrWire {
	readonly context: HerdrContext = {
		session: "test-isolated",
		workspace: "w1",
		pane: "w1:p1",
		socket: "/private/test-herdr.sock",
	};
	readonly panes = new Map<string, Pane>([
		["w1:p1", { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", terminal_id: "parent" }],
	]);
	readonly tabs = new Map<string, string>([["w1:t1", "main"]]);
	readonly calls: { session: string; args: string[] }[] = [];
	snapshotFails = false;
	readonly staged: string[] = [];
	failedAsk = false;
	ambiguous = false;
	unavailable = false;
	protocol = 22;
	metadataFails = false;
	beforeMetadata: (() => void) | undefined;
	foreground: unknown[] = [{ pid: 10 }];
	shown = "w1:t1";
	next = 1;
	ambiguousPane: string | undefined;
	beforeSnapshot: (() => void) | undefined;
	beforeProcessInfo: (() => void) | undefined;
	readonly client = createHerdrClient({
		run: (session, args) => this.run(session, args),
		context: () => (this.unavailable ? undefined : this.context),
	});
	async run(session: string, args: string[]): Promise<string> {
		this.calls.push({ session, args });
		if (session !== this.context.session) throw new Error("unscoped Herdr call");
		if (this.failedAsk) throw new Error("server unavailable");
		const result = (value: unknown): string => JSON.stringify({ result: value });
		if (args[0] === "status")
			return JSON.stringify({
				running: true,
				compatible: true,
				endpoint_compatible: true,
				protocol: this.protocol,
				session,
				socket: this.context.socket,
			});
		if (args[0] === "api") {
			this.beforeSnapshot?.();
			if (this.snapshotFails) throw new Error("snapshot timed out");
			const tabs = [...this.tabs].map(([tab_id, label]) => ({ tab_id, label }));
			return result({ snapshot: { protocol: this.protocol, panes: [...this.panes.values()], tabs } });
		}
		if (args[0] === "tab" && args[1] === "create") {
			const id = ++this.next;
			const p = {
				pane_id: `w1:p${id}`,
				tab_id: `w1:t${id}`,
				workspace_id: this.context.workspace,
				terminal_id: `term_${id}`,
			};
			this.panes.set(p.pane_id, p);
			this.tabs.set(p.tab_id, args[args.indexOf("--label") + 1]);
			if (this.ambiguous) {
				this.ambiguousPane = p.pane_id;
				throw new Error("create reply lost");
			}
			return result({ root_pane: p, tab: { tab_id: p.tab_id, label: args[args.indexOf("--label") + 1] } });
		}
		if (args[0] === "tab" && args[1] === "focus") {
			this.shown = args[2];
			return result({});
		}
		if (args[0] === "pane" && args[1] === "get") return result({ pane: this.panes.get(args[2]) });
		if (args[1] === "process-info") {
			this.beforeProcessInfo?.();
			return result({ process_info: { pane_id: args[3], shell_pid: 10, foreground_processes: this.foreground } });
		}
		if (args[1] === "close") {
			this.panes.delete(args[2]);
			return result({});
		}
		if (args[1] === "report-metadata") {
			this.beforeMetadata?.();
			if (this.metadataFails) throw new Error("metadata unavailable");
			return "";
		}
		if (args[1] === "run") return result({});
		if (args[1] === "read") return "SQUIRE-ADAPTER-SCREEN";
		throw new Error(`unhandled Herdr request ${args.join(" ")}`);
	}
	async open(name: string, extra: Partial<WindowSpec> = {}): Promise<WindowRecord> {
		const opened = await this.client.openWindow(
			{ name, cwd: process.cwd(), argv: [process.execPath, "unused"], env: {}, ...extra },
			"companion",
			"unused-delegates",
		);
		const own = herdrLocator(opened.locator);
		if (!own) throw new Error("missing Herdr locator");
		this.staged.push(dirname(own.launchFile));
		return { locator: own };
	}
	dispose(): void {
		for (const path of this.staged) rmSync(path, { recursive: true, force: true });
	}
}
export async function herdrAdapter(): Promise<AdapterFixture> {
	const wire = new HerdrWire();
	return {
		adapter: {
			open: (name) => wire.open(name),
			state: async (record) => (await askWindowStates(wire.client)).state(record),
			close: async (record) => (await askWindowStates(wire.client)).close(record),
			show: (record, verify) => {
				const own = herdrLocator(record.locator);
				if (!own) throw new Error("invalid Herdr record");
				return wire.client.show({ windowId: own.tab, paneId: own.pane, locator: own }, verify);
			},
			peek: (record) => {
				const own = herdrLocator(record.locator);
				if (!own) throw new Error("invalid Herdr record");
				return wire.client.peek({ windowId: own.tab, paneId: own.pane, locator: own });
			},
			unavailable: wire.client.unavailable.bind(wire.client),
		},
		async exit(record) {
			const own = herdrLocator(record.locator);
			if (own) wire.panes.delete(own.pane);
		},
		async replace(record) {
			const own = herdrLocator(record.locator);
			if (!own) throw new Error("invalid record");
			const next = { ...own, terminal: `${own.terminal}-restored` };
			wire.panes.set(own.pane, {
				pane_id: own.pane,
				tab_id: own.tab,
				workspace_id: own.workspace,
				terminal_id: next.terminal,
			});
			return { locator: next };
		},
		failAsk: (fail) => {
			wire.failedAsk = fail;
		},
		ambiguousOpen: () => {
			wire.ambiguous = true;
		},
		ambiguousSurvives: async () => !!wire.ambiguousPane && wire.panes.has(wire.ambiguousPane),
		setUnavailable: (value) => {
			wire.unavailable = value;
		},
		isShown: async (record) => wire.shown === herdrLocator(record.locator)?.tab,
		async dispose() {
			wire.dispose();
		},
	};
}
