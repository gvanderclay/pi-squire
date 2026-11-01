// Real Pi engine/extension events, deterministic local provider, no network or credentials.
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerActivityRuntime } from "../../src/widget-activity-runtime.ts";
import { LIVE_LAUNCH_ENV } from "../../src/widget-live.ts";

type Gate = { promise: Promise<void>; release(): void };
function gate(): Gate {
	let release!: () => void;
	const promise = new Promise<void>((r) => {
		release = r;
	});
	return { promise, release };
}
const textGate = gate(),
	textReady = gate(),
	toolsReady = gate();
const toolGates = [gate(), gate()];
const calls: { id: string; parent?: string; phase: string }[] = [];
let entered = 0,
	requests = 0;
let errorRun = false;
let stop: () => void = () => {};
let real: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
let running: Promise<void> | undefined;
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function stream(
	model: Model<Api>,
	_context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const events = createAssistantMessageEventStream();
	const final = requests++ > 0;
	const message: AssistantMessage = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [],
		stopReason: "pending",
		timestamp: Date.now(),
		usage,
	};
	void (async () => {
		events.push({ type: "start", partial: message });
		message.content.push({ type: "thinking", thinking: "" });
		events.push({ type: "thinking_start", contentIndex: 0, partial: message });
		message.content[0] = { type: "thinking", thinking: "THINKING_SECRET" };
		events.push({ type: "thinking_delta", contentIndex: 0, delta: "THINKING_SECRET", partial: message });
		events.push({ type: "thinking_end", contentIndex: 0, content: "THINKING_SECRET", partial: message });
		message.content.push({ type: "text", text: "" });
		events.push({ type: "text_start", contentIndex: 1, partial: message });
		message.content[1] = { type: "text", text: final ? "final response" : "Literal live response" };
		events.push({
			type: "text_delta",
			contentIndex: 1,
			delta: final ? "final response" : "Literal live response",
			partial: message,
		});
		if (!final) {
			textReady.release();
			const signal = options?.signal;
			const aborted = (): void => textGate.release();
			signal?.addEventListener("abort", aborted, { once: true });
			await textGate.promise;
			signal?.removeEventListener("abort", aborted);
			if (signal?.aborted || errorRun) {
				message.stopReason = signal?.aborted ? "aborted" : "error";
				message.errorMessage = signal?.aborted ? "fixture aborted" : "fixture failure";
				events.push({ type: "error", reason: message.stopReason, error: message });
				events.end();
				return;
			}
		}
		events.push({
			type: "text_end",
			contentIndex: 1,
			content: final ? "final response" : "Literal live response",
			partial: message,
		});
		if (!final) {
			const tool = { type: "toolCall" as const, id: "outer", name: "driver", arguments: {} };
			message.content.push(tool);
			events.push({ type: "toolcall_start", contentIndex: 2, partial: message });
			events.push({ type: "toolcall_end", contentIndex: 2, toolCall: tool, partial: message });
		}
		message.stopReason = final ? "stop" : "toolUse";
		events.push({ type: "done", reason: final ? "stop" : "toolUse", message });
		events.end();
	})();
	return events;
}
async function start(): Promise<string> {
	const manager = SessionManager.inMemory(process.cwd());
	process.env[LIVE_LAUNCH_ENV] = JSON.stringify({
		version: 1,
		sessionId: manager.getSessionId(),
		launchId: "sdk-launch",
	});
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	const loader = new DefaultResourceLoader({
		cwd: process.cwd(),
		agentDir: process.env.PI_CODING_AGENT_DIR!,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [
			(pi) => {
				stop = registerActivityRuntime(pi);
				pi.registerProvider("widget-fixture", {
					api: "widget-fixture-api",
					baseUrl: "http://never-used.invalid",
					apiKey: "local-fixture-only",
					streamSimple: stream,
					models: [
						{
							id: "synthetic",
							name: "synthetic",
							reasoning: false,
							input: ["text"],
							cost: usage.cost,
							contextWindow: 100000,
							maxTokens: 2048,
						},
					],
				});
				pi.registerTool({
					name: "read",
					label: "read",
					description: "local gated probe",
					parameters: Type.Object({}),
					async execute() {
						const index = entered++;
						if (entered === 2) toolsReady.release();
						await toolGates[index].promise;
						return { content: [{ type: "text", text: "TOOL_RESULT_SECRET" }], details: undefined };
					},
				});
				pi.registerTool({
					name: "driver",
					label: "driver",
					description: "parallel nested probes",
					parameters: Type.Object({}),
					async execute(_id, _args, signal, _update, ctx) {
						await Promise.all([ctx.executeTool("read", {}, { signal }), ctx.executeTool("read", {}, { signal })]);
						return { content: [{ type: "text", text: "DRIVER_RESULT_SECRET" }], details: undefined };
					},
				});
				pi.on("tool_execution_start", (event) => {
					calls.push({ id: event.toolCallId, parent: event.parentToolCallId, phase: "start" });
				});
				pi.on("tool_execution_end", (event) => {
					calls.push({ id: event.toolCallId, parent: event.parentToolCallId, phase: "end" });
				});
			},
		],
	});
	await loader.reload();
	const created = await createAgentSession({
		cwd: process.cwd(),
		agentDir: process.env.PI_CODING_AGENT_DIR!,
		settingsManager,
		resourceLoader: loader,
		sessionManager: manager,
		noTools: "builtin",
		model: {
			id: "synthetic",
			name: "synthetic",
			api: "widget-fixture-api",
			provider: "widget-fixture",
			baseUrl: "http://never-used.invalid",
			reasoning: false,
			input: ["text"],
			cost: usage.cost,
			contextWindow: 100000,
			maxTokens: 2048,
		},
	});
	real = created.session;
	await real.modelRuntime.setRuntimeApiKey("widget-fixture", "local-fixture-only");
	await real.bindExtensions({
		onError: (error) => {
			process.stderr.write(`${String(error)}\n`);
		},
	});
	running = real.prompt("synthetic fixture input");
	await Promise.race([
		textReady.promise,
		running.then(() => {
			throw Error("run ended before live text");
		}),
	]);
	return manager.getSessionId();
}
type Command = { key: number; op: string };
async function command(c: Command): Promise<unknown> {
	if (c.op === "start") return start();
	if (c.op === "abort") {
		await real?.abort();
		await running;
		return null;
	}
	if (c.op === "error") {
		errorRun = true;
		textGate.release();
		await running;
		return null;
	}
	if (c.op === "reload") {
		await real?.reload();
		return null;
	}
	if (c.op === "tools") {
		textGate.release();
		await Promise.race([toolsReady.promise, running]);
		return calls;
	}
	if (c.op === "first") {
		toolGates[0].release();
		return null;
	}
	if (c.op === "finish") {
		toolGates[1].release();
		await running;
		return calls;
	}
	if (c.op === "stop") {
		stop();
		real?.dispose();
		return null;
	}
	if (c.op === "calls") return calls;
	return null;
}
process.on("message", (c: Command) => {
	void command(c).then(
		(result) => process.send?.({ key: c.key, result }),
		(error) => process.send?.({ key: c.key, error: error instanceof Error ? error.stack : String(error) }),
	);
});
process.send?.({ ready: true });
