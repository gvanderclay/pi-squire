// Separate-process trust fixture. No model, tmux, provider files or user state.
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { writeIdentity } from "../src/identity.ts";
import { registerTrustControl } from "../src/trust-control.ts";
import { requestRootTrust } from "../src/trust-wire.ts";
import { prepareDirectory } from "../src/workspace.ts";

type Command = {
	type: string;
	role?: string;
	root?: string;
	requester?: string;
	directory?: string;
	expiresAt?: number;
	label?: string;
};
const agentDir = process.env.PI_CODING_AGENT_DIR!;
const handlers: Record<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]> = {};
const selections: ((label: string | undefined) => void)[] = [];
let controller = new AbortController();
let root = "";
let requester = "";
let ctx: ExtensionContext;
const send = (value: unknown): void => {
	process.send?.(value);
};
const fire = async (name: string): Promise<void> => {
	for (const handler of handlers[name] ?? []) await handler({}, ctx);
};
const pi = {
	on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
		(handlers[name] ??= []).push(handler);
	},
	events: createEventBus(),
} as unknown as ExtensionAPI;

async function start(command: Command): Promise<void> {
	root = command.root!;
	requester = command.requester!;
	ctx = {
		cwd: agentDir,
		hasUI: true,
		mode: "tui",
		signal: undefined,
		isIdle: () => false,
		isProjectTrusted: () => false,
		sessionManager: { getSessionId: () => (command.role === "root" ? root : requester) },
		ui: {
			notify: (message: string) => send({ type: "notice", message }),
			select: (title: string, _options: string[], opts?: { signal?: AbortSignal; timeout?: number }) => {
				send({ type: "prompt", title, timeout: opts?.timeout });
				opts?.signal?.addEventListener("abort", () => send({ type: "dismissed" }), { once: true });
				// Intentionally ignores abort to prove late UI completion is harmless.
				return new Promise<string | undefined>((resolve) => selections.push(resolve));
			},
		},
	} as unknown as ExtensionContext;
	if (command.role === "root") {
		delete process.env.PI_UNATTENDED;
		registerTrustControl(pi, () => undefined);
		await fire("session_start");
	} else {
		writeIdentity(requester, {
			parent: root,
			root,
			rootPlacement: "project-delegate-session",
			depth: 1,
			agent: "coordinator",
			chain: ["coordinator"],
			autoExit: true,
		});
	}
	send({ type: "ready" });
}

async function launch(command: Command): Promise<void> {
	controller = new AbortController();
	const id = randomUUID();
	try {
		const prepared = await prepareDirectory(
			{
				cwd: command.directory,
				signal: controller.signal,
				trust: (directory, key, signal) =>
					requestRootTrust(
						agentDir,
						root,
						{ directory, key, requester, chain: ["coordinator", "worker"] },
						signal,
						command.expiresAt,
					),
			},
			ctx,
			agentDir,
		);
		send({ type: "result", trusted: prepared.trusted, id });
	} catch (error) {
		send({ type: "failed", error: String(error), id });
	}
}
process.on("message", (command: Command) => {
	if (command.type === "init") start(command).catch((error) => send({ type: "fatal", error: String(error) }));
	if (command.type === "launch") launch(command).catch((error) => send({ type: "fatal", error: String(error) }));
	if (command.type === "cancel") controller.abort(new Error("fixture launch was aborted"));
	if (command.type === "answer") selections.shift()?.(command.label);
	if (command.type === "restart")
		fire("session_shutdown")
			.then(() => fire("session_start"))
			.then(() => send({ type: "ready" }))
			.catch((error) => send({ type: "fatal", error: String(error) }));
});
process.on("disconnect", () => {
	controller.abort();
	fire("session_shutdown").then(
		() => process.exit(0),
		() => process.exit(1),
	);
});
