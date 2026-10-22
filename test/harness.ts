// The shared test harness: a temporary agent directory, one fake Pi session
// with a real event bus, a `message:send` provider stub and the fake tmux.
// Tests drive the extension only through its registration function and watch
// the bus, the injected messages, the recorded entries and the fake tmux.

import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";

import type { TSchema } from "typebox";
import { Value } from "typebox/value";

import register from "../src/index.ts";
import { FakeTmux } from "./fake-tmux.ts";
import { FakeUsage } from "./fake-usage.ts";

/** A throwaway root for this test file; `PI_CODING_AGENT_DIR` points inside it. */
export const root = mkdtempSync(join(tmpdir(), "delegate-test-"));
export const agentDir = join(root, "agent");
/** The roster's directory, `<agent dir>/squire/agents`. */
export const rosterDir = join(agentDir, "squire", "agents");
/** The retired roster directory, kept only so tests can write a fixture there. */
const legacyRosterDir = join(agentDir, "agents");
/** The optional parent guidance file. */
export const delegationPromptPath = join(agentDir, "squire", "delegation_prompt.md");
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
	rmSync(rosterDir, { recursive: true, force: true });
	rmSync(legacyRosterDir, { recursive: true, force: true });
	rmSync(delegationPromptPath, { recursive: true, force: true });
	rmSync(sessionDir, { recursive: true, force: true });
	delete process.env.PI_DELEGATE_PARENT;
	delete process.env.PI_DELEGATE_AUTO_EXIT;
	delete process.env.PI_DELEGATE_FALLBACK;
	delete process.env.PI_DELEGATE_AGENT;
	delete process.env.PI_CODING_AGENT_SESSION_DIR;
}

/** Write `<agent dir>/squire/agents/<name>/AGENT.md`. */
export function writeAgent(name: string, content: string): void {
	mkdirSync(join(rosterDir, name), { recursive: true });
	writeFileSync(join(rosterDir, name, "AGENT.md"), content);
}

/** Write `<agent dir>/squire/delegation_prompt.md`. */
export function writeDelegationPrompt(content: string): void {
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(delegationPromptPath, content);
}

