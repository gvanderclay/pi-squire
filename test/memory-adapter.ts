// Narrow in-memory conformance model over MemoryHost (test/memory-host.ts): no
// tmux sessions, commands, names as identity, placement policy or
// navigationVerbs copied from the real adapter. FakeTmux remains the richer
// tmux feature-test fixture for tmux-specific tests.
import { windowPresentation } from "../src/locators.ts";
import type { WindowRecord } from "../src/tmux.ts";
import type { AdapterContract, AdapterFixture } from "./adapter-contract.ts";
import { MemoryHost, type MemoryVariant } from "./memory-host.ts";

function fixture(variant: MemoryVariant): AdapterFixture {
	const host = new MemoryHost(variant);
	const target = (record: WindowRecord) => ({ windowId: windowPresentation(record).windowId, locator: record.locator });
	const adapter: AdapterContract = {
		async open(name) {
			const opened = await host.openWindow({ name, cwd: process.cwd(), argv: ["program"], env: {} }, "current", "");
			return { locator: opened.locator };
		},
		state: async (record) => (await host.states()).state(record),
		close: async (record) => (await host.states(true)).close(record),
		show: (record, verify) => host.show(target(record), verify),
		peek: (record) => host.peek(target(record)),
		unavailable: (checkVersion) => (checkVersion ? host.unavailable(true) : host.unavailable()),
	};
	const id = (record: WindowRecord): string => windowPresentation(record).windowId;
	return {
		adapter,
		host,
		...(variant === "pane-free" ? { viewer: false as const } : {}),
		async exit(record) {
			host.exit(record);
		},
		async replace(record) {
			// Same address, different identity: a stale record must not close it.
			const terminal = host.terminals.get(id(record));
			if (terminal) terminal.name = "replacement";
			return { locator: { ...(record.locator as object), name: "replacement" } };
		},
		failAsk(fail) {
			host.failAsk = fail;
		},
		ambiguousOpen() {
			host.failOpen = { message: "create answer lost", certainty: "unknown" };
		},
		async ambiguousSurvives() {
			return host.unconfirmed !== undefined && host.terminals.has(host.unconfirmed);
		},
		setUnavailable(value) {
			host.refusal = value ? "memory adapter unavailable" : undefined;
		},
		async isShown(record) {
			return host.shown !== undefined && host.shown === id(record);
		},
		async dispose() {
			host.terminals.clear();
		},
		spec: (name) => ({ name, cwd: process.cwd(), argv: [process.execPath, "worker"], env: {} }),
		openHost: (spec) => host.openWindow(spec, "current", "delegates"),
		async started(opened) {
			const start = host.started.find((entry) => entry.id === opened.id);
			if (!start) throw new Error(`memory host did not start ${opened.id}`);
			return { argv: start.argv, cwd: start.cwd, env: { ...start.env } };
		},
		failClose(fail) {
			host.failClose = fail;
		},
		...(variant === "terminal"
			? {
					async noViewer() {
						host.viewer = false;
					},
				}
			: {
					failConfigure(message: string) {
						host.failConfigure = message;
					},
				}),
	};
}

export async function memoryAdapter(): Promise<AdapterFixture> {
	return fixture("terminal");
}

/** A host with no viewer and no pane that configures each start after open, like an API host. */
export async function paneFreeMemoryAdapter(): Promise<AdapterFixture> {
	return fixture("pane-free");
}
