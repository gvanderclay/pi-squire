// `delegate`: hand a task to a delegate Pi session in a background tmux
// window, over the `message:*` hooks.
//
// `/delegate <agent> [--model <provider/id>] [--thinking <level>] <task…>`
// reads the agent from `<agent dir>/agents/<name>/AGENT.md`, writes the task
// to the delegate's inbox through `message:send`, emits `session:launch` so
// listeners can add arguments and environment, then opens `<agent>-<id>` in
// the parent's working directory running the parent's own Pi. Starting a
// delegation adds nothing to the model's context. Inside a delegate
// (`PI_DELEGATE_PARENT` set) the extension registers nothing, so a delegate
// cannot delegate.
//
// The `session:launch` contract this package provides, and the `message:*`
// hooks it consumes, live in this package's README.
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";

import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type ModelRegistry,
} from "@earendil-works/pi-coding-agent";

import { isThinking, readRoster, THINKING_LEVELS } from "./agents.ts";
import { createTmuxClient, type TmuxClient } from "./tmux.ts";

/** The hook a provider of `message:*` answers with the written request. */
const SEND = "message:send";
/** The hook emitted just before a delegate's window opens. */
const LAUNCH = "session:launch";
/** The session entry type each delegation is recorded under. */
const CUSTOM_TYPE = "delegate";
/** Set in a delegate's environment, so this extension stays off there. */
const PARENT_ENV = "PI_DELEGATE_PARENT";
/** Forwarded to the child when the parent has it set. */
const SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";
/** Asked of every delegate, so the parent gets an answer it can use alone. */
const FINAL_LINE =
	"End with one self-contained final message: the parent session sees only that message, never this conversation.";
/** The flags `/delegate` takes before the task. */
const FLAGS = ["--model", "--thinking"] as const;

const USAGE = "usage: /delegate <agent> [--model <provider/id>] [--thinking <level>] <task>";

type SendPayload = { to: unknown; body: unknown; envelope?: { id?: unknown }; error?: unknown };
type LaunchPayload = { args: string[]; env: Record<string, string> };
type Parsed = { agent: string; model?: string; thinking?: string; task: string };

/** The runtimes whose executable needs the script from `process.argv[1]`. */
const RUNTIMES = new Set(["node", "nodejs", "bun", "deno"]);

/**
 * The parent's own Pi executable. Under a script runtime (node or bun) the
 * script is `argv[1]`; a compiled binary reports its own path as `execPath`
 * and its first user argument, if any, as `argv[1]`.
 */
function parentCommand(execPath = process.execPath, argv = process.argv): string[] {
	const runner = basename(execPath).replace(/\.exe$/i, "").toLowerCase();
	const script = argv[1];
	if (RUNTIMES.has(runner) && typeof script === "string" && script !== "") return [execPath, script];
	return [execPath];
}

/** Edit distance, for the "close matches" lists. */
function distance(a: string, b: string): number {
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++) {
			current[j] = Math.min(
				previous[j] + 1,
				current[j - 1] + 1,
				previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		}
		previous = current;
	}
	return previous[b.length];
}

/** Up to three candidates close to `value`; empty when nothing is close. */
function closest(value: string, candidates: readonly string[]): string[] {
	const limit = Math.max(2, Math.ceil(value.length * 0.4));
	return candidates
		.map((candidate) => ({ candidate, score: distance(value.toLowerCase(), candidate.toLowerCase()) }))
		.filter(({ score }) => score <= limit)
		.sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate))
		.slice(0, 3)
		.map(({ candidate }) => candidate);
}

/** `/delegate`'s arguments: an agent, optional flags, then a verbatim task. */
function parse(text: string): { parsed: Parsed } | { error: string } {
	const tokens = [...text.matchAll(/\S+/g)].map((match) => ({ text: match[0], start: match.index }));
	if (tokens.length === 0) return { error: USAGE };
	if (tokens[0].text.startsWith("-")) return { error: `the first argument is the agent name; ${USAGE}` };
	const parsed: Parsed = { agent: tokens[0].text, task: "" };
	let i = 1;
	while (i < tokens.length && tokens[i].text.startsWith("-")) {
		const flag = tokens[i].text;
		if (flag !== "--model" && flag !== "--thinking") return { error: `unknown flag ${flag}; ${USAGE}` };
		const value = tokens[i + 1]?.text;
		if (value === undefined || value.startsWith("--")) return { error: `${flag} needs a value; ${USAGE}` };
		if (flag === "--model") parsed.model = value;
		else parsed.thinking = value;
		i += 2;
	}
	parsed.task = text.slice(tokens[i]?.start ?? text.length).trim();
	if (parsed.task === "") return { error: `a task is required after the agent and flags; ${USAGE}` };
	return { parsed };
}

/** Why `value` is not a usable model, or undefined when it is. */
function modelProblem(value: string, registry: ModelRegistry): string | undefined {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return `--model takes provider/id, got ${JSON.stringify(value)}`;
	if (registry.find(value.slice(0, slash), value.slice(slash + 1)) !== undefined) return undefined;
	const names = registry.getAll().map((model) => `${model.provider}/${model.id}`);
	const close = closest(value, names);
	return `unknown model ${JSON.stringify(value)}${close.length > 0 ? `; close matches: ${close.join(", ")}` : ""}`;
}

/** Why `value` is not a thinking level, or undefined when it is. */
function thinkingProblem(value: string): string | undefined {
	if (isThinking(value)) return undefined;
	const close = closest(value, THINKING_LEVELS);
	return `unknown thinking level ${JSON.stringify(value)}; levels: ${THINKING_LEVELS.join(", ")}${
		close.length > 0 ? `; close matches: ${close.join(", ")}` : ""
	}`;
}