/** Write `<agent dir>/agents/<name>/AGENT.md`, the retired location no roster reads. */
export function writeLegacyAgent(name: string, content: string): void {
	mkdirSync(join(legacyRosterDir, name), { recursive: true });
	writeFileSync(join(legacyRosterDir, name, "AGENT.md"), content);
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
export type ToolResult = { content: { type: string; text: string }[]; details: unknown; structuredContent?: unknown };

/** One registered tool, as much of it as the tests drive. */
export type Tool = {
	name: string;
	description: string;
	parameters: unknown;
	outputSchema?: TSchema;
	annotations?: Record<string, boolean>;
	execute: (toolCallId: string, params: never, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<ToolResult>;
};

/** The structured prompt options one fake run preparation starts from. */
export type PrepareOptions = {
	messageType?: "user" | "custom";
	systemPrompt?: string;
	prompt?: string;
	message?: { customType: string; content: unknown; display: boolean };
	selectedTools?: readonly string[];
	hiddenTools?: readonly string[];
	sections?: Record<string, string>;
	toolSnippets?: Record<string, string>;
	toolGuidelines?: Record<string, string[]>;
	promptGuidelines?: readonly string[];
	appendSystemPrompt?: string;
};

/** A message a `before_agent_start` handler returns, which Pi appends to the run's history. */
export type ReturnedMessage = { customType: string; content: unknown; display: boolean; details?: unknown };

/** The event a `before_agent_start` dispatch hands every handler. */
export type PrepareEvent = {
	type: "before_agent_start";
	messageType: "user" | "custom";
	prompt?: string;
	message?: { customType: string; content: unknown; display: boolean };
	systemPrompt: string;
	systemPromptOptions: {
		cwd: string;
		selectedTools: string[];
		hiddenTools: string[];
		toolSnippets: Record<string, string>;
		toolGuidelines: Record<string, string[]>;
		promptGuidelines: string[];
		appendSystemPrompt: string;
		sections: Record<string, string>;
		contextFiles: unknown[];
		skills: unknown[];
	};
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
	/** Set `PI_DELEGATE_FALLBACK` before the extension registers, as the launch does. */
	fallbackEnv?: string;
	/** Set `PI_DELEGATE_AGENT` before the extension registers, as the launch does. */
	agentEnv?: string;
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

/**
 * Pi passes `structuredContent` to codemode scripts without checking it, so
 * every tool call in every test checks it here: it is set, matches the tool's
 * `outputSchema` after a JSON round trip, and has no field the schema leaves out.
 */
function checkStructured(tool: Tool, result: ToolResult): void {
	if (tool.outputSchema === undefined) throw new Error(`${tool.name} declares no outputSchema`);
	const value: unknown = JSON.parse(JSON.stringify(result.structuredContent ?? null));
	const errors = [...Value.Errors(tool.outputSchema, value)];
	if (errors.length > 0) {
		throw new Error(`${tool.name} structuredContent breaks its outputSchema: ${JSON.stringify(errors)}`);
	}
	const cleaned = Value.Clean(tool.outputSchema, structuredClone(value));
	if (JSON.stringify(cleaned) !== JSON.stringify(value)) {
		throw new Error(`${tool.name} structuredContent has fields its outputSchema leaves out: ${JSON.stringify(value)}`);
	}
}

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
	/** Every message a `before_agent_start` handler returned, in handler order. */
	const preparedMessages: ReturnedMessage[] = [];
	const tools: Record<string, Tool> = {};
	/** Every `pi.registerTool` call, in order, so a test can count re-registrations. */
	const registrations: string[] = [];
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
	/** Every `pi.setModel` call, as provider/id. */
	const modelSets: string[] = [];
	/** Every `agent_before_settle` result that asked Pi to continue. */
	const continuations: { continue: true; entries?: { content?: unknown }[] }[] = [];
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
			registrations.push(tool.name);
			tools[tool.name] = tool;
		},
		registerMessageRenderer: () => {},
		appendEntry: (customType: string, data: unknown) =>
			entries.push({ customType, data: data as Record<string, unknown> }),
		sendMessage: (message: { customType: string; content: unknown; display?: boolean }, opts: unknown) =>
			sent.push({ message, options: opts }),
		sendUserMessage: (text: string, opts: unknown) => {
			userMessages.push({ text, options: opts });
		},
		setModel: async (model: { provider: string; id: string }) => {
			modelSets.push(`${model.provider}/${model.id}`);
			return true;
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
			// The icons are picked at random; the placeholders pin which pair each side draws from.
			setStatus: (key: string, text: string | undefined) =>
				statuses.push({
					key,
					text: text?.replace(/^(?:👨|👩) /u, "<parent> ").replace(/^(?:👦|👧) /u, "<child> "),
				}),
			theme: { fg: (_color: string, text: string) => text },
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
	if (options.fallbackEnv !== undefined) process.env.PI_DELEGATE_FALLBACK = options.fallbackEnv;
	if (options.agentEnv !== undefined) process.env.PI_DELEGATE_AGENT = options.agentEnv;
	register(pi as never, tmux, usage);
	const fire = async (name: string, event: object = {}) => {
		const results: unknown[] = [];
		for (const handler of handlers[name] ?? []) results.push(await handler({ type: name, ...event }, ctx));
		return results;
	};
	/** Dispatch one run preparation, with the structured options Pi would pass, and return the event after handlers. */
	const prepare = async (options: PrepareOptions = {}): Promise<PrepareEvent> => {
		const { messageType = "user", systemPrompt = "", prompt, message, ...promptOptions } = options;
		const event: PrepareEvent = {
			type: "before_agent_start",
			messageType,
			...(messageType === "custom"
				? { message: message ?? { customType: "delegate", content: "result", display: true } }
				: { prompt: prompt ?? "question" }),
			systemPrompt,
			systemPromptOptions: {
				cwd: root,
				selectedTools: [...(promptOptions.selectedTools ?? [...DEFAULT_TOOLS, "delegate"])],
				hiddenTools: [...(promptOptions.hiddenTools ?? [])],
				toolSnippets: { ...(promptOptions.toolSnippets ?? {}) },
				toolGuidelines: { ...(promptOptions.toolGuidelines ?? {}) },
				promptGuidelines: [...(promptOptions.promptGuidelines ?? [])],
				appendSystemPrompt: promptOptions.appendSystemPrompt ?? "",
				sections: { ...(promptOptions.sections ?? {}) },
				contextFiles: [],
				skills: [],
			},
		};
		for (const handler of handlers.before_agent_start ?? []) {
			const result = (await handler(event, ctx)) as { systemPrompt?: string; message?: ReturnedMessage } | undefined;
			// Pi honors a handler's whole-prompt replacement; recording it makes the test observable.
			if (result?.systemPrompt !== undefined) event.systemPrompt = result.systemPrompt;
			// Pi appends a handler's returned message to the run's history; record it too.
			if (result?.message !== undefined) preparedMessages.push(result.message);
		}
		return event;
	};
	let calls = 0;
	const callTool = (name: string, params: unknown): Promise<ToolResult> => {
		const tool = tools[name];
		if (tool === undefined) return Promise.reject(new Error(`no tool named ${name} is registered`));
		return tool.execute(`call-${++calls}`, params as never, undefined, undefined, ctx).then((result) => {
			checkStructured(tool, result);
			return result;
		});
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
		/** Every tool registration in order, so a test can count them. */
		registrations,
		/** Every message a `before_agent_start` handler returned, in handler order. */
		preparedMessages,
		/** Dispatch a run's preparation with structured prompt options; returns the event after handlers. */
		prepare,
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
		modelSets,
		continuations,
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
			// A continuation means Pi runs again instead of settling; the next `run` is that run.
			const settle = await fire("agent_before_settle", { entries: [], continue: false });
			const more = settle.find((result) => (result as { continue?: boolean } | undefined)?.continue === true);
			if (more !== undefined) {
				continuations.push(more as (typeof continuations)[number]);
				return;
			}
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
