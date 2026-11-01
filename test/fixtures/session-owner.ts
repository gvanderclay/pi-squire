// Actual released provider, isolated roots, fake Pi lifecycle only. Uses the
// tree-process IPC protocol so tests can pause a live owner outside a lock.
import { join } from "node:path";
import { readIdentity } from "../../src/identity.ts";
import type { TmuxWindow } from "../../src/tmux.ts";
import { mailSession, scan } from "../mail-harness.ts";

process.env.PI_CODING_AGENT_DIR = process.env.SQUIRE_TEST_AGENT_DIR;
process.env.XDG_STATE_HOME = join(process.env.SQUIRE_TEST_AGENT_DIR!, "mail-state");
type Instance = ReturnType<typeof mailSession>;
let instance: Instance | undefined;
let release: (() => void) | undefined;
type Server = { windows: TmuxWindow[]; companions: string[]; parentSession: string };
type Command = {
	key: number;
	op: string;
	session?: string;
	last?: boolean;
	gated?: boolean;
	to?: string;
	reply?: string;
	cwd?: string;
	sessionDir?: string;
	stateHome?: string;
	server?: Server;
	tool?: string;
	params?: Record<string, unknown>;
};
process.on("message", (input: Command) => {
	void execute(input).then(
		(result) => process.send?.({ key: input.key, result }),
		(error: unknown) => process.send?.({ key: input.key, error: String(error) }),
	);
});
async function execute(input: Command): Promise<unknown> {
	if (input.op === "boot") {
		for (const key of Object.keys(process.env)) if (key.startsWith("PI_DELEGATE_")) delete process.env[key];
		if (input.stateHome) process.env.XDG_STATE_HOME = input.stateHome;
		instance = mailSession({
			parent: input.session,
			cwd: input.cwd,
			sessionDir: input.sessionDir,
			hasUI: false,
			mailProviderLast: input.last,
			beforeSquire: (pi) => {
				if (input.gated)
					pi.on(
						"session_start",
						() =>
							new Promise<void>((resolve) => {
								release = resolve;
								process.send?.({ key: 0, gated: true });
							}),
					);
			},
		});
		if (input.server) restoreServer(input.server);
		await instance.start();
		return snapshot();
	}
	if (input.op === "release") {
		release?.();
		return true;
	}
	if (!instance) throw new Error("not booted");
	if (input.op === "scan") {
		scan(instance);
		return snapshot();
	}
	if (input.op === "snapshot") return snapshot();
	if (input.op === "tool") {
		if (input.server) restoreServer(input.server);
		const result = await instance.toolCall(input.tool!, input.params);
		return { ...snapshot(), result };
	}
	if (input.op === "fail-injection") {
		instance.pi.sendMessage = () => {
			throw new Error("injected display failure");
		};
		return true;
	}
	if (input.op === "run") {
		await instance.run();
		return snapshot();
	}
	if (input.op === "shutdown") {
		await instance.shutdown();
		return true;
	}
	if (input.op === "request") {
		const payload = { to: input.to, body: "coordinator task" };
		instance.events.emit("message:send", payload);
		return payload;
	}
	if (input.op === "reply") {
		const payload = { to: input.to, inReplyTo: [input.reply], body: "worker report", status: "done" };
		instance.events.emit("message:reply", payload);
		return payload;
	}
	throw new Error("unknown operation");
}
function restoreServer(server: Server): void {
	if (!instance) throw new Error("not booted");
	instance.tmux.windows.clear();
	for (const window of server.windows) {
		instance.tmux.addWindow(window.id, window.name, window.session);
		if (window.exited) instance.tmux.exit(window.id);
	}
	instance.tmux.companions.clear();
	for (const name of server.companions) instance.tmux.companions.add(name);
	instance.tmux.parentSession = server.parentSession;
}
function snapshot() {
	return {
		sent: instance?.sent,
		prompts: instance?.userMessages,
		entries: instance?.entries,
		errors: instance?.errors,
		shutdowns: instance?.shutdowns(),
		identity: instance ? readIdentity(instance.parent) : undefined,
		opened: instance?.tmux.opened,
		killed: instance?.tmux.killed,
		windows: instance ? [...instance.tmux.windows].map(([id, window]) => ({ id, ...window })) : [],
		companions: instance ? [...instance.tmux.companions] : [],
		selects: instance?.selects,
		delegateEnv: Object.keys(process.env).filter((key) => key.startsWith("PI_DELEGATE_")),
	};
}
process.send?.({ ready: true });
