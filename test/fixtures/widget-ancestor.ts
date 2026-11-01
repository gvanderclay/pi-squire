// Real Squire registration/owner lifecycle in separate processes; no model run.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesSessionOwner } from "../../src/session-owner.ts";
import { createTmuxClient, type TmuxClient } from "../../src/tmux.ts";
import { switchAncestor } from "../../src/widget-ancestors.ts";
import { LIVE_LAUNCH_ENV, LiveActivityReader } from "../../src/widget-live.ts";
import { FakeTmux } from "../fake-tmux.ts";
import { session } from "../harness.ts";

process.env.PI_CODING_AGENT_DIR = process.env.SQUIRE_TEST_AGENT_DIR;
delete process.env[LIVE_LAUNCH_ENV];
type Server = {
	ownPane: string;
	windows: { id: string; name: string; session: string; exited?: boolean }[];
	panes: { id: string; windowId: string; exited?: boolean }[];
	scope?: FakeTmux["scope"];
};
type Command = {
	key: number;
	op: string;
	session?: string;
	pane?: string;
	server?: Server;
	real?: boolean;
	target?: string;
	text?: string;
	launch?: string;
};
let instance: ReturnType<typeof session> | undefined;
let client: TmuxClient;
const fake = new FakeTmux();
const reader = new LiveActivityReader();
let token: string;
function restore(server: Server): void {
	fake.ownPane = server.ownPane;
	fake.windows.clear();
	fake.panes.clear();
	for (const window of server.windows) {
		fake.addWindow(window.id, window.name, window.session);
		if (window.exited) fake.exit(window.id);
	}
	for (const pane of server.panes) fake.panes.set(pane.id, pane);
	if (server.scope) fake.scope = server.scope;
	fake.parentSession = fake.windows.get(fake.panes.get(server.ownPane)?.windowId ?? "")?.session ?? "own";
	fake.clients.splice(0);
	fake.attachClient("fixture-client", 1);
}
function assertOwner(): void {
	if (!instance || !matchesSessionOwner(instance.parent, process.pid, token)) throw new Error("inactive fixture owner");
}
async function command(input: Command): Promise<unknown> {
	if (input.op === "boot") {
		if (input.server) restore(input.server);
		if (input.pane) process.env.TMUX_PANE = input.pane;
		client = input.real ? createTmuxClient({ timeoutMs: 1500 }) : fake;
		instance = session({ parent: input.session, tmux: client as FakeTmux, hasUI: false, mode: "json" });
		await instance.start();
		token = JSON.parse(
			readFileSync(
				join(process.env.SQUIRE_TEST_AGENT_DIR!, "squire", "owners", `${encodeURIComponent(instance.parent)}.json`),
				"utf8",
			),
		).token;
		return { shutdowns: instance.shutdowns(), entries: instance.entries, pid: process.pid };
	}
	if (input.op === "locator") return (await reader.locator(input.target!)) ?? null;
	if (input.op === "activity") return (await reader.read(input.target!, input.launch!)) ?? null;
	if (!instance) throw new Error("not booted");
	if (input.op === "fail-list") {
		fake.failList = input.text;
		return true;
	}
	if (input.op === "server") {
		restore(input.server!);
		return true;
	}
	if (input.op === "switch") {
		await switchAncestor(instance.context as unknown as ExtensionContext, input.target!, client, assertOwner, reader);
		return fake.switches;
	}
	if (input.op === "start-tool") {
		await instance.fire("tool_execution_start", { toolCallId: "call", toolName: "read", args: {} });
		return true;
	}
	if (input.op === "snapshot")
		return {
			switches: fake.switches,
			opened: fake.opened,
			killed: fake.killed,
			entries: instance.entries,
			errors: instance.errors,
			shutdowns: instance.shutdowns(),
		};
	if (input.op === "shutdown") {
		await instance.shutdown();
		return true;
	}
	throw new Error("unknown operation");
}
process.on("message", (input: Command) => {
	void command(input).then(
		(result) => process.send?.({ key: input.key, result }),
		(error: unknown) => process.send?.({ key: input.key, error: String(error) }),
	);
});
process.send?.({ ready: true });
