// pi-squire: hand a task to a delegate Pi session in a background tmux
// window, over the `message:*` hooks.
//
// `/delegate <agent> [--model <provider/id>] [--thinking <level>]
// [--label <name>] [--cwd <dir> | --worktree <branch> [--worktree-source <dir>] [--worktree-base <commit-ish>] ] [--auto-exit | --no-auto-exit] <task…>`
// reads the agent from `<agent dir>/agents/<name>.md` or, in a trusted project,
// `<cwd>/.pi/agents/<name>.md` (`agents.ts`), writes the task
// to the delegate's inbox through `message:send`, emits `session:launch` so
// listeners can add arguments and environment, then opens a window in the
// parent's working directory, or the existing directory `--cwd` selects
// (`workspace.ts`), running the parent's own Pi. The window and the
// session share one name: `<agent>-<label>`, or `<agent>-<first 8 of the id>`
// without a label. Starting a delegation adds nothing to
// the model's context. Each delegation is recorded
// in the parent session; its answer is taken over on `message:inbound` and
// shown as one result message, so the parent hears back on its own.
//
// With auto-exit on (the agent's `auto_exit`, default true, overridden per
// call) the delegate closes its own window after a normal completion; the
// delegate's side lives in `child.ts`. With it off the window stays open.
// An agent's `tools`, or the parent's active tools when it has no `tools`
// field (less any `-name` entries), goes to the child as `--tools` with the
// `delegateTools` setting added (`--no-tools` when that leaves nothing).
// An agent with no `model` or `thinking` runs
// on the parent's.
//
// The model gets four tools. `delegate` takes agent, task and optional model
// and thinking, validates them the way the command does, and starts the
// delegation at once, opening no dialog, so parallel calls cannot block one
// another; the one exception is a `cwd` whose project trust is unresolved,
// which the user answers in the parent. `delegation_status`
// reports each delegation as running (window open, no result yet), done (with
// its result status) or closed, with the session name, window, session and
// envelope paths.
// `delegation_close` kills the window and records the close. `delegation_resume`
// (`resume.ts`) reopens an exited delegate's session in a new window with a
// follow-up task, recorded as a new delegation. A delegate can launch children
// only below maxDepth and with its current agent allow_nested_delegation grant.
// Durable identity restores that boundary even on a manual session reopening.
//
// The `session:launch` contract this package provides, and the `message:*`
// hooks it consumes, live in this package's README.
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	type Agent,
	delegateTools,
	disabledProblem,
	globalAgentsDir,
	isThinking,
	projectAgentsDir,
	type Roster,
	readRoster,
	THINKING_LEVELS,
	withoutLocked,
} from "./agents.ts";
import { AGENT_ENV, AUTO_EXIT_ENV, FALLBACK_ENV, registerChild } from "./child.ts";
import { registerCompletionHost } from "./completion-holds.ts";
import { createIdentity, grantsNesting, type Identity, readIdentity, writeIdentity } from "./identity.ts";
import { activeMark, clearMarks, isFree, readMarks } from "./limits.ts";
import { createNavigator, OPEN_USAGE, openCompletions, parseOpen } from "./navigator.ts";
import { type NewDelegateDeps, type NewRequest, startNewDelegate } from "./new-delegate.ts";
import { dirtyNotice, renderDelegateCall, renderDelegateResult, resourceLine } from "./render.ts";
import { createResults, delegateName, isStarted, sessionIdOf, type WorkspaceAttempt } from "./results.ts";
import { createResume, type ResumeRequest, resumableIds, startedLine } from "./resume.ts";
import { pickResume } from "./resume-picker.ts";
import { ownedAPI, SessionOwner, sessionIsOwned } from "./session-owner.ts";
import { registerTaskReplies } from "./task-replies.ts";
import { createTmuxClient, type OpenedWindow, requireTmuxVersion, type TmuxClient, WindowOpenError } from "./tmux.ts";
import { availableTools } from "./tool-names.ts";
import { createTracking, toolResult } from "./tracking.ts";
import { treeNotice } from "./tree-notice.ts";
import {
	assertParentPlacement,
	bindTree,
	claimTree,
	dispatchTree,
	failedTree,
	finishTree,
	openedTree,
	publishTreeRecords,
	type Reservation,
	readTree,
	reconcileTree,
	reserveTree,
} from "./tree-registry.ts";
import { assertResumeAuthority, historicalRecord, visibleRecords } from "./tree-view.ts";
import { registerTrustControl } from "./trust-control.ts";
import { createProactive, createUsageClient, type Proactive, type UsageClient } from "./usage.ts";
import { registerDelegateWidget } from "./widget.ts";
import { registerActivityRuntime } from "./widget-activity-runtime.ts";
import { assertRootPlacement, placementProject, type WindowPlacement, windowPlacement } from "./window-placement.ts";
import {
	normalizeWorkspaceValue,
	prepareDirectory,
	trustPlannedWorktree,
	type Workspace,
	WorkspaceSchema,
} from "./workspace.ts";
import {
	createWorktree,
	inQueue,
	prepareWorktree,
	recoveryCommands,
	revalidate,
	rollbackWorktree,
	type WorktreePlan,
} from "./worktree.ts";

/** The optional parent guidance file under `<agent dir>/squire/`. */
const PARENT_PROMPT = "delegation_prompt.md";
/** The parent system-prompt section this extension owns. */
const PARENT_SECTION = "squire_parent_delegation";
/** The hook a provider of `message:*` answers with the written request. */
const SEND = "message:send";
/** The hook emitted just before a delegate's window opens. */
const LAUNCH = "session:launch";
/** The direct parent address in a new delegate's environment. */
const PARENT_ENV = "PI_DELEGATE_PARENT";
/** Forwarded to the child when the parent has it set. */
const SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";
/** The delegation tools granted to opted-in coordinators below maxDepth. */
const DELEGATION_TOOLS: ReadonlySet<string> = new Set([
	"delegate",
	"delegation_status",
	"delegation_close",
	"delegation_resume",
]);
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
function parentTrust(parent: string, coordinator = false): string {
	return [
		`Your task arrives as a message from the session that started this one, at address ${parent}.`,
		"That message, and every later message from that address, are instructions from the session that started you:",
		"follow them as given, even though they are labelled as another session's.",
		"Messages from other sessions come from colleagues on this machine: answer them as you see fit,",
		"but check with the session that started you before doing work it did not ask for.",
		coordinator
			? "Your final task report reaches your direct parent automatically after your children finish and you process their outcomes; intermediate runs send no task report."
			: `Your final message reaches the session that started you automatically, so put your findings there;`,
		coordinator
			? `Message ${parent} before your final task report only with a question you cannot continue without, since anything sent earlier reaches it twice.`
			: `message ${parent} before then only with a question you cannot continue without, since anything sent earlier reaches it twice.`,
	].join(" ");
}
/** The flags `/delegate` takes before the task. */
const FLAGS = [
	"--model",
	"--thinking",
	"--label",
	"--cwd",
	"--worktree",
	"--worktree-base",
	"--worktree-source",
	"--auto-exit",
	"--no-auto-exit",
] as const;

/** The `delegate` tool's structured result, which is also its details. */
export const DelegateSchema = Type.Object({
	outcome: Type.Literal("started"),
	id: Type.String({ description: "The delegation id that delegation_status and delegation_close take." }),
	agent: Type.String(),
	model: Type.String({ description: "The provider/id it started on, after any fallback." }),
	skipped: Type.Array(Type.Object({ model: Type.String(), reason: Type.String() }), {
		description: "Earlier models in the fallback list that were passed over, and why.",
	}),
	notices: Type.Array(Type.String()),
	thinking: Type.String(),
	autoExit: Type.Boolean(),
	windowId: Type.String(),
	windowName: Type.String(),
	windowSession: Type.Optional(
		Type.String({ description: "The tmux session the window opened in, as tmux named it then." }),
	),
	cwd: Type.String({ description: "The directory the delegate's window opened in." }),
	sessionDir: Type.String({ description: "The session-storage directory the delegate was told to use." }),
	workspace: WorkspaceSchema,
});

