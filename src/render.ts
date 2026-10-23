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
import type { MessageDetails, ResourceFacts, WorkspaceAttempt } from "./results.ts";
import type { WorkspaceSnapshot } from "./snapshot.ts";
import type { PathSummary, Workspace } from "./workspace.ts";

/** The launch model, or `launch → finished` when the delegate finished on another one. */
export function modelLabel(model: string, finished: string | undefined): string {
	return finished === undefined || finished === model ? model : `${model} → ${finished}`;
}

/** Where a delegation ran, or that its record, from before cwd was kept, does not say. */
const displayReason = (reason: string): string => JSON.stringify(reason).slice(1, -1);

export function cwdLine(cwd: string | undefined): string {
	return cwd ?? "unknown (not recorded)";
}

/** How a delegation's directory was chosen and its Git checkout at launch, on one line. */
export function workspaceLine(workspace: Workspace): string {
	if (workspace.mode === "managed") {
		const { createdBranch, requestedBase, baseCommit, source, cwd } = workspace;
		return `managed worktree ${cwd}, new branch ${createdBranch} created from ${requestedBase} (${baseCommit}) of ${source.checkoutRoot}; ${dirtyNotice(workspace.sourceDirty)}`;
	}
	const { mode, git } = workspace;
	const how = mode === "inherited" ? "the parent's directory" : "existing directory";
	if (git.kind === "non-git") return `${how}; not a Git checkout`;
	if (git.kind === "unknown") return `${how}; Git state unknown (${displayReason(git.reason)})`;
	const { mainRoot, checkoutRoot } = git.identity;
	const linked = checkoutRoot === mainRoot ? "" : ` (linked worktree ${checkoutRoot})`;
	const at = git.position.detached ? "detached HEAD" : `branch ${git.position.branch}`;
	return `${how}; Git checkout ${mainRoot}${linked}, ${at}, launch commit ${git.baseline ?? "none (no commits yet)"}`;
}

/** The source's uncommitted paths a worktree does not carry, bounded to a few names. */
export function dirtyNotice({ paths, total }: PathSummary): string {
	if (total === 0) return "the source had no uncommitted files";
	const shown = paths.slice(0, 5).map((path) => JSON.stringify(path));
	const rest = total > shown.length ? `, and ${total - shown.length} more` : "";
	return `${total} uncommitted source path${total === 1 ? " is" : "s are"} not copied into it (${shown.join(", ")}${rest})`;
}

/** What is known to exist for an attempt, in words. */
export function resourceLine(resources: ResourceFacts): string {
	switch (resources.kind) {
		case "none":
			return "nothing created by this attempt remains";
		case "branch":
			return `the branch ${resources.branch} remains at ${resources.head}; its worktree is gone`;
		case "worktree":
			return `the worktree ${resources.cwd} and its branch ${resources.branch} (at ${resources.head}) remain`;
		case "unknown":
			return `unknown: ${displayReason(resources.reason)}; observed paths ${JSON.stringify(resources.observedPaths)}, refs ${JSON.stringify(resources.observedRefs)}`;
	}
}

/** The lines that describe an attempt without a window: its plan, what exists, why it stopped and recovery. */
export function attemptLines({ plan, attempt, requestId }: WorkspaceAttempt): string[] {
	let why: string[] = [];
	if ("cause" in attempt) why = [`cause: ${attempt.cause}`];
	else if ("reason" in attempt) why = [`reason: ${attempt.reason}`];
	return [
		`source: ${plan.sourceCwd} (repository ${plan.source.mainRoot})`,
		`worktree: ${plan.destination} on new branch ${plan.branch} from ${plan.requestedBase} (${plan.baseCommit})`,
		`resources: ${resourceLine(attempt.resources)}`,
		...why,
		...(attempt.phase === "retained" && attempt.recovery.length > 0
			? ["recovery (non-forced; check each command's result):", ...attempt.recovery.map((line) => `  ${line}`)]
			: []),
		...(requestId === undefined
			? []
			: [`request: ${requestId} (the task was mailed; no window id/start was recorded and a window may still exist)`]),
	];
}

/** A path list as data: each name JSON-quoted, so spaces, quotes and newlines stay inside one line. */
function pathList({ paths, total }: PathSummary): string {
	if (total === 0) return "none";
	const more = total > paths.length ? `, and ${total - paths.length} more not listed` : "";
	return `${total} path${total === 1 ? "" : "s"}: ${paths.map((path) => JSON.stringify(path)).join(", ")}${more}`;
}

/**
 * A checkout observation: a summary line, then for Git one line per path
 * category. Committed changes are counted from the launch commit; pending
 * ones are the index and working tree now.
 */
export function snapshotLines(snapshot: WorkspaceSnapshot): string[] {
	if (snapshot.kind === "non-git") return ["not a Git checkout"];
	if (snapshot.kind === "unknown") return [`Git state unknown (${displayReason(snapshot.reason)})`];
	const { position, head, baseline, ahead, workingState, committed, pending } = snapshot;
	const at = position.detached ? "detached HEAD" : `branch ${position.branch}`;
	return [
		`${at}, head ${head}, launch commit ${baseline}, ${ahead} commit${ahead === 1 ? "" : "s"} since launch, working tree ${workingState}`,
		`committed since launch: ${pathList(committed)}`,
		`staged: ${pathList(pending.staged)}`,
		`unstaged: ${pathList(pending.unstaged)}`,
		`untracked: ${pathList(pending.untracked)}`,
		`conflicted: ${pathList(pending.conflicted)}`,
	];
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
	if (details.workspace !== undefined) lines.push(`workspace ${workspaceLine(details.workspace)}`);
	if (details.kind === "result" && details.workspaceSnapshot !== undefined) {
		const [first, ...rest] = snapshotLines(details.workspaceSnapshot);
		lines.push(`checkout when the result arrived: ${first}`, ...rest.map((line) => `  ${line}`));
	}
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
				// Results saved before cwd was recorded have none.
				`cwd ${(started.cwd as string | undefined) === undefined ? cwdLine(undefined) : tilde(started.cwd)}`,
				// Results saved before workspaces were recorded have none.
				...((started.workspace as Workspace | undefined) === undefined
					? []
					: [`workspace ${workspaceLine(started.workspace)}`]),
				`thinking ${started.thinking}, auto-exit ${started.autoExit ? "on" : "off"}`,
			].map((line) => theme.fg("dim", line)),
		);
	return new Text(lines.join("\n"), 0, 0);
}
