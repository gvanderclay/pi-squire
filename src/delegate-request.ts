import { isThinking, THINKING_LEVELS } from "./agents.ts";
import type { ResumeRequest } from "./resume.ts";

/** The longest label a delegation can carry. */
export const LABEL_MAX = 32;
/** A label is one safe tmux window name and session name segment. */
const LABEL = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Why `value` is not a usable label, or undefined when it is. */
export function labelProblem(value: string): string | undefined {
	if (LABEL.test(value) && value.length <= LABEL_MAX) return undefined;
	return `label ${JSON.stringify(value)} must be at most ${LABEL_MAX} letters, digits, _ or -, starting with a letter or digit`;
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

export const USAGE =
	"usage: /delegate <agent> [--model <provider/id>] [--thinking <level>] [--label <name>] [--cwd <dir> | --worktree <branch> [--worktree-source <dir>] [--worktree-base <commit-ish>] ] [--auto-exit | --no-auto-exit] <task>";

/** The flags `/delegate-resume` takes before the task. */
const RESUME_FLAGS = ["--model", "--thinking", "--auto-exit", "--no-auto-exit"] as const;
export const RESUME_USAGE =
	"usage: /delegate-resume <id> [--model <provider/id>] [--thinking <level>] [--auto-exit | --no-auto-exit] <task>";

export type Parsed = {
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
export function closest(value: string, candidates: readonly string[]): string[] {
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

/** The request field for each value-taking launch flag. */
function valueFlag(
	flag: string,
):
	| keyof Pick<Parsed, "model" | "thinking" | "label" | "cwd" | "worktree" | "worktree_base" | "worktree_source">
	| undefined {
	switch (flag) {
		case "--model":
			return "model";
		case "--thinking":
			return "thinking";
		case "--label":
			return "label";
		case "--cwd":
			return "cwd";
		case "--worktree":
			return "worktree";
		case "--worktree-base":
			return "worktree_base";
		case "--worktree-source":
			return "worktree_source";
		default:
			return undefined;
	}
}

function autoExitFlag(flag: string): boolean {
	return flag === "--auto-exit" || flag === "--no-auto-exit";
}

/** `/delegate`'s arguments: an agent, optional flags, then a verbatim task. */
export function parse(text: string): { parsed: Parsed } | { error: string } {
	const agent = word(text, 0);
	if (agent === undefined) return { error: USAGE };
	if (agent.text.startsWith("-")) return { error: `the first argument is the agent name; ${USAGE}` };
	const parsed: Parsed = { agent: agent.text, task: "" };
	let at = agent.end;
	for (let next = word(text, at); next?.text.startsWith("-"); next = word(text, at)) {
		const flag = next.text;
		if (autoExitFlag(flag)) {
			parsed.autoExit = flag === "--auto-exit";
			at = next.end;
			continue;
		}
		const field = valueFlag(flag);
		if (field === undefined) {
			return { error: `unknown flag ${flag}; ${USAGE}` };
		}
		const read = flagValue(text, next.end, flag);
		if ("error" in read) return read;
		parsed[field] = read.value;
		at = read.end;
	}
	// The task is the rest of the text from its first word, untouched by flag parsing.
	parsed.task = text.slice(word(text, at)?.start ?? text.length).trim();
	if (parsed.task === "") return { error: `a task is required after the agent and flags; ${USAGE}` };
	return { parsed };
}

/** `/delegate-resume`'s arguments: a delegation id, optional flags, then a verbatim task. */
export function parseResume(text: string): { request: ResumeRequest } | { error: string } {
	const id = word(text, 0);
	if (id === undefined) return { error: RESUME_USAGE };
	if (id.text.startsWith("-")) return { error: `the first argument is the delegation id; ${RESUME_USAGE}` };
	const request: ResumeRequest = { id: id.text, task: "" };
	let at = id.end;
	for (let next = word(text, at); next?.text.startsWith("-"); next = word(text, at)) {
		const flag = next.text;
		if (autoExitFlag(flag)) {
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

/** Why `value` is not a thinking level, or undefined when it is. */
export function thinkingProblem(value: string): string | undefined {
	if (isThinking(value)) return undefined;
	const close = closest(value, THINKING_LEVELS);
	return `unknown thinking level ${JSON.stringify(value)}; levels: ${THINKING_LEVELS.join(", ")}${
		close.length > 0 ? `; close matches: ${close.join(", ")}` : ""
	}`;
}

/** Agent names, flags, model ids and thinking levels, at the cursor's token. */
export function completions(
	prefix: string,
	agents: () => readonly string[],
	models: () => readonly string[],
): { value: string; label: string }[] | null {
	const partial = /(?:^|\s)(\S*)$/.exec(prefix)?.[1] ?? "";
	const head = prefix.slice(0, prefix.length - partial.length);
	const pick = (values: readonly string[]): { value: string; label: string }[] | null => {
		const hits = values.filter((value) => value.startsWith(partial));
		return hits.length > 0 ? hits.map((value) => ({ value: head + value, label: value })) : null;
	};
	const tokens = head.trim() === "" ? [] : head.trim().split(/\s+/);
	if (tokens.length === 0) return pick(agents());
	const previous = tokens[tokens.length - 1];
	if (previous === "--model") return pick(models());
	if (previous === "--thinking") return pick(THINKING_LEVELS);
	return pick(FLAGS);
}

/** Delegation ids, flags, model ids and thinking levels, at the cursor's token. */
export function resumeCompletions(
	prefix: string,
	ids: () => readonly string[],
	models: () => readonly string[],
): { value: string; label: string }[] | null {
	const partial = /(?:^|\s)(\S*)$/.exec(prefix)?.[1] ?? "";
	const head = prefix.slice(0, prefix.length - partial.length);
	const tokens = head.trim() === "" ? [] : head.trim().split(/\s+/);
	const previous = tokens[tokens.length - 1];
	let values: readonly string[] = RESUME_FLAGS;
	if (tokens.length === 0) values = ids();
	else if (previous === "--model") values = models();
	else if (previous === "--thinking") values = THINKING_LEVELS;
	const hits = values.filter((value) => value.startsWith(partial));
	return hits.length > 0 ? hits.map((value) => ({ value: head + value, label: value })) : null;
}
