// pi-squire: hand a task to a delegate Pi session in a background tmux
// window, over the `message:*` hooks.
//
// `/delegate <agent> [--model <provider/id>] [--thinking <level>]
// [--label <name>] [--auto-exit | --no-auto-exit] <task…>`
// reads the agent from `<agent dir>/agents/<name>/AGENT.md`, writes the task
// to the delegate's inbox through `message:send`, emits `session:launch` so
// listeners can add arguments and environment, then opens a window in the
// parent's working directory running the parent's own Pi. The window and the
// session share one name: `<agent>-<label>`, or `<agent>-<first 8 of the id>`
// without a label. Starting a delegation adds nothing to
// the model's context. Each delegation is recorded
// in the parent session; its answer is taken over on `message:inbound` and
// shown as one result message, so the parent hears back on its own.
//
// With auto-exit on (the agent's `auto-exit`, default true, overridden per
// call) the delegate closes its own window after a normal completion; the
// delegate's side lives in `child.ts`. With it off the window stays open.
// An agent's `exclude-tools` goes to the child as `--exclude-tools`; a name the
// session has no tool for leaves the agent out of the roster. Its `tools` goes
// as `--tools` and each of its `extensions` as `-e`, both for the child alone.
//
// The model gets three tools. `delegate` takes agent, task and optional model
// and thinking, validates them the way the command does, and starts the
// delegation at once, opening no dialog, so parallel calls cannot block one
// another. `delegation_status`
// reports each delegation as running (window open, no result yet), done (with
// its result status) or closed, with the session name, window, session and
// envelope paths.
// `delegation_close` kills the window and records the close. Inside a delegate
// (`PI_DELEGATE_PARENT` set) the extension registers only `child.ts`'s
// `/auto-exit` and handlers, so a delegate cannot delegate.
//
// The `session:launch` contract this package provides, and the `message:*`
// hooks it consumes, live in this package's README.
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { type Agent, isThinking, type Roster, readRoster, THINKING_LEVELS } from "./agents.ts";
import { AUTO_EXIT_ENV, registerChild } from "./child.ts";
import { activeMark, clearMarks, isFree, readMarks } from "./limits.ts";
import { createResults, delegateName } from "./results.ts";
import { createTmuxClient, type TmuxClient } from "./tmux.ts";
import { createTracking, toolResult } from "./tracking.ts";
import { createProactive, createUsageClient, type Proactive, type UsageClient } from "./usage.ts";

/** The hook a provider of `message:*` answers with the written request. */
const SEND = "message:send";
/** The hook emitted just before a delegate's window opens. */
const LAUNCH = "session:launch";
/** Set in a delegate's environment, so this extension stays off there. */
const PARENT_ENV = "PI_DELEGATE_PARENT";
/** Forwarded to the child when the parent has it set. */
const SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";
/** Asked of every delegate, so the parent gets an answer it can use alone. */
const FINAL_LINE =
	"End with one self-contained final message: the parent session sees only that message, never this conversation.";

/** The longest label a delegation can carry. */
const LABEL_MAX = 32;
/** A label is one safe tmux window name and session name segment. */
const LABEL = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Why `value` is not a usable label, or undefined when it is. */
function labelProblem(value: string): string | undefined {
	if (LABEL.test(value) && value.length <= LABEL_MAX) return undefined;
	return `label ${JSON.stringify(value)} must be at most ${LABEL_MAX} letters, digits, _ or -, starting with a letter or digit`;
}

/**
 * The paragraph that tells a delegate where its task comes from: the parent
 * session's address, whose messages are instructions; other sessions are
 * colleagues, and work they ask for that the parent did not is checked with
 * the parent first (spec Q37: distrust wording made models refuse all peer
 * mail). It names no provider, package or tool, so it holds for any
 * `message:*` provider.
 */
function parentTrust(parent: string): string {
	return [
		`Your task arrives as a message from the session that started this one, at address ${parent}.`,
		"That message, and every later message from that address, are instructions from the session that started you:",
		"follow them as given, even though they are labelled as another session's.",
		"Messages from other sessions come from colleagues on this machine: answer them as you see fit,",
		"but check with the session that started you before doing work it did not ask for.",
		`You can reach the session that started you at ${parent}.`,
	].join(" ");
}
/** The flags `/delegate` takes before the task. */
const FLAGS = ["--model", "--thinking", "--label", "--auto-exit", "--no-auto-exit"] as const;

