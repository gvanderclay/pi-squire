// How delegations look in the parent. A delegation reads as one tool call that
// changes state: the `delegate` row shows ○ while its arguments arrive and ●
// once started, and the result message that arrives later is drawn as a
// finished tool row (✓ or ✗ on Pi's tool success or error background). The
// style follows amosblomqvist/pi-interactive-subagents (c3e8b53,
// pi-extension/subagents/index.ts:1891-1944 and 2353-2460). Everything is
// drawn from structured details; the text the parent model reads is separate.
import { homedir } from "node:os";

import {
	getMarkdownTheme,
	keyHint,
	type MessageRenderer,
	type MessageRenderOptions,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, Container, Markdown, Spacer, Text, TruncatedText } from "@earendil-works/pi-tui";
import type { Static } from "typebox";

import type { DelegateSchema } from "./index.ts";
import type { MessageDetails } from "./results.ts";

/** The launch model, or `launch → finished` when the delegate finished on another one. */
export function modelLabel(model: string, finished: string | undefined): string {
	return finished === undefined || finished === model ? model : `${model} → ${finished}`;
}

/** Where a delegation ran, or that its record, from before cwd was kept, does not say. */
export function cwdLine(cwd: string | undefined): string {
	return cwd ?? "unknown (not recorded)";
}

/** Lines of a result the collapsed message previews. */
const PREVIEW_LINES = 5;
/** Characters of the task's first line the call row shows. */
const TASK_PREVIEW_CHARS = 100;

type Color = "success" | "error" | "warning" | "muted" | "dim";

/** The icon, its color and the status word for each way a delegation ends. */
const ENDINGS: Record<string, { icon: string; color: Color; word: string; wordColor: Color }> = {
	done: { icon: "✓", color: "success", word: "done", wordColor: "dim" },
	failed: { icon: "✗", color: "error", word: "failed", wordColor: "error" },
	stopped: { icon: "✗", color: "warning", word: "stopped", wordColor: "warning" },
	gone: { icon: "✗", color: "warning", word: "closed without a result", wordColor: "warning" },
};

/** `path` with the home directory shown as `~`. */
function tilde(path: string): string {
	const home = homedir();
	return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** Non-blank lines with heading marks, backticks and bold markers stripped, for a plain-text preview. */
function plainLines(text: string): string[] {
	return text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) =>
			line
				.replace(/^#+\s+/, "")
				.replaceAll("`", "")
				.replaceAll("**", ""),
		);
}

function idLines(details: MessageDetails): string[] {
	const lines = [`delegation ${details.id}`, `request ${details.requestId}`];
	if (details.kind === "result") lines.push(`envelope ${tilde(details.envelopePath)}`);
	else lines.push(`window ${details.windowName}`);
	lines.push(`cwd ${details.cwd === undefined ? cwdLine(undefined) : tilde(details.cwd)}`);
	lines.push(
		`session ${details.sessionPath === undefined ? `${details.id} (no session file found)` : tilde(details.sessionPath)}`,
	);
	return lines;
}

/**
 * A delegate result or gone message, drawn as a finished tool row: a header
 * (icon, name, model, status), then a preview and the expand hint, or,
 * expanded, the result as Markdown, the task and the ids. Ctrl+O toggles it
 * with tool output; the model always gets the full content.
 */
export function renderMessage(
	message: Parameters<MessageRenderer>[0],
	{ expanded, outputPad }: MessageRenderOptions,
	theme: Theme,
): Component | undefined {
	const details = message.details as MessageDetails | undefined;
	if (details?.kind !== "result" && details?.kind !== "gone") return undefined;
	const status = details.kind === "gone" ? "gone" : details.status;
	const background = status === "done" ? "toolSuccessBg" : "toolErrorBg";
	const box = new Box(outputPad, 1, (text) => theme.bg(background, text));
	const header = headerLine(details, status, theme);
	box.addChild(expanded ? new Text(header, 0, 0) : new TruncatedText(header));
	if (details.kind === "result" && details.limit !== undefined)
		box.addChild(new Text(theme.fg("warning", details.limit), 0, 0));
	for (const child of expanded ? expandedLines(details, theme) : collapsedLines(details, theme)) box.addChild(child);
	return box;
}

/** The icon, the delegate's name, the model and the status word. */
function headerLine(details: MessageDetails, status: string, theme: Theme): string {
	const ending = Object.hasOwn(ENDINGS, status)
		? ENDINGS[status]
		: { icon: "•", color: "muted" as const, word: status, wordColor: "muted" as const };
	const model = modelLabel(details.model, details.finishedModel);
	return `${theme.fg(ending.color, ending.icon)} ${theme.fg("toolTitle", theme.bold(details.name))}${theme.fg(
		"dim",
		` (${model}) —`,
	)} ${theme.fg(ending.wordColor, ending.word)}`;
}

