// The shared test harness: a temporary agent directory, one fake Pi session
// with a real event bus, a `message:send` provider stub and the fake tmux.
// Tests drive the extension only through its registration function and watch
// the bus, the injected messages, the recorded entries and the fake tmux.

import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";

import register from "../src/index.ts";
import { FakeTmux } from "./fake-tmux.ts";
import { FakeUsage } from "./fake-usage.ts";

/** A throwaway root for this test file; `PI_CODING_AGENT_DIR` points inside it. */
export const root = mkdtempSync(join(tmpdir(), "delegate-test-"));
export const agentDir = join(root, "agent");
/** The session directory the fake `sessionManager` reports. */
export const sessionDir = join(agentDir, "sessions");
process.env.PI_CODING_AGENT_DIR = agentDir;
export const cleanup = () => rmSync(root, { recursive: true, force: true });

/** A frontmatter block and body, the way `AGENT.md` is written. */
export function agentFile(fields: Record<string, string>, body = "Do the task and report back."): string {
	const front = Object.entries(fields)
		.map(([key, value]) => `${key}: ${value}`)
		.join("\n");
	return `---\n${front}\n---\n\n${body}\n`;
}

/** Empty the roster and the session directory; the next write into either is the whole of it. */
export function resetRoot(): void {
	rmSync(join(agentDir, "agents"), { recursive: true, force: true });
	rmSync(sessionDir, { recursive: true, force: true });
	delete process.env.PI_DELEGATE_PARENT;
	delete process.env.PI_DELEGATE_AUTO_EXIT;
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

/** One tool result, the shape `execute` returns. */
export type ToolResult = { content: { type: string; text: string }[]; details: unknown };

/** One registered tool, as much of it as the tests drive. */
export type Tool = {
	name: string;
	description: string;
	parameters: unknown;
	execute: (toolCallId: string, params: never, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<ToolResult>;
};

/** The answers a scripted `ctx.ui` gives, one queue per dialog. */
export type UiAnswers = {
	select?: (string | undefined)[];
	editor?: (string | undefined)[];
	custom?: unknown[];
};

let counter = 0;

/** One custom entry, the shape `pi.appendEntry` writes and `getEntries` returns. */
export type Entry = { customType: string; data: Record<string, unknown> };

export type SessionOptions = {
	/** Whether `ctx.hasUI` is true. */
	hasUI?: boolean;
	/** This session's id, the parent address. */
	parent?: string;
	/** What the `message:send` provider stub answers. */
	send?: "envelope" | "error" | "none";
	/** Set `PI_DELEGATE_PARENT` before the extension registers, as inside a delegate. */
	parentEnv?: string;
	/** Set `PI_DELEGATE_AUTO_EXIT` before the extension registers, as the launch does. */
	autoExitEnv?: string;
	/** Custom entries the session already holds, as on a resume. */
	entries?: readonly Entry[];
	/** Answers `ctx.ui` gives, in order, one queue per dialog. An empty queue cancels. */
	ui?: UiAnswers;
	/** The tool names `pi.getAllTools()` reports once the session has started. */
	registeredTools?: readonly string[];
	/** Models, as `provider/id`, the fake registry reports no credentials for. Every other model is configured. */
	noCredentials?: readonly string[];
	/** Models only this session's registry also knows, on top of `FAKE_MODELS`. */
	extraModels?: readonly { provider: string; id: string; cost?: { input: number; output: number } }[];
	/** The fake usage client; a session without one gets a fake that reports no reading. */
	usage?: FakeUsage;
	/** Models ("provider/id") that count as logged in with OAuth; the rest use an API key. */
	oauth?: string[];
	/** Base URLs the fake registry reports per provider; none unless set. */
	providerBaseUrls?: Record<string, string>;
};

type ProviderResponse = { status: number; headers: Record<string, string> };

/** How an `error` run fails: the last assistant message's text, provider and model. */
export type RunFailure = {
	errorMessage: string;
	provider?: string;
	model?: string;
	/** Provider responses seen during the run, in order, fired as `after_provider_response`. */
	response?: ProviderResponse | ProviderResponse[];
};

/** The tools a fake session has unless a test says otherwise. */
export const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];

/** One fake Pi session running the extension under `parent`. */
export function session(options: SessionOptions = {}) {
	const parent = options.parent ?? `parent-${process.pid}-${++counter}`;
	const commands: Record<string, Command> = {};
	const handlers: Record<string, Handler[]> = {};
	const sent: { message: { customType: string; content: unknown; display?: boolean }; options: unknown }[] = [];
	/** Every `pi.sendUserMessage` call, with its options. */
	const userMessages: { text: string; options: unknown }[] = [];
	const entries: Entry[] = [...(options.entries ?? [])];
	const statuses: { key: string; text: string | undefined }[] = [];
	const notes: string[] = [];
	const warnings: string[] = [];
	const errors: string[] = [];
	const sendCalls: SendPayload[] = [];
	const tools: Record<string, Tool> = {};
	/** Every `ctx.ui.select` call, with what it showed. */
	const selects: { title: string; options: string[] }[] = [];
	/** Every `ctx.ui.editor` call, with what it pre-filled. */
	const editors: { title: string; prefill: string | undefined }[] = [];
	/** Every `ctx.ui.custom` factory, as passed. */
	const customs: unknown[] = [];
	const selectAnswers = [...(options.ui?.select ?? [])];
	const editorAnswers = [...(options.ui?.editor ?? [])];
	const customAnswers = [...(options.ui?.custom ?? [])];
	const events: EventBus = createEventBus();
	const models = [...FAKE_MODELS, ...(options.extraModels ?? [])];
	const registry = {
		getAll: () => models,
		getAvailable: () => models,
		find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
		hasConfiguredAuth: (model: { provider: string; id: string }) =>
			!(options.noCredentials ?? []).includes(`${model.provider}/${model.id}`),
		getApiKeyForProvider: async (provider: string) => `fake-key-${provider}`,
		isUsingOAuth: (model: { provider: string; id: string }) =>
			(options.oauth ?? []).includes(`${model.provider}/${model.id}`),
		getProvider: (provider: string) => {
			const baseUrl = options.providerBaseUrls?.[provider];
			return baseUrl === undefined ? undefined : { baseUrl };
		},
	};
	const tmux = new FakeTmux();
	const usage = options.usage ?? new FakeUsage();
	/** The current run's abort signal, as `ctx.signal` reports it; cleared when the run settles. */
	let signal: AbortSignal | undefined;
	/** How many times `ctx.shutdown()` was called. */
	let shutdowns = 0;
	/** Pi's action methods throw until the runtime binds, which is before `session_start`. */
	let bound = false;
	const registeredTools = options.registeredTools ?? DEFAULT_TOOLS;
	const pi = {
		getAllTools: () => {
			if (!bound)
				throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
			return registeredTools.map((name) => ({ name }));
		},
		events,
		on: (name: string, handler: Handler) => (handlers[name] ??= []).push(handler),
		registerCommand: (name: string, command: Command) => {
			commands[name] = command;
		},
		registerTool: (tool: Tool) => {
			tools[tool.name] = tool;
		},
		appendEntry: (customType: string, data: unknown) =>
			entries.push({ customType, data: data as Record<string, unknown> }),
		sendMessage: (message: { customType: string; content: unknown; display?: boolean }, opts: unknown) =>
			sent.push({ message, options: opts }),
		sendUserMessage: (text: string, opts: unknown) => {
			userMessages.push({ text, options: opts });
		},
	};
	const ctx = {
		cwd: root,
		hasUI: options.hasUI ?? true,
		modelRegistry: registry,
		get signal() {
			return signal;
		},
		shutdown: () => {
			shutdowns++;
		},
		sessionManager: {
			getSessionId: () => parent,
			getSessionDir: () => sessionDir,
			getEntries: () =>
				entries.map((entry, index) => ({
					type: "custom",
					id: `entry-${index}`,
					parentId: null,
					timestamp: "",
					...entry,
				})),
		},
		ui: {
			notify: (text: string, type?: string) =>
				(type === "warning" ? warnings : type === "error" ? errors : notes).push(text),
			setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
			select: async (title: string, options: string[]) => {
				selects.push({ title, options });
				return selectAnswers.shift();
			},
			editor: async (title: string, prefill?: string) => {
				editors.push({ title, prefill });
				return editorAnswers.shift();
			},
			custom: async (factory: unknown) => {
				customs.push(factory);
				return customAnswers.shift();
			},
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
	// The `message:scan` stub, also synchronous: when answering it marks the
	// payload scanned and emits the queued `message:inbound` replies, as a
	// claim of waiting mail would. Set `scan.answering` false for no provider.
	const scan = { answering: true, calls: 0, queue: [] as unknown[] };
	events.on("message:scan", (data) => {
		scan.calls++;
		if (!scan.answering) return;
		for (const inbound of scan.queue.splice(0)) events.emit("message:inbound", inbound);
		(data as { scanned?: boolean }).scanned = true;
	});
	if (options.parentEnv !== undefined) process.env.PI_DELEGATE_PARENT = options.parentEnv;
	if (options.autoExitEnv !== undefined) process.env.PI_DELEGATE_AUTO_EXIT = options.autoExitEnv;
	register(pi as never, tmux, usage);
	const fire = async (name: string, event: object = {}) => {
		for (const handler of handlers[name] ?? []) await handler({ type: name, ...event }, ctx);
	};
	let calls = 0;
	const callTool = (name: string, params: unknown): Promise<ToolResult> => {
		const tool = tools[name];
		if (tool === undefined) return Promise.reject(new Error(`no tool named ${name} is registered`));
		return tool.execute(`call-${++calls}`, params as never, undefined, undefined, ctx);
	};
	return {
		parent,
		tmux,
		usage,
		events,
		pi,
		sent,
		userMessages,
		entries,
		statuses,
		notes,
		warnings,
		errors,
		sendCalls,
		scan,
		selects,
		editors,
		customs,
		/** The commands the extension registered, if any. */
		commands: () => Object.keys(commands),
		/** The tools the extension registered, if any. */
		tools: () => Object.keys(tools),
		/** One registered tool's definition. */
		tool: (name: string) => tools[name],
		/** Call a tool the way Pi does, with this session's context. */
		toolCall: callTool,
		start: () => {
			bound = true;
			return fire("session_start", { reason: "startup" });
		},
		shutdown: () => fire("session_shutdown"),
		/** Fire any Pi event by name; every handler the extension registered runs with this session's context. */
		fire,
		/** How many times the extension asked Pi to shut down. */
		shutdowns: () => shutdowns,
		/** Type `/<name> <args>` for any command the extension registered. */
		command: (name: string, args = "") => commands[name].handler(args, ctx),
		/** Ask any registered command for argument completions. */
		completionsFor: async (name: string, prefix: string) =>
			(await commands[name].getArgumentCompletions?.(prefix)) as { value: string; label: string }[] | null,
		/** The user types `text` into this session. */
		type: (text: string) => fire("input", { text, source: "interactive" }),
		/**
		 * One run, from start to settle, ending as `end` says: `completed` with
		 * text, `aborted` mid-text, `stopped` during a tool call (an `error`
		 * message with the signal aborted, as Pi 0.99.1 does), or `error` (an API
		 * error, signal not aborted). Then the next event-loop turns run.
		 */
		run: async (end: "completed" | "aborted" | "stopped" | "error" = "completed", failure?: RunFailure) => {
			const controller = new AbortController();
			signal = controller.signal;
			const { response: _response, ...errorFields } = failure ?? {};
			await fire("agent_start");
			if (end === "error")
				for (const response of [failure?.response ?? []].flat()) await fire("after_provider_response", response);
			if (end === "aborted" || end === "stopped") controller.abort();
			const last =
				end === "completed"
					? { role: "assistant", content: [{ type: "text", text: "answer" }], stopReason: "stop" }
					: end === "aborted"
						? { role: "assistant", content: [{ type: "text", text: "part" }], stopReason: "aborted" }
						: {
								role: "assistant",
								content: [],
								stopReason: "error",
								errorMessage: "boom",
								...(end === "error" ? errorFields : undefined),
							};
			await fire("agent_end", { messages: [{ role: "user", content: "q" }, last] });
			signal = undefined;
			await fire("agent_settled");
			await new Promise((resolve) => setImmediate(resolve));
		},
		/** Type `/delegate <args>`. */
		delegate: (args: string) => commands.delegate.handler(args, ctx),
		/** Ask for completions after `/delegate `; the real call has no context. */
		completions: async (prefix: string) =>
			(await commands.delegate.getArgumentCompletions?.(prefix)) as { value: string; label: string }[] | null,
	};
}