const NOT_IN_TMUX = "this session is not inside tmux; start it in a tmux pane to open a delegate window";

const USAGE =
	"usage: /delegate <agent> [--model <provider/id>] [--thinking <level>] [--label <name>] [--auto-exit | --no-auto-exit] <task>";

type SendPayload = { to: unknown; body: unknown; envelope?: { id?: unknown }; error?: unknown };
type LaunchPayload = { args: string[]; env: Record<string, string>; agent: string };
type Parsed = { agent: string; model?: string; thinking?: string; label?: string; autoExit?: boolean; task: string };
/** A request that passed the roster, model, thinking and label checks. */
type Start = {
	agent: Agent;
	model: string;
	/** Candidates passed over for `model`, with why; empty unless a fallback was used. */
	skipped: Skipped[];
	/** Lines for the parent, such as a quota reading that failed. */
	notices: string[];
	thinking: string;
	label?: string;
	autoExit: boolean;
	task: string;
};
/** A candidate model passed over: `why` finishes "<model> is …", `reason` is the long form for a refusal. */
type Skipped = { model: string; why: string; reason: string };
/** A delegation that is open in a tmux window. */
type Launched = { id: string; name: string; windowId: string; windowName: string; requestId: string };

/**
 * Write the appended system prompt to a fresh owner-only directory under the
 * system temporary folder and return the file's path. Pi reads an existing
 * path as a file, so the prompt stays off the delegate's command line and out
 * of `ps`. The directory comes from `mkdtemp`, which no other user can
 * pre-create or swap.
 *
 * ponytail: one file per launch accumulates until the operating system clears
 * its temporary folder; the upgrade path is to delete the file once the poll
 * finds the window gone.
 */
function writePromptFile(prompt: string): string {
	const path = join(mkdtempSync(join(tmpdir(), "pi-squire-")), "prompt.md");
	writeFileSync(path, prompt, { mode: 0o600 });
	return path;
}

/** The runtimes whose executable needs the script from `process.argv[1]`. */
const RUNTIMES = new Set(["node", "nodejs", "bun", "deno"]);

/**
 * The parent's own Pi executable. Under a script runtime (node or bun) the
 * script is `argv[1]`; a compiled binary reports its own path as `execPath`
 * and its first user argument, if any, as `argv[1]`.
 */
function parentCommand(execPath = process.execPath, argv = process.argv): string[] {
	const runner = basename(execPath)
		.replace(/\.exe$/i, "")
		.toLowerCase();
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
			current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
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
		if (flag === "--auto-exit" || flag === "--no-auto-exit") {
			parsed.autoExit = flag === "--auto-exit";
			i += 1;
			continue;
		}
		if (flag !== "--model" && flag !== "--thinking" && flag !== "--label") {
			return { error: `unknown flag ${flag}; ${USAGE}` };
		}
		const value = tokens[i + 1]?.text;
		if (value === undefined || value.startsWith("--")) return { error: `${flag} needs a value; ${USAGE}` };
		if (flag === "--model") parsed.model = value;
		else if (flag === "--thinking") parsed.thinking = value;
		else parsed.label = value;
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
	const known = registry.find(value.slice(0, slash), value.slice(slash + 1));
	if (known !== undefined) {
		if (registry.hasConfiguredAuth(known)) return undefined;
		return `no credentials for model ${JSON.stringify(value)}; log in to the provider ${JSON.stringify(known.provider)} (/login), then try again`;
	}
	const names = registry.getAll().map((model) => `${model.provider}/${model.id}`);
	const close = closest(value, names);
	return `unknown model ${JSON.stringify(value)}${close.length > 0 ? `; close matches: ${close.join(", ")}` : ""}`;
}

/**
 * The model for a launch. An explicit model is the only candidate; otherwise
 * the agent's model then its fallbacks. The first candidate that passes
 * `modelProblem` and has no active mark wins; the rest are returned as skipped.
 * A paid candidate on a provider with a quota check is read first, and
 * skipped when its quota is used up. Refuses, listing every candidate, when
 * none is left.
 */
