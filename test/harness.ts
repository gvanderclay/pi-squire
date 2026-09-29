// The shared test harness: a temporary agent directory, one fake Pi session
// with a real event bus, a `message:send` provider stub and the fake tmux.
// Tests drive the extension only through its registration function and watch
// the bus, the injected messages, the recorded entries and the fake tmux.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";

import register from "../index.ts";
import { FakeTmux } from "./fake-tmux.ts";

/** A throwaway root for this test file; `PI_CODING_AGENT_DIR` points inside it. */
export const root = mkdtempSync(join(tmpdir(), "delegate-test-"));
export const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
export const cleanup = () => rmSync(root, { recursive: true, force: true });

/** A frontmatter block and body, the way `AGENT.md` is written. */
export function agentFile(fields: Record<string, string>, body = "Do the task and report back."): string {
	const front = Object.entries(fields)
		.map(([key, value]) => `${key}: ${value}`)
		.join("\n");
	return `---\n${front}\n---\n\n${body}\n`;
}

/** Empty the roster: the next `AGENT.md` write is the whole of it. */
export function resetAgents(): void {
	rmSync(join(agentDir, "agents"), { recursive: true, force: true });
	delete process.env.PI_DELEGATE_PARENT;
	delete process.env.PI_CODING_AGENT_SESSION_DIR;
}

/** Write `<agent dir>/agents/<name>/AGENT.md`. */
export function writeAgent(name: string, content: string): void {
	mkdirSync(join(agentDir, "agents", name), { recursive: true });
	writeFileSync(join(agentDir, "agents", name, "AGENT.md"), content);
}

/** The models the fake registry knows, as `provider/id` pairs. Never a real model. */
export const FAKE_MODELS = [
	{ provider: "alpha", id: "fast-model" },
	{ provider: "alpha", id: "deep-model" },
	{ provider: "beta", id: "other-model" },
];

export type SendPayload = { to: unknown; body: unknown; envelope?: { id?: unknown }; error?: string };
type Handler = (event: unknown, ctx: unknown) => unknown;
type Command = {
	description?: string;
	getArgumentCompletions?: (prefix: string) => unknown;
	handler: (args: string, ctx: unknown) => Promise<void>;
};

let counter = 0;

export type SessionOptions = {
	/** Whether `ctx.hasUI` is true. */
	hasUI?: boolean;
	/** This session's id, the parent address. */
	parent?: string;
	/** What the `message:send` provider stub answers. */
	send?: "envelope" | "error" | "none";
	/** Set `PI_DELEGATE_PARENT` before the extension registers, as inside a delegate. */
	parentEnv?: string;
};

/** One fake Pi session running the extension under `parent`. */
export function session(options: SessionOptions = {}) {
	const parent = options.parent ?? `parent-${process.pid}-${++counter}`;
	const commands: Record<string, Command> = {};
	const handlers: Record<string, Handler[]> = {};
	const sent: { message: { customType: string; content: unknown; display?: boolean }; options: unknown }[] = [];
	const entries: { customType: string; data: unknown }[] = [];
	const notes: string[] = [];
	const warnings: string[] = [];
	const errors: string[] = [];
	const sendCalls: SendPayload[] = [];
	const events: EventBus = createEventBus();
	const registry = {
		getAll: () => FAKE_MODELS,
		getAvailable: () => FAKE_MODELS,
		find: (provider: string, id: string) =>
			FAKE_MODELS.find((model) => model.provider === provider && model.id === id),
	};
	const tmux = new FakeTmux();
	const pi = {
		events,
		on: (name: string, handler: Handler) => (handlers[name] ??= []).push(handler),
		registerCommand: (name: string, command: Command) => {
			commands[name] = command;
		},
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
		sendMessage: (message: { customType: string; content: unknown; display?: boolean }, opts: unknown) =>
			sent.push({ message, options: opts }),
	};
	const ctx = {
		cwd: root,
		hasUI: options.hasUI ?? true,
		modelRegistry: registry,
		sessionManager: { getSessionId: () => parent, getSessionDir: () => join(agentDir, "sessions") },
		ui: {
			notify: (text: string, type?: string) =>
				(type === "warning" ? warnings : type === "error" ? errors : notes).push(text),
		},
	};
	// The provider stub runs synchronously on the same bus, as `mailbox` does.
	const mode = options.send ?? "envelope";
	events.on("message:send", (data) => {
		const payload = data as SendPayload;
		sendCalls.push(payload);
		if (mode === "envelope") payload.envelope = { id: randomUUID() };
		else if (mode === "error") payload.error = "mailbox: no active session has a mailbox address";
	});
	if (options.parentEnv !== undefined) process.env.PI_DELEGATE_PARENT = options.parentEnv;
	register(pi as never, tmux);
	const fire = async (name: string, event: object = {}) => {
		for (const handler of handlers[name] ?? []) await handler({ type: name, ...event }, ctx);
	};
	return {
		parent,
		tmux,
		events,
		pi,
		sent,
		entries,
		notes,
		warnings,
		errors,
		sendCalls,
		/** The commands the extension registered, if any. */
		commands: () => Object.keys(commands),
		start: () => fire("session_start", { reason: "startup" }),
		/** Type `/delegate <args>`. */
		delegate: (args: string) => commands.delegate.handler(args, ctx),
		/** Ask for completions after `/delegate `; the real call has no context. */
		completions: async (prefix: string) =>
			(await commands.delegate.getArgumentCompletions?.(prefix)) as { value: string; label: string }[] | null,
	};
}