const NOT_IN_TMUX = "this session is not inside tmux; start it in a tmux pane to open a delegate window";

const USAGE =
	"usage: /delegate <agent> [--model <provider/id>] [--thinking <level>] [--label <name>] [--cwd <dir> | --worktree <branch> [--worktree-source <dir>] [--worktree-base <commit-ish>] ] [--auto-exit | --no-auto-exit] <task>";

/** The flags `/delegate-resume` takes before the task. */
const RESUME_FLAGS = ["--model", "--thinking", "--auto-exit", "--no-auto-exit"] as const;
const RESUME_USAGE =
	"usage: /delegate-resume <id> [--model <provider/id>] [--thinking <level>] [--auto-exit | --no-auto-exit] <task>";

type SendPayload = { to: unknown; body: unknown; envelope?: { id?: unknown }; error?: unknown };
/** `cwd` is informational: the window opens in the launch's own value, whatever a listener assigns. */
type LaunchPayload = {
	args: string[];
	env: Record<string, string>;
	agent: string;
	readonly cwd: string;
	readonly parent: string;
	readonly root: string;
	readonly depth: number;
	readonly chain: readonly string[];
	readonly toolCallId: string | undefined;
};
type Parsed = {
	agent: string;
	model?: string;
	thinking?: string;
	label?: string;
	cwd?: string;
	worktree?: string;
	worktree_base?: string;
	worktree_source?: string;
	autoExit?: boolean;
	task: string;
};
/** A request that passed the roster, model, thinking and label checks. */
type Start = {
	agent: Agent;
	model: string;
	/** Candidates passed over for `model`, with why; empty unless a fallback was used. */
	skipped: Skipped[];
	/** Lines for the parent, such as a quota reading that failed. */
	notices: string[];
	/** The candidates after `model`, for the delegate to move to on a usage limit; empty for an explicit model. */
	rest: string[];
	thinking: string;
	label?: string;
	/** The existing directory to run in, as given; undefined inherits the parent's. */
	cwd?: string;
	/** The new local branch to create a worktree for; undefined creates none. */
	worktree?: string;
	worktree_base?: string;
	worktree_source?: string;
	autoExit: boolean;
	task: string;
};
/** A candidate model passed over: `why` finishes "<model> is …", `reason` is the long form for a refusal. */
type Skipped = { model: string; why: string; reason: string };
/** What opening a delegate's window reads from a request: a `Start`, or the parts of one a resume decides. */
type ChildStart = Pick<Start, "agent" | "model" | "rest" | "thinking" | "autoExit" | "notices">;
/** A delegation that is open in a tmux window. */
type Launched = {
	id: string;
	name: string;
	windowId: string;
	windowName: string;
	/** The session the window opened in; undefined when tmux could not say. */
	windowSession: string | undefined;
	requestId: string;
	cwd: string;
	sessionDir: string;
	workspace: Workspace;
};

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

/** One whitespace-separated word of `text` at or after `from`, verbatim; undefined at the end. */
function word(text: string, from: number): { text: string; start: number; end: number } | undefined {
	const match = /\S+/g;
	match.lastIndex = from;
	const found = match.exec(text);
	return found === null ? undefined : { text: found[0], start: found.index, end: found.index + found[0].length };
}

/**
 * A flag's value at or after `from`: a plain word, or a double-quoted string
 * in which `\"` and `\\` stand for `"` and `\`. No shell expansion of any kind.
 */
function flagValue(
	text: string,
	from: number,
	flag: string,
	usage: string = USAGE,
): { value: string; end: number } | { error: string } {
	const next = word(text, from);
	if (next === undefined || next.text.startsWith("--")) return { error: `${flag} needs a value; ${usage}` };
	if (!next.text.startsWith('"')) return { value: next.text, end: next.end };
	let value = "";
	let i = next.start + 1;
	while (i < text.length && text[i] !== '"') {
		const escaped = text[i] === "\\" && (text[i + 1] === '"' || text[i + 1] === "\\");
		value += escaped ? text[i + 1] : text[i];
		i += escaped ? 2 : 1;
	}
	if (i >= text.length) return { error: `${flag}'s value has no closing quote; ${usage}` };
	if (i + 1 < text.length && !/\s/.test(text[i + 1])) {
		return { error: `${flag}'s quoted value must be followed by a space; ${usage}` };
	}
	return { value, end: i + 1 };
}

/** `/delegate`'s arguments: an agent, optional flags, then a verbatim task. */
function parse(text: string): { parsed: Parsed } | { error: string } {
	const agent = word(text, 0);
	if (agent === undefined) return { error: USAGE };
	if (agent.text.startsWith("-")) return { error: `the first argument is the agent name; ${USAGE}` };
	const parsed: Parsed = { agent: agent.text, task: "" };
	let at = agent.end;
	for (let next = word(text, at); next?.text.startsWith("-"); next = word(text, at)) {
		const flag = next.text;
		if (flag === "--auto-exit" || flag === "--no-auto-exit") {
			parsed.autoExit = flag === "--auto-exit";
			at = next.end;
			continue;
		}
		if (
			flag !== "--model" &&
			flag !== "--thinking" &&
			flag !== "--label" &&
			flag !== "--cwd" &&
			flag !== "--worktree" &&
			flag !== "--worktree-base" &&
			flag !== "--worktree-source"
		) {
			return { error: `unknown flag ${flag}; ${USAGE}` };
		}
		const read = flagValue(text, next.end, flag);
		if ("error" in read) return read;
		if (flag === "--model") parsed.model = read.value;
		else if (flag === "--thinking") parsed.thinking = read.value;
		else if (flag === "--label") parsed.label = read.value;
		else if (flag === "--cwd") parsed.cwd = read.value;
		else if (flag === "--worktree") parsed.worktree = read.value;
		else if (flag === "--worktree-base") parsed.worktree_base = read.value;
		else parsed.worktree_source = read.value;
		at = read.end;
	}
	// The task is the rest of the text from its first word, untouched by flag parsing.
	parsed.task = text.slice(word(text, at)?.start ?? text.length).trim();
	if (parsed.task === "") return { error: `a task is required after the agent and flags; ${USAGE}` };
	return { parsed };
}