async function chooseModel(
	explicit: string | undefined,
	agent: Agent,
	models: ModelRegistry,
	proactive: Proactive,
): Promise<{ model: string; skipped: Skipped[]; notices: string[] }> {
	const candidates = explicit !== undefined ? [explicit] : [agent.model, ...agent.fallback];
	const skipped: Skipped[] = [];
	const notices: string[] = [];
	for (const model of candidates) {
		const problem = modelProblem(model, models);
		if (problem !== undefined) {
			skipped.push({ model, why: `unavailable (${problem})`, reason: problem });
			continue;
		}
		const slash = model.indexOf("/");
		const provider = model.slice(0, slash);
		const id = model.slice(slash + 1);
		let mark = activeMark(models, provider, id);
		if (mark !== undefined) {
			const cleared = await proactive.recheck(models, provider, id);
			for (const line of cleared) if (!notices.includes(line)) notices.push(line);
			if (cleared.length > 0) mark = activeMark(models, provider, id);
		}
		if (mark === undefined && !isFree(models, provider, id)) {
			const checked = await proactive.check(models, provider, id);
			if (checked.notice !== undefined && !notices.includes(checked.notice)) notices.push(checked.notice);
			mark = activeMark(models, provider, id) ?? checked.mark;
		}
		if (mark === undefined) return { model, skipped, notices };
		const what = mark.scope.includes("/") ? `model ${mark.scope}` : `provider ${mark.scope}`;
		const until = new Date(mark.clearsAt).toISOString();
		skipped.push({
			model,
			why: `usage-limited until ${until}`,
			reason: `usage-limited (${what}) until ${until}: ${mark.reason}`,
		});
	}
	if (skipped.length === 1) {
		const [only] = skipped;
		throw new Error(
			only.why.startsWith("usage-limited")
				? `${only.model} is ${only.reason}. Clear marks with /delegate-clear.`
				: only.reason,
		);
	}
	throw new Error(
		`no model is available for agent ${agent.name}:\n${skipped.map((item) => `- ${item.model}: ${item.reason}`).join("\n")}\nClear marks with /delegate-clear.`,
	);
}

/** The sentence that says a fallback ran, or "" when the agent's own model did. */
const fallbackNote = (start: Start): string =>
	start.skipped.length === 0
		? ""
		: `Used fallback ${start.model} because ${start.skipped.map((item) => `${item.model} is ${item.why}`).join("; ")}.`;

/** Why `value` is not a thinking level, or undefined when it is. */
function thinkingProblem(value: string): string | undefined {
	if (isThinking(value)) return undefined;
	const close = closest(value, THINKING_LEVELS);
	return `unknown thinking level ${JSON.stringify(value)}; levels: ${THINKING_LEVELS.join(", ")}${
		close.length > 0 ? `; close matches: ${close.join(", ")}` : ""
	}`;
}

/** The `delegate` tool's description: what delegation does, and the roster as it stands. */
function toolDescription(agents: readonly Agent[]): string {
	const intro =
		"Hand a self-contained task to a delegate Pi session in a background tmux window, so it works while you do not. Each call starts the delegation at once; the delegate runs in this session's working directory and agent root and reports back later as one message. Use it when the work is self-contained and you would rather keep your own context for it.";
	if (agents.length === 0) {
		return `${intro}\n\nNo agents are defined yet. Add ${join(
			getAgentDir(),
			"agents",
			"<name>",
			"AGENT.md",
		)} with frontmatter description, model and thinking (optionally auto-exit, exclude-tools, tools, extensions and fallback) and the prompt as its body; /delegate explains the format too.`;
	}
	return [
		intro,
		"",
		"Agents:",
		...agents.map(
			(agent) =>
				`- ${agent.name} — ${agent.description} (default ${[agent.model, ...agent.fallback.map((model) => `fallback ${model}`)].join(", ")}, thinking ${agent.thinking}${agent.autoExit ? "" : ", auto-exit off"}${
					agent.excludeTools.length > 0 ? `, no ${agent.excludeTools.join("/")}` : ""
				}${agent.tools.length > 0 ? `, only ${agent.tools.join("/")}` : ""})`,
		),
		"",
		"`model` and `thinking` override the agent's defaults for this call; an unknown value is refused with close matches. `label` names the delegate's window and session; give one that says what the task is. `delegation_status` reports a delegation, and `delegation_close` ends one.",
		"`auto_exit` (default the agent's, normally true) closes the delegate's window once it finishes. Set it false when you mean to keep talking to the delegate by mail after its result; the user can also keep a window open by typing in it.",
		"",
		"Writing the task: the delegate sees nothing of this session, so the task must stand alone. State the question, the decision its answer feeds, what is already known or ruled out, and the files or paths to start from. When the work produces a report, name the path to write it to and ask for the conclusion back, not the contents.",
	].join("\n");
}