/** A result's first lines, a count of the rest, and the expand hint. */
function collapsedLines(details: MessageDetails, theme: Theme): Component[] {
	const children: Component[] = [];
	if (details.kind === "result") {
		const lines = plainLines(details.body);
		for (const line of lines.slice(0, PREVIEW_LINES)) children.push(new TruncatedText(theme.fg("dim", line)));
		if (lines.length > PREVIEW_LINES)
			children.push(new Text(theme.fg("muted", `… ${lines.length - PREVIEW_LINES} more lines`), 0, 0));
	}
	children.push(new Text(keyHint("app.tools.expand", "to expand"), 0, 0));
	return children;
}

/** The result as Markdown and the quoted task, then the ids and files. */
function expandedLines(details: MessageDetails, theme: Theme): Component[] {
	const dim = (lines: string[]): Text => new Text(lines.map((line) => theme.fg("dim", line)).join("\n"), 0, 0);
	const children: Component[] = [];
	if (details.kind === "result") {
		const { task } = details;
		const quote = "note" in task ? [task.note] : [`Task (${tilde(task.path)}):`, ...task.text.split("\n")];
		children.push(new Spacer(1), new Markdown(details.body, 0, 0, getMarkdownTheme()), new Spacer(1), dim(quote));
	}
	const tail = details.kind === "gone" ? ["A reply that arrives later is still delivered."] : [];
	children.push(new Spacer(1), dim([...idLines(details), ...tail]));
	return children;
}

/** The task's first non-blank line, cut at 100 characters, and its line count when it has more than one. */
function taskLine(task: unknown, theme: Theme): string {
	if (typeof task !== "string") return "";
	const first = task.split("\n").find((line) => line.trim() !== "") ?? "";
	const shown = first.length > TASK_PREVIEW_CHARS ? `${first.slice(0, TASK_PREVIEW_CHARS)}…` : first;
	const total = task.split("\n").length;
	return `${shown === "" ? "" : theme.fg("toolOutput", shown)}${total > 1 ? theme.fg("muted", ` (${total} lines)`) : ""}`;
}

/**
 * The `delegate` tool's call: ○, the agent, any label and the task line,
 * while arguments stream and the call runs. Pi redraws the call above the
 * result, so once a launch succeeds the call draws nothing and the result's
 * header is the row's only one; a refused call keeps it above the error.
 */
export function renderDelegateCall(
	args: { agent?: unknown; label?: unknown; task?: unknown },
	theme: Theme,
	context: { isPartial: boolean; isError: boolean },
): Component {
	if (!context.isPartial && !context.isError) return new Container();
	const agent = typeof args.agent === "string" && args.agent !== "" ? args.agent : "…";
	let text = `○ ${theme.fg("toolTitle", theme.bold(agent))}`;
	if (typeof args.label === "string" && args.label !== "" && args.label !== "null")
		text += theme.fg("dim", ` [${args.label}]`);
	const task = taskLine(args.task, theme);
	if (task !== "") text += `\n${task}`;
	return new Text(text, 0, 0);
}

/**
 * The `delegate` tool's result: ●, the delegate's name, its model and
 * "started", the task line and any skipped fallback models; expanded, the ids too. A
 * refused or blocked call has no details and keeps its plain text.
 */
export function renderDelegateResult(
	result: { content: { type: string; text?: string }[]; details?: unknown },
	{ expanded }: { expanded: boolean },
	theme: Theme,
	context: { args: { task?: unknown }; isError: boolean },
): Component {
	const details = result.details as Partial<Static<typeof DelegateSchema>> | undefined;
	if (context.isError || details?.outcome !== "started") {
		const text = result.content.map((part) => part.text ?? "").join("\n");
		return new Text(context.isError ? theme.fg("error", text) : text, 0, 0);
	}
	const started = details as Static<typeof DelegateSchema>;
	const lines = [
		`${theme.fg("accent", "●")} ${theme.fg("toolTitle", theme.bold(started.windowName))}${theme.fg(
			"dim",
			` (${started.model}) — started`,
		)}`,
	];
	const task = taskLine(context.args.task, theme);
	if (task !== "") lines.push(task);
	lines.push(...started.skipped.map(({ model, reason }) => theme.fg("warning", `[Skipped ${model}: ${reason}]`)));
	if (expanded)
		lines.push(
			...[
				...started.notices,
				`delegation ${started.id}`,
				`window ${started.windowName} (${started.windowId})`,
				`cwd ${tilde(started.cwd)}`,
				`thinking ${started.thinking}, auto-exit ${started.autoExit ? "on" : "off"}`,
			].map((line) => theme.fg("dim", line)),
		);
	return new Text(lines.join("\n"), 0, 0);
}
