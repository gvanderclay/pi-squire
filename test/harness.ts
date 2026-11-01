// The shared test harness: a temporary agent directory, one fake Pi session
// with a real event bus, a `message:send` provider stub and the fake tmux.
// Tests drive the extension only through its registration function and watch
// the bus, the injected messages, the recorded entries and the fake tmux.

import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	CustomEditor,
	createEventBus,
	type EventBus,
	type ExtensionAPI,
	type TerminalInputHandler,
} from "@earendil-works/pi-coding-agent";

import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { readIdentity, writeIdentity } from "../src/identity.ts";
import register from "../src/index.ts";
import { FakeTmux } from "./fake-tmux.ts";
import { FakeUsage } from "./fake-usage.ts";

/** A throwaway root for this test file; `PI_CODING_AGENT_DIR` points inside it. */
export const root = mkdtempSync(join(tmpdir(), "delegate-test-"));
export const agentDir = join(root, "agent");
/** The global agents folder, `<agent dir>/agents`. */
export const rosterDir = join(agentDir, "agents");
/** The retired roster directory, `<agent dir>/squire/agents`, kept only so tests can write a fixture there. */
const legacyRosterDir = join(agentDir, "squire", "agents");
/** The optional parent guidance file. */
export const delegationPromptPath = join(agentDir, "squire", "delegation_prompt.md");
/** The session directory the fake `sessionManager` reports. */
export const sessionDir = join(agentDir, "sessions");
process.env.PI_CODING_AGENT_DIR = agentDir;
export const cleanup = () => rmSync(root, { recursive: true, force: true });

/** A frontmatter block and body, the way an agent file is written. */
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
	// Project trust decisions and Pi's own settings, so a saved answer cannot carry into the next test.
	for (const name of ["trust.json", "trust.json.lock", "settings.json"]) {
		rmSync(join(agentDir, name), { recursive: true, force: true });
	}
	rmSync(join(agentDir, "squire", "settings.json"), { recursive: true, force: true });
	for (const name of ["identity", "child-tasks", "trees", "trust", "session-titles", "live-sessions", "owners"])
		rmSync(join(agentDir, "squire", name), { recursive: true, force: true });
	delete process.env.PI_SQUIRE_LIVE_LAUNCH;
	delete process.env.PI_DELEGATE_PARENT;
	delete process.env.PI_DELEGATE_AUTO_EXIT;
	delete process.env.PI_DELEGATE_FALLBACK;
	delete process.env.PI_DELEGATE_AGENT;
	delete process.env.PI_DELEGATE_ROOT;
	delete process.env.PI_DELEGATE_DEPTH;
	delete process.env.PI_DELEGATE_CHAIN;
	delete process.env.PI_UNATTENDED;
	delete process.env.PI_CODING_AGENT_SESSION_DIR;
}

/** Write `<agent dir>/agents/<name>.md`. */
export function writeAgent(name: string, content: string): void {
	mkdirSync(rosterDir, { recursive: true });
	writeFileSync(join(rosterDir, `${name}.md`), content);
}