/**
 * Register `/delegate`. The second parameter is a test-only seam for tmux:
 * Pi passes only `pi`, so it is not part of the package's documented contract.
 */
export default function delegate(pi: ExtensionAPI, tmux: TmuxClient = createTmuxClient()): void {
	// A delegate registers nothing: `delegate` is one level deep (Q27).
	if ((process.env[PARENT_ENV] ?? "") !== "") return;

	/** Captured because `getArgumentCompletions` is called without a context. */
	let registry: ModelRegistry | undefined;

	pi.on("session_start", (_event, ctx) => {
		registry = ctx.modelRegistry;
	});

	const modelIds = (): string[] => (registry?.getAll() ?? []).map((model) => `${model.provider}/${model.id}`);

	/** Agent names, flags, model ids and thinking levels, at the cursor's token. */
	function completions(prefix: string): { value: string; label: string }[] | null {
		const partial = /(?:^|\s)(\S*)$/.exec(prefix)?.[1] ?? "";
		const head = prefix.slice(0, prefix.length - partial.length);
		const pick = (values: readonly string[]) => {
			const hits = values.filter((value) => value.startsWith(partial));
			return hits.length > 0 ? hits.map((value) => ({ value: head + value, label: value })) : null;
		};
		const tokens = head.trim() === "" ? [] : head.trim().split(/\s+/);
		if (tokens.length === 0) return pick(readRoster(getAgentDir()).agents.map((agent) => agent.name));
		const previous = tokens[tokens.length - 1];
		if (previous === "--model") return pick(modelIds());
		if (previous === "--thinking") return pick(THINKING_LEVELS);
		return pick(FLAGS);
	}

	async function start(text: string, ctx: ExtensionContext): Promise<void> {
		const fail = (message: string) => ctx.ui.notify(`delegate: ${message}`, "error");
		const outcome = parse(text);
		if ("error" in outcome) {
			fail(outcome.error);
			return;
		}
		const { agent: wanted, model: wantedModel, thinking: wantedThinking, task } = outcome.parsed;

		const { agents, warnings } = readRoster(getAgentDir());
		for (const warning of warnings) ctx.ui.notify(`delegate: ${warning}`, "warning");
		if (agents.length === 0) {
			fail(
				`no agents are defined; add ${join(getAgentDir(), "agents", "<name>", "AGENT.md")} with frontmatter description, model and thinking, and the prompt as its body`,
			);
			return;
		}
		const agent = agents.find((candidate) => candidate.name === wanted);
		if (agent === undefined) {
			fail(`no agent named ${JSON.stringify(wanted)}; available: ${agents.map((item) => item.name).join(", ")}`);
			return;
		}

		const model = wantedModel ?? agent.model;
		const thinking = wantedThinking ?? agent.thinking;
		const badModel = modelProblem(model, ctx.modelRegistry);
		if (badModel !== undefined) {
			fail(badModel);
			return;
		}
		const badThinking = thinkingProblem(thinking);
		if (badThinking !== undefined) {
			fail(badThinking);
			return;
		}

		if (!tmux.insideTmux()) {
			fail("this session is not inside tmux; start it in a tmux pane to open a delegate window");
			return;
		}

		// The task goes on disk before the window exists: the delegate finds it
		// at session start without a handshake, and a window that fails leaves
		// mail that is reported rather than cleaned up.
		const id = randomUUID();
		const sent: SendPayload = { to: id, body: task };
		pi.events.emit(SEND, sent);
		if (typeof sent.error === "string") {
			fail(`could not send the task to ${id}: ${sent.error}`);
			return;
		}
		if (sent.envelope === undefined) {
			fail(`needs a provider of message:* to send the task; install a mailbox extension (for example pi-session-mail)`);
			return;
		}
		const requestId = sent.envelope.id;
		if (typeof requestId !== "string") {
			fail(`the message:send provider wrote no request id for ${id}`);
			return;
		}

		const argv = [
			...parentCommand(),
			"--session-id",
			id,
			"--model",
			model,
			"--thinking",
			thinking,
			"--append-system-prompt",
			`${agent.prompt}\n\n${FINAL_LINE}`,
		];
		const env: Record<string, string> = {
			PI_CODING_AGENT_DIR: getAgentDir(),
			[PARENT_ENV]: ctx.sessionManager.getSessionId(),
		};
		const sessionDir = process.env[SESSION_DIR_ENV];
		if (sessionDir !== undefined && sessionDir !== "") env[SESSION_DIR_ENV] = sessionDir;
		// Listeners may only append to `args` and add to `env`; there is no veto.
		const launch: LaunchPayload = { args: argv, env };
		pi.events.emit(LAUNCH, launch);

		const windowName = `${agent.name}-${id}`;
		let windowId: string;
		try {
			windowId = await tmux.openWindow({ name: windowName, cwd: ctx.cwd, argv: launch.args, env: launch.env });
		} catch (err) {
			fail(`could not open window ${windowName} for ${id}: ${(err as Error).message}`);
			return;
		}

		// No task text in the record: the request copy in `sent/` has it.
		pi.appendEntry(CUSTOM_TYPE, {
			id,
			agent: agent.name,
			model,
			thinking,
			windowId,
			windowName,
			requestId,
		});
		ctx.ui.notify(`delegate: ${agent.name} ${id} started in window ${windowName}`, "info");
	}

	pi.registerCommand("delegate", {
		description: `Start a delegate Pi session in a background tmux window: ${USAGE}`,
		getArgumentCompletions: completions,
		handler: start,
	});
}