/** `/delegate-resume`'s arguments: a delegation id, optional flags, then a verbatim task. */
function parseResume(text: string): { request: ResumeRequest } | { error: string } {
	const id = word(text, 0);
	if (id === undefined) return { error: RESUME_USAGE };
	if (id.text.startsWith("-")) return { error: `the first argument is the delegation id; ${RESUME_USAGE}` };
	const request: ResumeRequest = { id: id.text, task: "" };
	let at = id.end;
	for (let next = word(text, at); next?.text.startsWith("-"); next = word(text, at)) {
		const flag = next.text;
		if (flag === "--auto-exit" || flag === "--no-auto-exit") {
			request.autoExit = flag === "--auto-exit";
			at = next.end;
			continue;
		}
		if (flag !== "--model" && flag !== "--thinking") return { error: `unknown flag ${flag}; ${RESUME_USAGE}` };
		const read = flagValue(text, next.end, flag, RESUME_USAGE);
		if ("error" in read) return read;
		if (flag === "--model") request.model = read.value;
		else request.thinking = read.value;
		at = read.end;
	}
	request.task = text.slice(word(text, at)?.start ?? text.length).trim();
	if (request.task === "") return { error: `a task is required after the id and flags; ${RESUME_USAGE}` };
	return { request };
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

/** The registry's model for an exact `provider/id`; undefined for anything else, such as a pattern. */
function registered(value: string, registry: ModelRegistry): { provider: string; id: string } | undefined {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return undefined;
	return registry.find(value.slice(0, slash), value.slice(slash + 1));
}

/** An agent's own models in order: its `model`, or the parent's when it has none, then its fallbacks. */
function agentModels(agent: Agent, parentModel: string | undefined): string[] {
	const first = agent.model ?? parentModel;
	return [...(first === undefined ? [] : [first]), ...agent.fallback];
}

/**
 * The model for a launch. An explicit model is the only candidate; otherwise
 * `preferred`, by default `own`: the agent's model then its fallbacks. The
 * first candidate that passes `modelProblem` and has no active mark wins; the
 * rest are returned as skipped. A paid candidate on a provider with a quota
 * check is read first, and skipped when its quota is used up. A candidate from
 * the agent file that is not an exact `provider/id` the registry knows, such
 * as a pattern, is passed to the child unchanged for Pi to resolve. Refuses,
 * listing every candidate, when none is left. A resume passes its own
 * `preferred`.
 */
async function chooseModel(
	explicit: string | undefined,
	agent: Agent,
	models: ModelRegistry,
	proactive: Proactive,
	own: readonly string[],
	preferred: readonly string[] = own,
): Promise<{ model: string; skipped: Skipped[]; notices: string[]; rest: string[] }> {
	const candidates = explicit !== undefined ? [explicit] : [...preferred];
	if (candidates.length === 0)
		throw new Error(
			`agent ${agent.name} names no model and this session has none; add model to ${agent.path}, or pass one`,
		);
	const skipped: Skipped[] = [];
	const notices: string[] = [];
	for (const model of candidates) {
		const rest = () => candidates.slice(candidates.indexOf(model) + 1);
		if (explicit === undefined && registered(model, models) === undefined)
			return { model, skipped, notices, rest: rest() };
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
		if (mark === undefined) return { model, skipped, notices, rest: rest() };
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
		if (!only.why.startsWith("usage-limited")) throw new Error(only.reason);
		// An explicit model is never substituted, but the refusal names the agent's models still open.
		const open = own.filter((model) => {
			if (model === only.model) return false;
			if (registered(model, models) === undefined) return true;
			if (modelProblem(model, models) !== undefined) return false;
			const slash = model.indexOf("/");
			return activeMark(models, model.slice(0, slash), model.slice(slash + 1)) === undefined;
		});
		const hint =
			explicit !== undefined && open.length > 0
				? ` Omit model to launch ${agent.name} on ${open[0]}${open.length > 1 ? ` (also open: ${open.slice(1).join(", ")})` : ""}, or clear marks with /delegate-clear.`
				: " Clear marks with /delegate-clear.";
		throw new Error(`${only.model} is ${only.reason}.${hint}`);
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

/** Read `<agent dir>/squire/delegation_prompt.md`; missing or whitespace-only means no guidance. */
function readParentPrompt(): { text?: string; error?: string } {
	const path = join(getAgentDir(), "squire", PARENT_PROMPT);
	try {
		const text = readFileSync(path, "utf8");
		return text.trim() === "" ? {} : { text };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
		return {
			error: `could not read ${path}: ${(err as Error).message}; parent delegation guidance is off for this run`,
		};
	}
}

/** Whether this run exposes `delegate` after tool selection and hidden declarations. */
function delegateVisible(options: { selectedTools: string[]; hiddenTools: string[] }): boolean {
	return options.selectedTools.includes("delegate") && !options.hiddenTools.includes("delegate");
}

/** Where agent files go, for the messages that say how to add one. */
function whereAgentsGo(): string {
	return `${join(globalAgentsDir(getAgentDir()), "<name>.md")} (or .pi/agents/<name>.md in a trusted project), with the delegate's instructions as its body and optional frontmatter: description, model, thinking, tools, fallback, auto_exit, prompt_mode, display_name, locked and enabled`;
}

/** One roster line for the `delegate` tool's description. */
function rosterLine(agent: Agent): string {
	const models = [agent.model ?? "this session's model", ...agent.fallback.map((model) => `fallback ${model}`)];
	const details = [
		`default ${models.join(", ")}`,
		`thinking ${agent.thinking ?? "this session's"}`,
		...(agent.autoExit ? [] : ["auto-exit off"]),
		...toolsDetail(agent),
		...(agent.locked.length > 0 ? [`locked: ${agent.locked.join("/")}`] : []),
	];
	const shown = agent.displayName === undefined ? "" : ` "${agent.displayName}"`;
	return `- ${agent.name}${shown} — ${agent.description} (${details.join(", ")})`;
}

/**
 * The entry that makes Pi filter MCP tools by `--tools`. Pi keeps every MCP
 * tool registered (callable from codemode, loadable by tool_search) unless an
 * entry starts with `mcp__`; this one does and names no tool, since an MCP
 * tool is `mcp__<server>__<tool>`.
 */
const MCP_FILTER = "mcp__";

/**
 * The child's tool arguments for a selection: `--tools` with exactly those
 * tools, MCP tools included, or `--no-tools` (which Pi applies to MCP tools
 * too) when it is empty. Always explicit: no flag would give the child the
 * parent's tools rather than Pi's defaults.
 */
function toolArgs(tools: readonly string[]): string[] {
	if (tools.length === 0) return ["--no-tools"];
	const filtered = tools.some((name) => name.startsWith(MCP_FILTER)) ? tools : [...tools, MCP_FILTER];
	return ["--tools", filtered.join(",")];
}

/** The roster line's word on an agent's tools; nothing for the parent's tools unchanged. */
function toolsDetail(agent: Agent): string[] {
	if (agent.tools !== undefined) return [agent.tools.length > 0 ? `tools: ${agent.tools.join("/")}` : "no tools"];
	return agent.toolsExcept.length > 0 ? [`tools: this session's except ${agent.toolsExcept.join("/")}`] : [];
}

/** Whether tool `name` is `pattern`, where `*` matches any characters, as in Pi's tool lists. */
function toolMatches(pattern: string, name: string): boolean {
	const source = pattern
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${source}$`).test(name);
}

/**
 * The delegate's tool selection, always a plain list: the agent's `tools`
 * names, or `parentTools` less its `-name` entries when it has none, then
 * `extra` (the `delegateTools` setting), with the delegation tools left out.
 * Empty means the delegate gets no tools.
 */
function toolSelection(agent: Agent, parentTools: readonly string[], extra: readonly string[]): string[] {
	const base =
		agent.tools ?? parentTools.filter((name) => !agent.toolsExcept.some((pattern) => toolMatches(pattern, name)));
	return [...new Set([...base, ...extra])].filter((name) => !DELEGATION_TOOLS.has(name));
}

/** The delegate's appended prompt: the agent's body, then the lines every delegate gets. */
function delegatePrompt(agent: Agent, parent: string, managedContext: string, coordinator: boolean): string {
	const final = coordinator
		? "End the task with one self-contained final report to your direct parent after your child tasks finish and you process their outcomes."
		: FINAL_LINE;
	const tail = `${final}\n\n${parentTrust(parent, coordinator)}${managedContext}`;
	if (agent.prompt === "") return tail;
	// `replace` is how every delegate was built before `prompt_mode`, byte for byte.
	const body =
		agent.promptMode === "replace" ? agent.prompt : `<agent_instructions>\n${agent.prompt}\n</agent_instructions>`;
	return `${body}\n\n${tail}`;
}

/** The `delegate` tool's description: what delegation does, and the roster as it stands. */
function toolDescription(agents: readonly Agent[]): string {
	const intro =
		"Hand a self-contained task to a delegate Pi session in a background tmux window, so it works while you do not. Each call starts the delegation at once; the delegate runs in this session's working directory, or the cwd given, with this session's agent root, and reports back later as one message. While it runs, keep working or end your turn: its result starts your next turn on its own. Do not poll delegation_status or send a blocking mail request merely to wait for the result; send a substantive follow-up only when you have something to add or ask. Use it when the work is self-contained and you would rather keep your own context for it.";
	if (agents.length === 0) {
		return `${intro}\n\nNo agents are defined yet. Add ${whereAgentsGo()}.`;
	}
	return [
		intro,
		"",
		"Agents:",
		...agents.map(rosterLine),
		"",
		"`cwd` runs the delegate in another existing directory. Alternatively, `worktree` creates a new local branch and checkout from this repository's committed HEAD, or `worktree_source` selects another existing Git checkout; `worktree_base` selects a commit in that source. Source dirt is reported but not copied. `cwd` and `worktree` are mutually exclusive, and source/base require worktree.",
		"`model` and `thinking` override the agent's defaults for this call, except a field the agent locks; an unknown value is refused with close matches. `label` names the delegate's window and session; give one that says what the task is. `delegation_status` reports a delegation, and `delegation_close` ends one. `delegation_resume` continues an exited delegate in its own session with a follow-up task, for work that needs the context it already built.",
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
	api: ExtensionAPI,
	tmux: TmuxClient = createTmuxClient(),
	usage: UsageClient = createUsageClient(),
): void {
	const owner = new SessionOwner();
	const host = api;
	host.on("session_start", (_event, ctx) => owner.start(ctx));
	host.events.on("message:inbound", (payload) => owner.receive(payload as import("./results.ts").Inbound));
	const pi = ownedAPI(host, owner);
	const externalReady = registerCompletionHost(pi);
	const identity = createIdentity(pi);
	const results = createResults(
		pi,
		() => identity.current() !== undefined,
		(ctx, records) =>
			publishTreeRecords(
				identity.current()?.root ?? ctx.sessionManager.getSessionId(),
				ctx.sessionManager.getSessionId(),
				records,
			),
		() => owner.active(),
		(ctx) =>
			readTree(identity.current()?.root ?? ctx.sessionManager.getSessionId())
				.entries.filter((entry) => entry.identity.parent === ctx.sessionManager.getSessionId() && entry.closed)
				.map((entry) => entry.id),
	);
	pi.on("session_start", (_event, ctx) => tracking.restore(ctx));
	const replies = registerTaskReplies(
		pi,
		() => identity.current()?.parent,
		() => {
			try {
				owner.assert();
				identity.current();
				return results.completionReady() && externalReady();
			} catch {
				return false;
			}
		},
		(ctx) => coordinates(currentRoster(ctx)),
		(ctx, ids) => {
			owner.assert();
			const own = identity.current();
			if (own) finishTree(own.root, ctx.sessionManager.getSessionId(), ids);
		},
	);
	registerChild(pi, replies, identity.current, () => owner.active());
	host.on("session_start", () => owner.arm());
	// Restore answers synchronously before this potentially slow tmux read.
	pi.on("session_start", async (_event, ctx) => {
		try {
			const own = identity.current();
			if (!own) return;
			const window = await tmux.currentWindow?.();
			owner.assert();
			claimTree(own.root, ctx.sessionManager.getSessionId(), window);
		} catch (error) {
			ctx.ui.notify(
				`delegate: could not publish startup accounting: ${String(error)}; uncertain reservations remain charged.`,
				"error",
			);
		}
	});

	const proactive = createProactive(usage);
	let viewContext: ExtensionContext | undefined;
	pi.on("session_start", (_event, ctx) => {
		viewContext = ctx;
	});
	pi.on("session_start", async (_event, ctx) => {
		if (!identity.current() && results.list().length === 0) {
			try {
				await treeNotice(ctx, tmux, () => owner.active());
			} catch (error) {
				ctx.ui.notify(`delegate: owner discovery unavailable: ${String(error)}`, "warning");
			}
		}
	});
	const viewResults = {
		...results,
		list: () => (viewContext ? visibleRecords(results, viewContext) : results.list()),
		find: (id: string) =>
			viewContext ? visibleRecords(results, viewContext).find((record) => record.id === id) : results.find(id),
	};
	const tracking = createTracking(pi, results, tmux, proactive.errors, viewResults, () => owner.assert());
	const trustControl = registerTrustControl(pi, identity.current);
	// Factual lifecycle observation survives failed action processing; only creation needs ownership.
	registerActivityRuntime(host, () => owner.active(), tmux, owner.token);
	registerDelegateWidget(
		pi,
		results,
		tmux,
		async (ctx, sessionId) => {
			owner.assert();
			await navigator.panel(ctx, sessionId);
		},
		() => owner.assert(),
	);

	/** Captured because `getArgumentCompletions` is called without a context. */
	let registry: ModelRegistry | undefined;
	/** The latest context, for the roster a completion reads; undefined before the session starts. */
	let latest: ExtensionContext | undefined;

	const modelIds = (source: ModelRegistry | undefined): string[] =>
		(source?.getAll() ?? []).map((model) => `${model.provider}/${model.id}`);

	/** The project's agents folder when `ctx`'s project is trusted; undefined otherwise or without a context. */
	function trustedProject(ctx: ExtensionContext | undefined): string | undefined {
		if (ctx === undefined) return undefined;
		try {
			return ctx.isProjectTrusted() ? projectAgentsDir(ctx.cwd) : undefined;
		} catch {
			return undefined; // a stale context after a session replacement
		}
	}

	/** The roster as it stands: the global agents, and the project's when it is trusted. */
	const currentRoster = (ctx: ExtensionContext | undefined = latest): Roster =>
		readRoster(getAgentDir(), trustedProject(ctx));

	/** What an agent with no `model` or `thinking` runs on: the parent's model and level now. */
	function parentDefaults(ctx: ExtensionContext): { model?: string; thinking: string } {
		let thinking = "medium";
		try {
			thinking = pi.getThinkingLevel();
		} catch {
			// Pi binds this before any call can reach here; the default only covers a host without it.
		}
		return { ...(ctx.model === undefined ? {} : { model: `${ctx.model.provider}/${ctx.model.id}` }), thinking };
	}

	/**
	 * The delegate's tools for a launch or resume starting now: the agent's
	 * named tools, or the parent's current tools (including indirect callable
	 * tools when nested, less any `-name` entries), then `delegateTools`.
	 * Throws, naming the file, on an invalid setting.
	 */
	function childTools(agent: Agent): string[] {
		const selected = toolSelection(
			agent,
			agent.tools === undefined ? (identity.current() ? availableTools(pi) : pi.getActiveTools()) : [],
			delegateTools(getAgentDir()),
		);
		if (grantsNesting(agent, (identity.current()?.depth ?? 0) + 1)) selected.push(...DELEGATION_TOOLS);
		return [...new Set(selected)];
	}

	function coordinates(roster: Roster): boolean {
		const own = identity.current();
		const agent = roster.agents.find((item) => item.name === own?.agent);
		return own !== undefined && agent !== undefined && grantsNesting(agent, own.depth);
	}

	function admit(agent: string, roster: Roster): void {
		owner.assert();
		results.checkStorage();
		identity.admit(agent, roster);
	}

	function exposeDelegation(roster: Roster): void {
		if (!identity.current()) return;
		const enabled = coordinates(roster);
		const base = pi.getActiveTools().filter((name) => !DELEGATION_TOOLS.has(name));
		pi.setActiveTools(enabled ? [...base, ...DELEGATION_TOOLS] : base);
	}

	/** Read the roster now, warning about every file left out. */
	function rosterFor(ctx: ExtensionContext): Roster {
		const roster = currentRoster(ctx);
		for (const warning of roster.warnings) ctx.ui.notify(`delegate: ${warning}`, "warning");
		return roster;
	}

	/** The roster warnings already shown this session, so a run shows only new ones. */
	const announced = new Set<string>();

	/** Show each roster warning not yet shown this session, such as a file that is disabled. */
	function announce(roster: Roster, ctx: ExtensionContext): void {
		for (const warning of roster.warnings) {
			if (announced.has(warning)) continue;
			announced.add(warning);
			ctx.ui.notify(`delegate: ${warning}`, "warning");
		}
	}

	/** The refusal for an empty roster. */
	const noAgents = (): string => `no agents are defined; add ${whereAgentsGo()}`;

	/** The request as a start, or an error naming what to fix. */
	async function validate(request: Parsed, roster: Roster, ctx: ExtensionContext): Promise<Start> {
		admit(request.agent, roster);
		results.checkStorage(true);
		const disabled = disabledProblem(roster, request.agent);
		if (disabled !== undefined) throw new Error(disabled);
		if (roster.agents.length === 0) throw new Error(noAgents());
		const agent = roster.agents.find((candidate) => candidate.name === request.agent);
		if (agent === undefined) {
			throw new Error(
				`no agent named ${JSON.stringify(request.agent)}; available: ${roster.agents.map((item) => item.name).join(", ")}`,
			);
		}
		if (request.task.trim() === "") throw new Error("a task is required");
		const parent = parentDefaults(ctx);
		const own = agentModels(agent, parent.model);
		const defaultThinking = agent.thinking ?? parent.thinking;
		const unlocked = withoutLocked(agent, request, { model: own[0], thinking: defaultThinking });
		const thinking = unlocked.request.thinking ?? defaultThinking;
		const chosen = await chooseModel(unlocked.request.model, agent, ctx.modelRegistry, proactive, own);
		const { model, skipped, rest } = chosen;
		const notices = unlocked.notice === undefined ? chosen.notices : [unlocked.notice, ...chosen.notices];
		const badThinking = thinkingProblem(thinking);
		if (badThinking !== undefined) throw new Error(badThinking);
		const badLabel = request.label === undefined ? undefined : labelProblem(request.label);
		if (badLabel !== undefined) throw new Error(badLabel);
		return {
			agent,
			model,
			skipped,
			notices,
			rest,
			thinking,
			label: request.label,
			cwd: request.cwd,
			worktree: request.worktree,
			worktree_base: request.worktree_base,
			worktree_source: request.worktree_source,
			autoExit: request.autoExit ?? agent.autoExit,
			task: request.task,
		};
	}

	/** Write the task to the delegate's inbox and return its request id; the delegate finds it at session start. */
	function sendTask(to: string, task: string): string {
		const sent: SendPayload = { to, body: task };
		pi.events.emit(SEND, sent);
		if (typeof sent.error === "string") throw new Error(`could not send the task to ${to}: ${sent.error}`);
		if (sent.envelope === undefined)
			throw new Error(
				"needs a provider of message:* to send the task; install a mailbox extension (for example pi-session-mail)",
			);
		const requestId = sent.envelope.id;
		if (typeof requestId !== "string") throw new Error(`the message:send provider wrote no request id for ${to}`);
		return requestId;
	}

	/**
	 * Build the delegate's command line and environment, emit `session:launch`
	 * and open its window; returns the window id and session. A launch and a resume share
	 * it and differ only in `session`, the arguments that choose the session:
	 * `--session-id <id> --name <name>` for a new one, `--session <path>` to reopen.
	 */
	async function openChild(input: {
		id: string;
		name: string;
		session: string[];
		workspace: Workspace;
		trusted: boolean;
		cwd: string;
		sessionDir: string;
		start: ChildStart;
		/** The tool call that started this launch or resume; undefined from a command. */
		toolCallId: string | undefined;
		ctx: ExtensionContext;
		/** Chosen once, when the launch or resume began, so no later settings change can refuse it after mail. */
		placement: WindowPlacement;
		/** The delegate's tools, from `toolSelection`, read when the launch began; empty means none. */
		tools: readonly string[];
		onWindowOpened?: () => void;
		identity: Identity;
		sessionId?: string;
	}): Promise<OpenedWindow> {
		const {
			id,
			name,
			session,
			workspace,
			trusted,
			cwd,
			sessionDir,
			start,
			toolCallId,
			ctx,
			placement,
			tools,
			onWindowOpened,
		} = input;
		admit(start.agent.name, currentRoster(ctx));
		results.checkStorage(true);
		if (input.sessionId && sessionIsOwned(input.sessionId))
			throw new Error(`delegate session ${input.sessionId} is already open; resume refused before spawn`);
		const own = input.identity;
		assertRootPlacement(own.rootPlacement);
		own.autoExit = start.autoExit;
		writeIdentity(input.sessionId ?? id, own);
		const parent = own.parent;
		const managedContext =
			workspace.mode === "managed"
				? `\n\nYour managed worktree is ${workspace.cwd}, branch ${workspace.createdBranch}, based on commit ${workspace.baseCommit}.`
				: workspace.mode === "existing"
					? `\n\nThe session that started you chose your working directory: ${workspace.cwd}`
					: "";
		const prompt = writePromptFile(
			delegatePrompt(start.agent, parent, managedContext, grantsNesting(start.agent, own.depth)),
		);
		const argv = [
			...parentCommand(),
			...session,
			// Always explicit, so a permissive global default cannot trust what the parent does not.
			trusted ? "--approve" : "--no-approve",
			"--session-dir",
			sessionDir,
			"--model",
			start.model,
			"--thinking",
			start.thinking,
			...toolArgs(tools),
			"--append-system-prompt",
			prompt,
		];
		const env: Record<string, string> = {
			PI_CODING_AGENT_DIR: getAgentDir(),
			// Private live metadata correlation: resume retains session id, not launch id.
			PI_SQUIRE_LIVE_LAUNCH: JSON.stringify({ version: 1, sessionId: input.sessionId ?? id, launchId: id }),
			[PARENT_ENV]: parent,
			PI_DELEGATE_ROOT: own.root,
			PI_DELEGATE_DEPTH: String(own.depth),
			PI_DELEGATE_CHAIN: own.chain.join(","),
			[AUTO_EXIT_ENV]: start.autoExit ? "1" : "0",
			[AGENT_ENV]: start.agent.name,
			// A general signal for any extension: no human watches this session, so don't wait on a dialog.
			PI_UNATTENDED: "1",
		};
		if (start.rest.length > 0) env[FALLBACK_ENV] = start.rest.join(",");
		// Pi ranks `--session-dir` above this variable, so it cannot move the child's storage.
		const envSessionDir = process.env[SESSION_DIR_ENV];
		if (envSessionDir !== undefined && envSessionDir !== "") env[SESSION_DIR_ENV] = envSessionDir;
		// Listeners may only append to `args` and add to `env`; there is no veto.
		const payload: LaunchPayload = {
			args: argv,
			env,
			agent: start.agent.name,
			cwd,
			toolCallId,
			parent: own.parent,
			root: own.root,
			depth: own.depth,
			chain: Object.freeze([...own.chain]),
		};
		for (const key of ["parent", "root", "depth", "chain"] as const)
			Object.defineProperty(payload, key, { writable: false, configurable: false });
		pi.events.emit(LAUNCH, payload);
		const token: Reservation = { root: own.root, id };
		bindTree(token, { windowName: name, cwd, workspace });
		dispatchTree(token);
		let opened: OpenedWindow;
		try {
			opened = await tmux.openWindow({ name, cwd, argv: payload.args, env: payload.env }, placement, own.rootPlacement);
		} catch (err) {
			if (err instanceof WindowOpenError && err.certainty === "not-opened") {
				try {
					failedTree(token, true);
				} catch (accounting) {
					ctx.ui.notify(
						`delegate: could not refund the pre-start reservation: ${String(accounting)}; it remains charged.`,
						"warning",
					);
				}
			}
			if (err instanceof WindowOpenError) {
				throw new WindowOpenError(`could not open window ${name} for ${id}: ${err.message}`, err.certainty);
			}
			throw new WindowOpenError(`could not open window ${name} for ${id}: ${(err as Error).message}`, "unknown");
		}
		onWindowOpened?.();
		try {
			openedTree(token, opened.id);
		} catch (error) {
			ctx.ui.notify(
				`delegate: window ${opened.id} opened, but shared accounting publication failed: ${String(error)}. Local tracking continues; the reservation remains charged until accounting reconciles.`,
				"warning",
			);
		}
		return opened;
	}

	async function launchWindow(input: {
		identity: Identity;
		id: string;
		requestId: string;
		workspace: Workspace;
		trusted: boolean;
		cwd: string;
		sessionDir: string;
		start: Start;
		toolCallId: string | undefined;
		ctx: ExtensionContext;
		placement: WindowPlacement;
		tools: readonly string[];
		onWindowOpened: () => void;
	}): Promise<Launched> {
		const { id, requestId, workspace, trusted, cwd, sessionDir, start, toolCallId, ctx, placement, onWindowOpened } =
			input;
		const name = delegateName(start.agent.displayName ?? start.agent.name, id, start.label);
		const { id: windowId, session: windowSession } = await openChild({
			id,
			name,
			session: ["--session-id", id, "--name", name],
			identity: input.identity,
			workspace,
			trusted,
			cwd,
			sessionDir,
			start,
			toolCallId,
			ctx,
			placement,
			tools: input.tools,
			onWindowOpened,
		});
		// No task text in the record: the request copy in `sent/` has it.
		results.recordStart(
			{
				id,
				identity: readIdentity(id),
				agent: start.agent.name,
				...(start.agent.displayName === undefined ? {} : { displayName: start.agent.displayName }),
				model: start.model,
				thinking: start.thinking,
				name,
				windowId,
				windowName: name,
				requestId,
				autoExit: start.autoExit,
				cwd,
				sessionDir,
				workspace,
			},
			ctx,
		);
		tracking.startPolling();
		return { id, name, windowId, windowName: name, windowSession, requestId, cwd, sessionDir, workspace };
	}

	async function launch(
		start: Start,
		ctx: ExtensionContext,
		signal?: AbortSignal,
		toolCallId?: string,
	): Promise<Launched> {
		admit(start.agent.name, currentRoster(ctx));
		results.checkStorage(true);
		if (!tmux.insideTmux()) throw new Error(NOT_IN_TMUX);
		await requireTmuxVersion(tmux);
		// Read once, before anything is created or mailed; the launch keeps these values.
		const placement = windowPlacement(getAgentDir());
		const parentIdentity = identity.current();
		const project = parentIdentity
			? { companion: parentIdentity.rootPlacement, notices: [] }
			: placementProject(ctx.cwd);
		assertRootPlacement(project.companion);
		const own = identity.child(start.agent, ctx, project.companion);
		if (parentIdentity) assertParentPlacement(readTree(own.root), own);
		if (placement === "companion") start.notices.push(...project.notices);
		const tools = childTools(start.agent);
		const sessionDir = ctx.sessionManager.getSessionDir();
		if (!isAbsolute(sessionDir))
			throw new Error(
				`the parent's session directory ${JSON.stringify(sessionDir)} is not an absolute path; start Pi with an absolute --session-dir`,
			);
		const cwdOption = normalizeWorkspaceValue(start.cwd, "cwd");
		const worktreeOption = normalizeWorkspaceValue(start.worktree, "worktree");
		const baseOption = normalizeWorkspaceValue(start.worktree_base, "worktree_base");
		const sourceOption = normalizeWorkspaceValue(start.worktree_source, "worktree_source");
		if (sourceOption !== undefined && worktreeOption === undefined)
			throw new Error("worktree_source requires worktree");
		if (baseOption !== undefined && worktreeOption === undefined) throw new Error("worktree_base requires worktree");
		if (cwdOption !== undefined && worktreeOption !== undefined)
			throw new Error("cwd and worktree are mutually exclusive; name only one");
		const signals = [signal, ctx.signal].filter((item): item is AbortSignal => item !== undefined);
		const combined = signals.length ? AbortSignal.any(signals) : undefined;
		let plan: WorktreePlan | undefined;
		let directory: Workspace | undefined;
		let trusted: boolean;
		let revalidateTrust: (() => void) | undefined;
		if (worktreeOption !== undefined) {
			plan = await prepareWorktree(
				{
					worktree: worktreeOption,
					...(baseOption === undefined ? {} : { worktree_base: baseOption }),
					...(sourceOption === undefined ? {} : { worktree_source: sourceOption }),
				},
				ctx,
				getAgentDir(),
			);
			if (combined?.aborted) throw new Error("the launch was aborted");
			const trust = await trustPlannedWorktree(
				plan,
				ctx,
				getAgentDir(),
				combined,
				trustControl.forAgent(start.agent.name, ctx),
			);
			if (combined?.aborted) throw new Error("the launch was aborted");
			trusted = trust.trusted;
			revalidateTrust = trust.revalidate;
			plan.trusted = trusted;
		} else {
			const prepared = await prepareDirectory(
				{ cwd: cwdOption, signal, trust: trustControl.forAgent(start.agent.name, ctx) },
				ctx,
				getAgentDir(),
			);
			directory = prepared.workspace;
			trusted = prepared.trusted;
		}
		const id = randomUUID();
		const parentId = ctx.sessionManager.getSessionId();
		let attempt: WorkspaceAttempt | undefined;
		let managed: Extract<Workspace, { mode: "managed" }> | undefined;
		let windowOpened = false;
		let reservation: Reservation | undefined;
		const run = async (): Promise<Launched> => {
			admit(start.agent.name, currentRoster(ctx));
			results.checkStorage(true);
			await reconcileTree(own.root, tmux);
			admit(start.agent.name, currentRoster(ctx));
			if (combined?.aborted) throw new Error("the launch was aborted");
			reservation = reserveTree({ id, sessionId: id, identity: own, sessionDir });
			if (plan !== undefined) {
				revalidate(plan);
				revalidateTrust?.();
				attempt = {
					kind: "workspace-attempt",
					id,
					parentId,
					agent: start.agent.name,
					model: start.model,
					thinking: start.thinking,
					...(start.label === undefined ? {} : { name: start.label }),
					sessionDir,
					plan,
					attempt: { phase: "planned", resources: { kind: "none" } },
				};
				results.recordAttempt(attempt, ctx);
				const created = createWorktree(plan);
				if (!("workspace" in created)) {
					const recovery = recoveryCommands(plan, created.resources);
					attempt = {
						...attempt,
						attempt:
							created.resources.kind === "none"
								? { phase: "rolled-back", resources: { kind: "none" }, cause: created.cause }
								: { phase: "retained", resources: created.resources, cause: created.cause, recovery },
					};
					results.recordAttempt(attempt, ctx);
					throw new Error(
						`worktree launch ${id} from ${plan.sourceCwd} failed at ${plan.destination} (${plan.branch}): ${created.cause}; ${resourceLine(created.resources)}${recovery.length ? `; recovery: ${recovery.join("; ")}` : created.resources.kind === "worktree" ? "; inspect and preserve its contents before any cleanup" : ""}`,
					);
				}
				managed = created.workspace;
				attempt = {
					...attempt,
					attempt: {
						phase: "created",
						resources: { kind: "worktree", cwd: managed.cwd, branch: managed.createdBranch, head: managed.baseCommit },
					},
				};
				results.recordAttempt(attempt, ctx);
			}
			let workspace: Workspace;
			if (managed !== undefined) workspace = managed;
			else if (directory !== undefined) workspace = directory;
			else throw new Error("workspace preparation did not produce a launch directory");
			// The task goes on disk before the window exists: the delegate finds it
			// at session start without a handshake, and a window that fails leaves
			// mail that is reported rather than cleaned up.
			const requestId = sendTask(id, start.task);
			bindTree(reservation, { requestId });
			if (attempt !== undefined) {
				attempt = { ...attempt, requestId };
				results.recordAttempt(attempt, ctx);
			}
			return launchWindow({
				identity: own,
				id,
				requestId,
				workspace,
				trusted,
				cwd: workspace.cwd,
				sessionDir,
				start,
				toolCallId,
				ctx,
				placement,
				tools,
				onWindowOpened: () => {
					windowOpened = true;
				},
			});
		};
		const runWithRollback = async (): Promise<Launched> => {
			try {
				return await run();
			} catch (error) {
				if (reservation) {
					try {
						failedTree(reservation);
					} catch (accounting) {
						ctx.ui.notify(`delegate: reservation remains charged: ${String(accounting)}`, "error");
					}
				}
				if (attempt !== undefined && managed !== undefined) {
					const cause = (error as Error).message;
					if (windowOpened || (error instanceof WindowOpenError && error.certainty === "unknown")) {
						attempt = {
							...attempt,
							attempt: {
								phase: "retained",
								resources: {
									kind: "worktree",
									cwd: managed.cwd,
									branch: managed.createdBranch,
									head: managed.baseCommit,
								},
								cause,
								recovery: [],
							},
						};
					} else {
						const rollbackPlan = plan;
						if (rollbackPlan === undefined) throw error;
						const rolled = rollbackWorktree(rollbackPlan, managed);
						attempt =
							rolled.kind === "rolled-back"
								? { ...attempt, attempt: { phase: "rolled-back", resources: { kind: "none" }, cause } }
								: {
										...attempt,
										attempt: {
											phase: "retained",
											resources: rolled.resources,
											cause: `${cause}; ${rolled.reason}`,
											recovery: recoveryCommands(rollbackPlan, rolled.resources),
										},
									};
					}
					results.recordAttempt(attempt, ctx);
					const state = attempt.attempt;
					const recovery =
						state.phase !== "retained"
							? ""
							: state.recovery.length > 0
								? `; recovery: ${state.recovery.join("; ")}`
								: state.resources.kind === "worktree"
									? "; inspect and preserve its contents before any cleanup"
									: "";
					throw new Error(
						`worktree launch ${id} from ${managed.sourceCwd} at ${managed.cwd} (${managed.createdBranch}) failed: ${cause}; outcome ${state.phase}${recovery}`,
						{ cause: error },
					);
				}
				throw error;
			}
		};
		if (plan === undefined) return runWithRollback();
		return inQueue(plan.source.commonDir, combined, runWithRollback);
	}

	const resumer = createResume({
		results,
		tmux,
		delegateSchema: DelegateSchema,
		notInTmux: NOT_IN_TMUX,
		startPolling: tracking.startPolling,
		placement: () => windowPlacement(getAgentDir()),
		roster: rosterFor,
		admit: (agent, ctx) => admit(agent, currentRoster(ctx)),
		authorize: (id, ctx) => {
			owner.assert();
			results.checkStorage();
			const record = results.find(id) ?? viewResults.find(id) ?? historicalRecord(id, ctx);
			if (record && isStarted(record)) assertResumeAuthority(record, ctx);
		},
		reserve: async (record, id, ctx) => {
			const own = record.identity;
			if (!own) throw new Error(`delegation ${record.id} has no original root placement identity; resume refused`);
			assertRootPlacement(own.rootPlacement);
			await reconcileTree(own.root, tmux);
			admit(record.agent, currentRoster(ctx));
			return reserveTree({
				id,
				sessionId: sessionIdOf(record),
				identity: own,
				resumedFrom: record.id,
				sessionDir: record.sessionDir,
			});
		},
		parentDefaults,
		chooseModel: (explicit, agent, models, preferred) =>
			chooseModel(explicit, agent, models, proactive, agentModels(agent, undefined), preferred),
		thinkingProblem,
		prepareDirectory: (cwd, ctx, signal, agent) =>
			prepareDirectory({ cwd, signal, trust: trustControl.forAgent(agent, ctx) }, ctx, getAgentDir()),
		sendTask,
		open: ({
			id,
			name,
			sessionPath,
			workspace,
			trusted,
			cwd,
			sessionDir,
			start,
			toolCallId,
			ctx,
			placement,
			identity: own,
			sessionId,
		}) =>
			openChild({
				id,
				name,
				session: ["--session", sessionPath],
				identity: own,
				sessionId,
				workspace,
				trusted,
				cwd,
				sessionDir,
				start,
				toolCallId,
				ctx,
				placement,
				// Read before the window opens, and a resume mails only after it opens.
				tools: childTools(start.agent),
			}),
	});

	/** The session a window opened in, for the start text. */
	const inSession = (session: string | undefined): string => (session === undefined ? "" : ` in session ${session}`);

	/** Where a selected directory put the delegate, for the start text; inherited starts stay compact. */
	const placedIn = (launched: Launched): string =>
		launched.workspace.mode !== "inherited" ? ` in ${launched.cwd}` : "";

	const started = (launched: Launched, start: Start): string =>
		`delegate: ${start.agent.name} ${launched.id} started in window ${launched.windowName}${inSession(launched.windowSession)}${placedIn(launched)}${launched.workspace.mode === "managed" ? `. Branch ${launched.workspace.createdBranch} starts at ${launched.workspace.baseCommit}. ${dirtyNotice(launched.workspace.sourceDirty)}` : ""}${start.skipped.length > 0 ? `. ${fallbackNote(start)}` : ""}${start.notices.map((line) => `. ${line}`).join("")}`;

	/** Start a delegate from a parsed `/delegate` or the form, telling the user how it went. */
	async function runDelegate(parsed: Parsed, ctx: ExtensionContext): Promise<void> {
		const fail = (message: string) => ctx.ui.notify(`delegate: ${message}`, "error");
		try {
			const cwd = normalizeWorkspaceValue(parsed.cwd, "--cwd");
			const worktree_source = normalizeWorkspaceValue(parsed.worktree_source, "--worktree-source");
			const worktree_base = normalizeWorkspaceValue(parsed.worktree_base, "--worktree-base");
			const worktree = normalizeWorkspaceValue(parsed.worktree, "--worktree");
			if (worktree_source !== undefined && worktree === undefined)
				throw new Error("--worktree-source requires --worktree");
			const start = await validate({ ...parsed, cwd, worktree, worktree_base, worktree_source }, rosterFor(ctx), ctx);
			const launched = await launch(start, ctx);
			ctx.ui.notify(started(launched, start), "info");
		} catch (err) {
			fail((err as Error).message);
		}
	}

	/** What the new-delegate form needs, shared by `/delegate` and the panel's `n`. */
	const newDelegateDeps: NewDelegateDeps = {
		unavailable: () => (tmux.insideTmux() ? undefined : NOT_IN_TMUX),
		roster: rosterFor,
		noAgents,
		defaults: (agent, ctx) => {
			const parent = parentDefaults(ctx);
			const model = agentModels(agent, parent.model)[0];
			return { ...(model === undefined ? {} : { model }), thinking: agent.thinking ?? parent.thinking };
		},
		labelProblem,
		start: (request: NewRequest, context) => runDelegate(request, context),
	};

	/** `/delegate`: with no arguments the new-delegate form, otherwise the typed request. */
	async function command(input: string, ctx: ExtensionContext): Promise<void> {
		if (input.trim() === "") {
			await startNewDelegate(ctx, newDelegateDeps);
			return;
		}
		const outcome = parse(input);
		if ("error" in outcome) {
			ctx.ui.notify(`delegate: ${outcome.error}`, "error");
			return;
		}
		await runDelegate(outcome.parsed, ctx);
	}

	async function resumePicker(ctx: ExtensionContext, id?: string): Promise<void> {
		await pickResume(
			ctx,
			{
				unavailable: () => (tmux.insideTmux() ? undefined : NOT_IN_TMUX),
				eligible: resumer.eligible,
				resume: async (request, context) => {
					try {
						context.ui.notify(startedLine(await resumer.resume(request, context)), "info");
					} catch (err) {
						context.ui.notify(`delegate: ${(err as Error).message}`, "error");
					}
				},
			},
			id,
		);
	}

	async function resumeCommand(input: string, ctx: ExtensionContext): Promise<void> {
		if (input.trim() === "") return resumePicker(ctx);
		const outcome = parseResume(input);
		if ("error" in outcome) {
			ctx.ui.notify(`delegate: ${outcome.error}`, "error");
			return;
		}
		try {
			ctx.ui.notify(startedLine(await resumer.resume(outcome.request, ctx)), "info");
		} catch (err) {
			ctx.ui.notify(`delegate: ${(err as Error).message}`, "error");
		}
	}

	/** The roster description last registered, so unchanged metadata is not registered again. */
	let registeredDescription: string | undefined;

	const delegateTool = (description: string) => ({
		name: "delegate",
		label: "Delegate",
		description,
		parameters: Type.Object({
			agent: Type.String({ description: "Roster agent name to run." }),
			task: Type.String({
				description: "The task for the delegate. It sees this and its agent prompt, nothing else of this session.",
			}),
			model: Type.Optional(
				Type.String({
					description:
						"provider/id model for this call; defaults to the agent's, or this session's when it names none. Not used when the agent locks model.",
				}),
			),
			thinking: Type.Optional(
				Type.String({
					description: `Thinking level (${THINKING_LEVELS.join(", ")}); defaults to the agent's, or this session's when it names none. Not used when the agent locks thinking.`,
				}),
			),
			label: Type.Optional(
				Type.String({
					description: `A short name for this delegation (letters, digits, _ or -, at most ${LABEL_MAX}), such as roster-research. Its session and tmux window are named <agent>-<label>; without it, <agent>-<first 8 id characters>.`,
				}),
			),
			cwd: Type.Optional(
				Type.Union([Type.String(), Type.Null()], {
					description:
						"An existing directory to run the delegate in: absolute, relative to this session's working directory, or starting with ~/. Omit to run in this session's working directory. The directory is used as it is; nothing is created or cleaned up. Mutually exclusive with worktree.",
				}),
			),
			worktree: Type.Optional(
				Type.Union([Type.String(), Type.Null()], {
					description:
						"Create a new managed worktree and local branch with this literal branch name, from this repository's committed HEAD or explicit worktree_base. Source dirt is not copied. Mutually exclusive with cwd.",
				}),
			),
			worktree_source: Type.Optional(
				Type.Union([Type.String(), Type.Null()], {
					description:
						"Existing Git checkout to create from; relative to this session or starting with ~/. Requires worktree.",
				}),
			),
			worktree_base: Type.Optional(
				Type.Union([Type.String(), Type.Null()], {
					description: "Local commit-ish to create the branch from; requires worktree. No fetch is performed.",
				}),
			),
			auto_exit: Type.Optional(
				Type.Boolean({
					description:
						"Close the delegate's window once it finishes; defaults to the agent's setting. False keeps it open to talk to it by mail after its result.",
				}),
			),
		}),
		outputSchema: DelegateSchema,
		renderCall: renderDelegateCall,
		renderResult: renderDelegateResult,
		// Opens a new window each call and removes nothing. Open world: the delegate calls a remote model and runs its agent's tools unattended.
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		async execute(
			toolCallId: string,
			params: {
				agent: string;
				task: string;
				model?: string | null;
				thinking?: string | null;
				label?: string | null;
				auto_exit?: boolean | null;
				cwd?: unknown;
				worktree?: unknown;
				worktree_base?: unknown;
				worktree_source?: unknown;
			},
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			if (!tmux.insideTmux()) throw new Error(NOT_IN_TMUX);
			// Some models fill every optional field with null or the string "null"; both mean unset.
			const given = (value: string | null | undefined) => (value == null || value === "null" ? undefined : value);
			const cwd = normalizeWorkspaceValue(params.cwd, "cwd");
			const worktree = normalizeWorkspaceValue(params.worktree, "worktree");
			const worktree_base = normalizeWorkspaceValue(params.worktree_base, "worktree_base");
			const worktree_source = normalizeWorkspaceValue(params.worktree_source, "worktree_source");
			const start = await validate(
				{
					agent: params.agent,
					model: given(params.model),
					thinking: given(params.thinking),
					label: given(params.label),
					cwd,
					worktree,
					worktree_base,
					worktree_source,
					autoExit: typeof params.auto_exit === "boolean" ? params.auto_exit : undefined,
					task: params.task ?? "",
				},
				rosterFor(ctx),
				ctx,
			);
			const launched = await launch(start, ctx, signal, toolCallId);
			ctx.ui.notify(started(launched, start), "info");
			return toolResult(
				`Started delegation ${launched.id}: ${start.agent.name} (${start.model}, thinking ${start.thinking}) in window ${launched.windowName}${inSession(launched.windowSession)}${placedIn(launched)}.${launched.workspace.mode === "managed" ? ` Branch ${launched.workspace.createdBranch} starts at ${launched.workspace.baseCommit}. ${dirtyNotice(launched.workspace.sourceDirty)}` : ""} It runs in the background, and its result arrives as a message that starts your next turn on its own; delegation_close ends it.${start.skipped.length > 0 ? ` ${fallbackNote(start)}` : ""}${start.notices.map((line) => ` ${line}`).join("")}`,
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
					...(launched.windowSession === undefined ? {} : { windowSession: launched.windowSession }),
					cwd: launched.cwd,
					sessionDir: launched.sessionDir,
					workspace: launched.workspace,
				},
			);
		},
	});

	const registerDelegate = (description: string): void => {
		pi.registerTool(delegateTool(description) as never);
		registeredDescription = description;
	};

	pi.on("session_start", (_event, ctx) => {
		registry = ctx.modelRegistry;
		latest = ctx;
		// The roster is read at call time; the description is rebuilt here and before each run.
		const roster = currentRoster(ctx);
		announced.clear();
		announce(roster, ctx);
		registerDelegate(toolDescription(roster.agents));
		exposeDelegation(roster);
	});

	// One roster/prompt snapshot prepares this run: refresh the description only when
	// it changed, and replace only this extension's prompt section from the same snapshot.
	pi.on("before_agent_start", (event, ctx) => {
		latest = ctx;
		const own = identity.current();
		const roster = currentRoster(ctx);
		if (own)
			event.systemPromptOptions.sections.squire_delegate_task = `You are a delegate. ${parentTrust(own.parent, coordinates(roster))}`;
		else delete event.systemPromptOptions.sections.squire_delegate_task;
		exposeDelegation(roster);
		announce(roster, ctx);
		const description = toolDescription(roster.agents);
		const prompt = readParentPrompt();
		const visible = delegateVisible(event.systemPromptOptions) && pi.getActiveTools().includes("delegate");
		// Report a read failure even when guidance cannot be used, so it does not go unseen.
		if (prompt.error !== undefined) ctx.ui.notify(`delegate: ${prompt.error}`, "warning");
		if (visible && description !== registeredDescription) registerDelegate(description);
		if (!visible || prompt.error !== undefined || prompt.text === undefined) {
			delete event.systemPromptOptions.sections[PARENT_SECTION];
			return;
		}
		event.systemPromptOptions.sections[PARENT_SECTION] = prompt.text;
	});

	pi.on("session_shutdown", () => {
		tracking.stop();
	});
	host.on("session_shutdown", () => owner.stop());

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

	/** Delegation ids, flags, model ids and thinking levels, at the cursor's token. */
	function resumeCompletions(prefix: string): { value: string; label: string }[] | null {
		const partial = /(?:^|\s)(\S*)$/.exec(prefix)?.[1] ?? "";
		const head = prefix.slice(0, prefix.length - partial.length);
		const tokens = head.trim() === "" ? [] : head.trim().split(/\s+/);
		const previous = tokens[tokens.length - 1];
		let values: readonly string[] = RESUME_FLAGS;
		if (tokens.length === 0) values = resumableIds(results);
		else if (previous === "--model") values = modelIds(registry);
		else if (previous === "--thinking") values = THINKING_LEVELS;
		const hits = values.filter((value) => value.startsWith(partial));
		return hits.length > 0 ? hits.map((value) => ({ value: head + value, label: value })) : null;
	}

	pi.registerCommand("delegate-resume", {
		description: `Reopen an exited delegate's session in a new window with a follow-up task: ${RESUME_USAGE}`,
		getArgumentCompletions: resumeCompletions,
		handler: resumeCommand,
	});

	const navigator = createNavigator(
		viewResults,
		tmux,
		tracking,
		(ctx: ExtensionContext) => startNewDelegate(ctx, newDelegateDeps),
		{
			assertActive: () => owner.assert(),
			close: (id, ctx) => tracking.close(id, ctx),
			resume: (id, ctx) => resumePicker(ctx, id),
		},
	);

	pi.registerCommand("delegates", {
		description: "Open the shared delegate dashboard: details, switch, peek, close, resume",
		handler: async (_args: string, ctx: ExtensionContext) => navigator.panel(ctx),
	});

	pi.registerShortcut("alt+shift+d", {
		description: "Open the delegates panel",
		handler: (ctx: ExtensionContext) => navigator.panel(ctx),
	});

	pi.registerCommand("delegate-open", {
		description: `Reach one open delegate: ${OPEN_USAGE}`,
		getArgumentCompletions: async (prefix: string) => openCompletions(prefix, await navigator.openIds()),
		handler: async (args: string, ctx: ExtensionContext) => {
			const parsed = parseOpen(args);
			if ("error" in parsed) return ctx.ui.notify(`delegate: ${parsed.error}`, "error");
			await navigator.openDelegate(ctx, parsed.id, parsed.mode);
		},
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

	registerDelegate(toolDescription(currentRoster().agents));
	tracking.registerTools();
	pi.registerTool(resumer.tool() as never);
}