/** Write `<cwd>/.pi/agents/<name>.md`, a project's agent file; returns its path. */
export function writeProjectAgent(cwd: string, name: string, content: string): string {
	const dir = join(cwd, ".pi", "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${name}.md`), content);
	return join(dir, `${name}.md`);
}

/** Write `<agent dir>/squire/delegation_prompt.md`. */
export function writeDelegationPrompt(content: string): void {
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(delegationPromptPath, content);
}

/** Write `<agent dir>/squire/agents/<name>/AGENT.md`, the retired location no roster reads. */
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

/** The raw input each named key sends; any other key is typed as is. */
const KEY_DATA: Record<string, string> = { up: "\x1b[A", down: "\x1b[B", enter: "\r", escape: "\x1b" };

/**
 * A key-driven `ctx.ui.custom` answer: the harness builds the component the
 * factory returns, renders it, feeds it `keys` through `handleInput` and
 * returns what it passed to `done`. `frames` collects the rendered text after
 * the factory and after each key; `result` is the `done` value.
 */
export type KeyScript = { keys: string[]; frames: string[]; result?: unknown; width?: number };

/** A `KeyScript` for the `ui.custom` queue. */
export const keyScript = (keys: string[], width = 100): KeyScript => ({ keys, frames: [], width });

const isKeyScript = (value: unknown): value is KeyScript =>
	typeof value === "object" && value !== null && Array.isArray((value as KeyScript).keys);

const settle = async () => {
	for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
};

type Component = { render(width: number): string[]; handleInput?(data: string): void; dispose?(): void };

/** Build, render and drive one component the way Pi's `custom` does. */
async function runKeyScript(factory: unknown, script: KeyScript): Promise<unknown> {
	let finished = false;
	const done = (value: unknown) => {
		finished = true;
		script.result = value;
	};
	const tui = { requestRender: () => {}, terminal: { columns: script.width ?? 100, rows: 30 } };
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const component = await (factory as (...args: unknown[]) => Component | Promise<Component>)(tui, theme, {}, done);
	const frame = () => script.frames.push(component.render(script.width ?? 100).join("\n"));
	frame();
	for (const key of script.keys) {
		if (finished) break;
		component.handleInput?.(KEY_DATA[key] ?? key);
		await settle();
		frame();
	}
	component.dispose?.();
	if (!finished) throw new Error(`the key script ended before the component called done: ${script.keys.join(" ")}`);
	return script.result;
}

/** The answers a scripted `ctx.ui` gives, one queue per dialog. */
export type UiAnswers = {
	/** A promise answers when the test settles it, so a dialog can stay open while another call starts. */
	select?: (string | undefined | Promise<string | undefined>)[];
	editor?: (string | undefined)[];
	/** One-line `ctx.ui.input` answers. */
	input?: (string | undefined)[];
	/** A `KeyScript` drives the component; anything else is the answer itself. */
	custom?: unknown[];
	confirm?: boolean[];
};

let counter = 0;

/** One custom entry, the shape `pi.appendEntry` writes and `getEntries` returns. */
export type Entry = { customType: string; data: Record<string, unknown> };

export type SessionOptions = {
	/** Shared server for multi-instance tree accounting tests. */
	tmux?: FakeTmux;
	/** Install a real mail provider instead of the send/scan stubs. */
	mailProvider?: (pi: ExtensionAPI) => void;
	/** Exercise the opposite extension load order. */
	mailProviderLast?: boolean;
	/** Register an intervening extension before Squire, after mail when mail loads first. */
	beforeSquire?: (pi: ExtensionAPI) => void;
	/** Register an intervening extension before a provider loaded last. */
	beforeMailProvider?: (pi: ExtensionAPI) => void;
	/** Header provenance used by actual fork/clone restoration tests. */
	sessionHeader?: { parentSession?: string };
	/** Whether `ctx.hasUI` is true. */
	hasUI?: boolean;
	/** Interactive widget tests opt in; existing JSON-mode tests keep their count footer. */
	mode?: import("@earendil-works/pi-coding-agent").ExtensionContext["mode"];
	/** The parent's working directory, `ctx.cwd`; default `root`. */
	cwd?: string;
	/** What `ctx.isProjectTrusted()` answers; default false. */
	projectTrusted?: boolean;
	/** What `ctx.sessionManager.getSessionDir()` reports; default the exported `sessionDir`. */
	sessionDir?: string;
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
	/** Per-tool exposure metadata, including tools not directly displayed. */
	toolExposures?: Record<string, "direct" | "model-only" | "codemode" | "deferred" | "hidden">;
	/** The tool names `pi.getActiveTools()` reports; default `DEFAULT_TOOLS` and the delegation tools. `pi.setActiveTools` changes them. */
	activeTools?: readonly string[];
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
	/** The parent's current model, `ctx.model`, as provider/id; default `alpha/fast-model`, `null` for none. */
	parentModel?: string | null;
	/** The parent's thinking level, `pi.getThinkingLevel()`; default `medium`. */
	parentThinking?: string;
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

/** The tools pi-squire registers in a parent, active there unless a test says otherwise. */
export const DELEGATION_TOOLS = ["delegate", "delegation_status", "delegation_close", "delegation_resume"];

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
	const widgets = new Map<string, { render(width: number): string[]; invalidate(): void }>();
	const widgetCalls: { key: string; placement: unknown; renderer: string }[] = [];
	let renderer = "regular";
	const widgetTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const inputHandlers = new Set<TerminalInputHandler>();
	let editorText = "";
	let autocomplete = false;
	let customEditor = false;
	const promptEditor = Object.create(CustomEditor.prototype) as CustomEditor;
	promptEditor.isShowingAutocomplete = () => autocomplete;
	let focusedComponent: unknown = promptEditor;
	const widgetTui = {
		get mode() {
			return renderer;
		},
		getFocusedComponent: () => focusedComponent,
		requestRender: () => {},
	};
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
	const selects: { title: string; options: string[]; signal?: AbortSignal; timeout?: number }[] = [];
	/** Every `ctx.ui.editor` call, with what it pre-filled. */
	const editors: { title: string; prefill: string | undefined }[] = [];
	/** Every `ctx.ui.input` call, with its title. */
	const inputs: { title: string; placeholder: string | undefined }[] = [];
	/** Every `ctx.ui.custom` factory, as passed. */
	const customs: unknown[] = [];
	/** The options each `ctx.ui.custom` call passed, in order (undefined when none). */
	const customOptions: unknown[] = [];
	const selectAnswers = [...(options.ui?.select ?? [])];
	const editorAnswers = [...(options.ui?.editor ?? [])];
	const inputAnswers = [...(options.ui?.input ?? [])];
	const customAnswers = [...(options.ui?.custom ?? [])];
	const confirmAnswers = [...(options.ui?.confirm ?? [])];
	/** Every `ctx.ui.confirm` call, with its title and message. */
	const confirms: { title: string; message: string }[] = [];
	/** Every `pi.registerShortcut` handler, by key. */
	const shortcuts: Record<string, (ctx: unknown) => unknown> = {};
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
	const tmux = options.tmux ?? new FakeTmux();
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
	let activeTools = [...(options.activeTools ?? [...DEFAULT_TOOLS, ...DELEGATION_TOOLS])];
	let sessionName: string | undefined;
	const pi = {
		getSessionName: () => sessionName,
		setSessionName: (name: string) => {
			sessionName = name;
		},
		getThinkingLevel: () => options.parentThinking ?? "medium",
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => {
			activeTools = [...names];
		},
		getAllTools: () => {
			if (!bound)
				throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
			return [...new Set([...registeredTools, ...activeTools, ...Object.keys(tools)])].map((name) => ({
				name,
				exposure: options.toolExposures?.[name] ?? "direct",
			}));
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
		registerShortcut: (key: string, shortcut: { handler: (ctx: unknown) => unknown }) => {
			shortcuts[key] = shortcut.handler;
		},
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
	const parentModel = options.parentModel === undefined ? "alpha/fast-model" : options.parentModel;
	const ctx = {
		model:
			parentModel === null
				? undefined
				: {
						provider: parentModel.slice(0, parentModel.indexOf("/")),
						id: parentModel.slice(parentModel.indexOf("/") + 1),
					},
		cwd: options.cwd ?? root,
		hasUI: options.hasUI ?? true,
		mode: options.mode ?? "json",
		isIdle: () => signal === undefined,
		isProjectTrusted: () => options.projectTrusted ?? false,
		modelRegistry: registry,
		get signal() {
			return signal;
		},
		shutdown: () => {
			shutdowns++;
		},
		sessionManager: {
			getSessionId: () => parent,
			getSessionDir: () => options.sessionDir ?? sessionDir,
			getHeader: () => ({ type: "session", id: parent, cwd: options.cwd ?? root, ...options.sessionHeader }),
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
			theme: widgetTheme,
			getEditorText: () => editorText,
			getEditorComponent: () => (customEditor ? () => promptEditor : undefined),
			onTerminalInput: (handler: TerminalInputHandler) => {
				inputHandlers.add(handler);
				return () => {
					inputHandlers.delete(handler);
				};
			},
			setWidget: (
				key: string,
				factory:
					| ((
							tui: typeof widgetTui,
							theme: typeof widgetTheme,
					  ) => { render(width: number): string[]; invalidate(): void })
					| undefined,
				placement?: unknown,
			) => {
				widgetCalls.push({ key, placement, renderer });
				if (!factory) {
					widgets.delete(key);
					return;
				}
				widgets.set(key, factory(widgetTui, widgetTheme));
			},
			select: async (title: string, options: string[], opts?: { signal?: AbortSignal; timeout?: number }) => {
				selects.push({ title, options, ...opts });
				const answer = selectAnswers.shift();
				if (!opts?.signal) return await answer;
				const signal = opts.signal;
				if (signal.aborted) return undefined;
				let dismiss = () => {};
				const dismissed = new Promise<undefined>((resolve) => {
					dismiss = () => resolve(undefined);
					signal.addEventListener("abort", dismiss, { once: true });
				});
				try {
					return await Promise.race([Promise.resolve(answer), dismissed]);
				} finally {
					signal.removeEventListener("abort", dismiss);
				}
			},
			editor: async (title: string, prefill?: string) => {
				editors.push({ title, prefill });
				return editorAnswers.shift();
			},
			confirm: async (title: string, message: string) => {
				confirms.push({ title, message });
				const previous: unknown = focusedComponent;
				focusedComponent = {};
				await fire("ui_prompt_start", { kind: "confirm" });
				try {
					return confirmAnswers.shift() ?? false;
				} finally {
					focusedComponent = previous;
					await fire("ui_prompt_end", { kind: "confirm" });
				}
			},
			input: async (title: string, placeholder?: string) => {
				inputs.push({ title, placeholder });
				return inputAnswers.shift();
			},
			custom: async (factory: unknown, uiOptions?: unknown) => {
				customs.push(factory);
				customOptions.push(uiOptions);
				const answer = customAnswers.shift();
				const previous: unknown = focusedComponent;
				focusedComponent = {};
				await fire("ui_prompt_start", { kind: "custom" });
				try {
					return isKeyScript(answer) ? await runKeyScript(factory, answer) : answer;
				} finally {
					focusedComponent = previous;
					await fire("ui_prompt_end", { kind: "custom" });
				}
			},
		},
	};
	// The provider stub runs synchronously on the same bus, as `mailbox` does.
	const mode = options.send ?? "envelope";
	events.on("message:send", (data) => {
		if (options.mailProvider !== undefined) return;
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
		if (options.mailProvider !== undefined) return;
		if (!scan.answering) return;
		for (const inbound of scan.queue.splice(0)) events.emit("message:inbound", inbound);
		(data as { scanned?: boolean }).scanned = true;
	});
	if (options.parentEnv !== undefined) process.env.PI_DELEGATE_PARENT = options.parentEnv;
	if (options.autoExitEnv !== undefined) process.env.PI_DELEGATE_AUTO_EXIT = options.autoExitEnv;
	if (options.fallbackEnv !== undefined) process.env.PI_DELEGATE_FALLBACK = options.fallbackEnv;
	if (options.agentEnv !== undefined) process.env.PI_DELEGATE_AGENT = options.agentEnv;
	// A real Squire launch persists exact-session identity before opening Pi.
	if (options.parentEnv && !readIdentity(parent))
		writeIdentity(parent, {
			parent: options.parentEnv,
			root: process.env.PI_DELEGATE_ROOT || options.parentEnv,
			depth: Number(process.env.PI_DELEGATE_DEPTH || 1),
			agent: options.agentEnv ?? "",
			chain: (process.env.PI_DELEGATE_CHAIN || options.agentEnv || "").split(",").filter(Boolean),
			autoExit: options.autoExitEnv === "1",
		});
	if (!options.mailProviderLast) options.mailProvider?.(pi as never);
	options.beforeSquire?.(pi as never);
	register(pi as never, tmux, usage);
	if (options.mailProviderLast) {
		options.beforeMailProvider?.(pi as never);
		options.mailProvider?.(pi as never);
	}
	const fire = async (name: string, event: object = {}) => {
		const results: unknown[] = [];
		for (const handler of handlers[name] ?? []) results.push(await handler({ type: name, ...event }, ctx));
		return results;
	};
	/** Dispatch one run preparation, with the structured options Pi would pass, and return the event after handlers. */
	const prepare = async (options: PrepareOptions = {}): Promise<PrepareEvent> => {
		await ensureStarted();
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
	/** `abort` is the call's own signal, as Pi passes a tool; none by default. */
	const ensureStarted = async (): Promise<void> => {
		if (bound) return;
		bound = true;
		await fire("session_start", { reason: "startup" });
	};
	const callTool = async (name: string, params: unknown, abort?: AbortSignal): Promise<ToolResult> => {
		if (!bound) await ensureStarted();
		const tool = tools[name];
		if (tool === undefined) return Promise.reject(new Error(`no tool named ${name} is registered`));
		return tool.execute(`call-${++calls}`, params as never, abort, undefined, ctx).then((result) => {
			checkStructured(tool, result);
			return result;
		});
	};
	return {
		parent,
		context: ctx,
		tmux,
		usage,
		events,
		pi,
		sent,
		userMessages,
		entries,
		statuses,
		widgets,
		terminalKey: (key: string) => {
			for (const handler of inputHandlers) {
				const result = handler(KEY_DATA[key] ?? key);
				if (result?.consume) return true;
			}
			return false;
		},
		terminalListeners: () => inputHandlers.size,
		editorText: (text: string) => {
			editorText = text;
		},
		editorCompletion: (value: boolean) => {
			autocomplete = value;
		},
		customEditor: (value: boolean) => {
			customEditor = value;
		},
		promptFocus: (component: unknown = promptEditor) => {
			focusedComponent = component;
		},
		widgetCalls,
		switchRenderer: (mode: string) => {
			renderer = mode;
			for (const widget of widgets.values()) widget.invalidate();
		},
		notes,
		warnings,
		errors,
		sendCalls,
		scan,
		selects,
		editors,
		inputs,
		customs,
		customOptions,
		confirms,
		/** Queue one more answer for `ctx.ui.custom`, such as a `keyScript`. */
		queueCustom: (answer: unknown) => customAnswers.push(answer),
		/** Press a registered shortcut as Pi does, with this session's context. */
		shortcut: (key: string) => shortcuts[key]?.(ctx),
		/** The keys the extension registered shortcuts for. */
		shortcuts: () => Object.keys(shortcuts),
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
		command: async (name: string, args = "") => {
			await ensureStarted();
			return commands[name].handler(args, ctx);
		},
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
			await ensureStarted();
			const controller = new AbortController();
			signal = controller.signal;
			const { response: _response, ...errorFields } = failure ?? {};
			await fire("agent_start");
			await fire("context", { messages: [] });
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
		delegate: async (args: string) => {
			await ensureStarted();
			return commands.delegate.handler(args, ctx);
		},
		/** Ask for completions after `/delegate `; the real call has no context. */
		completions: async (prefix: string) =>
			(await commands.delegate.getArgumentCompletions?.(prefix)) as { value: string; label: string }[] | null,
	};
}