/**
 * Register `/delegate` and the three tools. The second and third
 * parameters are test-only seams, for tmux and for the usage readers: Pi
 * passes only `pi`, so they are not part of the package's documented contract.
 */
export default function delegate(
	pi: ExtensionAPI,
	tmux: TmuxClient = createTmuxClient(),
	usage: UsageClient = createUsageClient(),
): void {
	// A delegate registers only its auto-exit side: `delegate` is one level deep (Q27).
	const parentId = process.env[PARENT_ENV] ?? "";
	if (parentId !== "") {
		registerChild(pi, parentId);
		return;
	}

	const results = createResults(pi);

	const proactive = createProactive(usage);
	const tracking = createTracking(pi, results, tmux, proactive.errors);

	/** Captured because `getArgumentCompletions` is called without a context. */
	let registry: ModelRegistry | undefined;

	const modelIds = (source: ModelRegistry | undefined): string[] =>
		(source?.getAll() ?? []).map((model) => `${model.provider}/${model.id}`);

	/**
	 * The session's tool names, which `exclude-tools` must name; undefined
	 * while Pi is still loading extensions and cannot list them yet.
	 */
	function sessionTools(): string[] | undefined {
		try {
			return pi.getAllTools().map((tool) => tool.name);
		} catch {
			return undefined;
		}
	}

	/** The roster as it stands, checked against the session's tools. */
	const currentRoster = (): Roster => readRoster(getAgentDir(), sessionTools());

	/** Read the roster now, warning about every file left out. */
	function rosterFor(ctx: ExtensionContext): Roster {
		const roster = currentRoster();
		for (const warning of roster.warnings) ctx.ui.notify(`delegate: ${warning}`, "warning");
		return roster;
	}

	/** The request as a start, or an error naming what to fix. */
	async function validate(request: Parsed, roster: Roster, models: ModelRegistry): Promise<Start> {
		if (roster.agents.length === 0) {
			throw new Error(
				`no agents are defined; add ${join(
					getAgentDir(),
					"agents",
					"<name>",
					"AGENT.md",
				)} with frontmatter description, model and thinking (optionally auto-exit, exclude-tools, tools, extensions and fallback), and the prompt as its body`,
			);
		}
		const agent = roster.agents.find((candidate) => candidate.name === request.agent);
		if (agent === undefined) {
			throw new Error(
				`no agent named ${JSON.stringify(request.agent)}; available: ${roster.agents.map((item) => item.name).join(", ")}`,
			);
		}
		if (request.task.trim() === "") throw new Error("a task is required");
		const thinking = request.thinking ?? agent.thinking;
		const { model, skipped, notices } = await chooseModel(request.model, agent, models, proactive);
		const badThinking = thinkingProblem(thinking);
		if (badThinking !== undefined) throw new Error(badThinking);
		const badLabel = request.label === undefined ? undefined : labelProblem(request.label);
		if (badLabel !== undefined) throw new Error(badLabel);
		return {
			agent,
			model,
			skipped,
			notices,
			thinking,
			label: request.label,
			autoExit: request.autoExit ?? agent.autoExit,
			task: request.task,
		};
	}

	/** The launch order of the spec: task, argv, env, listeners, window, record. */
	async function launch(start: Start, ctx: ExtensionContext): Promise<Launched> {
		if (!tmux.insideTmux()) throw new Error(NOT_IN_TMUX);

		// The task goes on disk before the window exists: the delegate finds it
		// at session start without a handshake, and a window that fails leaves
		// mail that is reported rather than cleaned up.
		const id = randomUUID();
		const sent: SendPayload = { to: id, body: start.task };
		pi.events.emit(SEND, sent);
		if (typeof sent.error === "string") throw new Error(`could not send the task to ${id}: ${sent.error}`);
		if (sent.envelope === undefined) {
			throw new Error(
				`needs a provider of message:* to send the task; install a mailbox extension (for example pi-session-mail)`,
			);
		}
		const requestId = sent.envelope.id;
		if (typeof requestId !== "string") throw new Error(`the message:send provider wrote no request id for ${id}`);

		const parent = ctx.sessionManager.getSessionId();
		const name = delegateName(start.agent.name, id, start.label);
		const prompt = writePromptFile(`${start.agent.prompt}\n\n${FINAL_LINE}\n\n${parentTrust(parent)}`);
		const argv = [
			...parentCommand(),
			"--session-id",
			id,
			"--name",
			name,
			"--model",
			start.model,
			"--thinking",
			start.thinking,
			...start.agent.extensions.flatMap((extension) => ["-e", extension]),
			...(start.agent.tools.length > 0 ? ["--tools", start.agent.tools.join(",")] : []),
			...(start.agent.excludeTools.length > 0 ? ["--exclude-tools", start.agent.excludeTools.join(",")] : []),
			"--append-system-prompt",
			prompt,
		];
		const env: Record<string, string> = {
			PI_CODING_AGENT_DIR: getAgentDir(),
			[PARENT_ENV]: parent,
			[AUTO_EXIT_ENV]: start.autoExit ? "1" : "0",
		};
		const sessionDir = process.env[SESSION_DIR_ENV];
		if (sessionDir !== undefined && sessionDir !== "") env[SESSION_DIR_ENV] = sessionDir;
		// Listeners may only append to `args` and add to `env`; there is no veto.
		const payload: LaunchPayload = { args: argv, env, agent: start.agent.name };
		pi.events.emit(LAUNCH, payload);

		const windowName = name;
		let windowId: string;
		try {
			windowId = await tmux.openWindow({ name: windowName, cwd: ctx.cwd, argv: payload.args, env: payload.env });
		} catch (err) {
			throw new Error(`could not open window ${windowName} for ${id}: ${(err as Error).message}`);
		}

		// No task text in the record: the request copy in `sent/` has it.
		results.recordStart(
			{
				id,
				agent: start.agent.name,
				model: start.model,
				thinking: start.thinking,
				name,
				windowId,
				windowName,
				requestId,
				autoExit: start.autoExit,
			},
			ctx,
		);
		tracking.startPolling();
		return { id, name, windowId, windowName, requestId };
	}

	const started = (launched: Launched, start: Start): string =>
		`delegate: ${start.agent.name} ${launched.id} started in window ${launched.windowName}${start.skipped.length > 0 ? `. ${fallbackNote(start)}` : ""}${start.notices.map((line) => `. ${line}`).join("")}`;

	async function command(input: string, ctx: ExtensionContext): Promise<void> {
		const fail = (message: string) => ctx.ui.notify(`delegate: ${message}`, "error");
		const outcome = parse(input);
		if ("error" in outcome) {
			fail(outcome.error);
			return;
		}
		try {
			const start = await validate(outcome.parsed, rosterFor(ctx), ctx.modelRegistry);
			const launched = await launch(start, ctx);
			ctx.ui.notify(started(launched, start), "info");
		} catch (err) {
			fail((err as Error).message);
		}
	}

	/** The tool's description is fixed at registration, so it is rebuilt at every session start. */
	const delegateTool = () => ({
		name: "delegate",
		label: "Delegate",
		description: toolDescription(currentRoster().agents),
		parameters: Type.Object({
			agent: Type.String({ description: "Roster agent name to run." }),
			task: Type.String({
				description: "The task for the delegate. It sees this and its agent prompt, nothing else of this session.",
			}),
			model: Type.Optional(Type.String({ description: "provider/id model for this call; defaults to the agent's." })),
			thinking: Type.Optional(
				Type.String({ description: `Thinking level (${THINKING_LEVELS.join(", ")}); defaults to the agent's.` }),
			),
			label: Type.Optional(
				Type.String({
					description: `A short name for this delegation (letters, digits, _ or -, at most ${LABEL_MAX}), such as roster-research. Its session and tmux window are named <agent>-<label>; without it, <agent>-<first 8 id characters>.`,
				}),
			),
			auto_exit: Type.Optional(
				Type.Boolean({
					description:
						"Close the delegate's window once it finishes; defaults to the agent's setting. False keeps it open to talk to it by mail after its result.",
				}),
			),
		}),
		async execute(
			_toolCallId: string,
			params: { agent: string; task: string; model?: string; thinking?: string; label?: string; auto_exit?: boolean },
			_signal: unknown,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			if (!tmux.insideTmux()) throw new Error(NOT_IN_TMUX);
			const start = await validate(
				{
					agent: params.agent,
					model: params.model,
					thinking: params.thinking,
					label: params.label,
					autoExit: typeof params.auto_exit === "boolean" ? params.auto_exit : undefined,
					task: params.task ?? "",
				},
				rosterFor(ctx),
				ctx.modelRegistry,
			);
			const launched = await launch(start, ctx);
			ctx.ui.notify(started(launched, start), "info");
			return toolResult(
				`Started delegation ${launched.id}: ${start.agent.name} (${start.model}, thinking ${start.thinking}) in window ${launched.windowName}. It runs in the background and its result arrives as a message; delegation_status reports it and delegation_close ends it.${start.skipped.length > 0 ? ` ${fallbackNote(start)}` : ""}${start.notices.map((line) => ` ${line}`).join("")}`,
				{
					outcome: "started",
					id: launched.id,
					agent: start.agent.name,
					model: start.model,
					skipped: start.skipped.map(({ model, reason }) => ({ model, reason })),
					notices: start.notices,
					thinking: start.thinking,
					autoExit: start.autoExit,
					windowId: launched.windowId,
					windowName: launched.windowName,
				},
			);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		registry = ctx.modelRegistry;
		tracking.restore(ctx);
		// The roster is read at call time; the description can only be fixed here.
		pi.registerTool(delegateTool() as never);
	});

	pi.on("session_shutdown", () => {
		tracking.stop();
	});

	/** Agent names, flags, model ids and thinking levels, at the cursor's token. */
	function completions(prefix: string): { value: string; label: string }[] | null {
		const partial = /(?:^|\s)(\S*)$/.exec(prefix)?.[1] ?? "";
		const head = prefix.slice(0, prefix.length - partial.length);
		const pick = (values: readonly string[]) => {
			const hits = values.filter((value) => value.startsWith(partial));
			return hits.length > 0 ? hits.map((value) => ({ value: head + value, label: value })) : null;
		};
		const tokens = head.trim() === "" ? [] : head.trim().split(/\s+/);
		if (tokens.length === 0) return pick(currentRoster().agents.map((agent) => agent.name));
		const previous = tokens[tokens.length - 1];
		if (previous === "--model") return pick(modelIds(registry));
		if (previous === "--thinking") return pick(THINKING_LEVELS);
		return pick(FLAGS);
	}

	pi.registerCommand("delegate", {
		description: `Start a delegate Pi session in a background tmux window: ${USAGE}`,
		getArgumentCompletions: completions,
		handler: command,
	});

	pi.registerCommand("delegate-clear", {
		description: "Clear usage-limit marks: all, a provider, or a provider/model",
		getArgumentCompletions: (prefix: string) => {
			const hits = [
				"all",
				...readMarks()
					.filter((m) => m.clearsAt > Date.now())
					.map((m) => m.scope),
			].filter((v) => v.startsWith(prefix.trim()));
			return hits.length > 0 ? hits.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args: string, ctx: ExtensionContext) => {
			const target = args.trim();
			const cleared = target === "" ? [] : clearMarks(target);
			if (cleared.length > 0) proactive.clear();
			const active = readMarks().filter((m) => m.clearsAt > Date.now());
			const list = active.map((m) => `${m.scope} until ${new Date(m.clearsAt).toISOString()}`).join(", ");
			ctx.ui.notify(
				cleared.length > 0
					? `delegate-clear: cleared ${cleared.join(", ")}.`
					: active.length === 0
						? "delegate-clear: no usage-limit marks are active."
						: `delegate-clear: ${target === "" ? "name a mark to clear" : `no active mark matches "${target}"`}. Active marks: ${list}. Use all, a provider or provider/model.`,
				"info",
			);
		},
	});

	pi.registerTool(delegateTool() as never);
	tracking.registerTools();
}
