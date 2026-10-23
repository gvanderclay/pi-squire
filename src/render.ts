// How a delegate message looks in the parent: drawn from the structured
// details `results.ts` attaches, while the message's text stays what the
// parent model reads.
import { homedir } from "node:os";

import {
	getMarkdownTheme,
	keyText,
	type MessageRenderer,
	type MessageRenderOptions,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, Markdown, Spacer, Text, TruncatedText } from "@earendil-works/pi-tui";

import type { MessageDetails } from "./results.ts";

/** The launch model, or `launch → finished` when the delegate finished on another one. */
export function modelLabel(model: string, finished: string | undefined): string {
	return finished === undefined || finished === model ? model : `${model} → ${finished}`;
}

/** Lines of the body the collapsed view previews. */
const PREVIEW_LINES = 3;

/** The icon and theme color for each status; an unknown status gets a neutral icon. */
const STATUS_STYLE: Record<string, { icon: string; color: "success" | "error" | "warning" | "muted" }> = {
	done: { icon: "✓", color: "success" },
	failed: { icon: "✗", color: "error" },
	stopped: { icon: "■", color: "warning" },
	gone: { icon: "⊘", color: "warning" },
};

/** The header line: status icon, the delegate's name and the model it ran on. */
function header(details: MessageDetails, theme: Theme): string {
	const status = details.kind === "gone" ? "gone" : details.status;
	const known = Object.hasOwn(STATUS_STYLE, status);
	const style = known ? STATUS_STYLE[status] : { icon: "•", color: "muted" as const };
	let trailer = "";
	if (details.kind === "gone") trailer = " closed without a result";
	else if (!known) trailer = ` ${details.status}`;
	const model = theme.fg("muted", modelLabel(details.model, details.finishedModel));
	return `${theme.fg(style.color, style.icon)} ${theme.fg("accent", details.name)} ${model}${
		trailer === "" ? "" : theme.fg(style.color, trailer)
	}`;
}

/** `path` with the home directory shown as `~`. */
function tilde(path: string): string {
	const home = homedir();
	return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function metadata(details: MessageDetails): string[] {
	const lines = [`delegation ${details.id}`, `request ${details.requestId}`];
	if (details.kind === "result") lines.push(`envelope ${tilde(details.envelopePath)}`);
	else lines.push(`window ${details.windowName}`);
	lines.push(
		`session ${details.sessionPath === undefined ? `${details.id} (no session file found)` : tilde(details.sessionPath)}`,
	);
	return lines;
}

/**
 * The first non-blank lines of a body, with heading marks, backticks and bold
 * markers stripped. Plain text, not Markdown, because a cut-off fragment can
 * break mid-list or mid-code-block.
 */
function preview(body: string): string[] {
	return body
		.split("\n")
		.filter((line) => line.trim() !== "")
		.slice(0, PREVIEW_LINES)
		.map((line) =>
			line
				.replace(/^#+\s+/, "")
				.replaceAll("`", "")
				.replaceAll("**", ""),
		);
}

/**
 * A delegate message drawn from its details. Collapsed: a header, a short
 * preview of the result body and an expand hint. Expanded: the header, the
 * quoted task, the body as Markdown, then the ids and files. Ctrl+O toggles it
 * with tool output; the model always gets the full content.
 */
export function renderMessage(
	message: Parameters<MessageRenderer>[0],
	{ expanded, outputPad }: MessageRenderOptions,
	theme: Theme,
): Component | undefined {
	const details = message.details as MessageDetails | undefined;
	if (details?.kind !== "result" && details?.kind !== "gone") return undefined;
	const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
	if (!expanded) {
		box.addChild(new TruncatedText(header(details, theme)));
		if (details.kind === "result") {
			for (const line of preview(details.body)) box.addChild(new TruncatedText(theme.fg("muted", line)));
		}
		box.addChild(new Text(`${theme.fg("dim", keyText("app.tools.expand"))}${theme.fg("muted", " to expand")}`, 0, 0));
		return box;
	}
	box.addChild(new Text(header(details, theme), 0, 0));
	const dim = metadata(details);
	if (details.kind === "gone") dim.push("A reply that arrives later is still delivered.");
	else if (details.limit !== undefined) dim.push(details.limit);
	const metadataText = new Text(dim.map((line) => theme.fg("dim", line)).join("\n"), 0, 0);
	if (details.kind === "gone") {
		box.addChild(metadataText);
		return box;
	}
	const { task } = details;
	const quote =
		"note" in task
			? theme.fg("muted", task.note)
			: `${theme.fg("muted", `Task (${tilde(task.path)}):`)}\n${task.text
					.split("\n")
					.map((line) => theme.fg("muted", `> ${line}`))
					.join("\n")}`;
	box.addChild(new Text(quote, 0, 0));
	box.addChild(new Spacer(1));
	box.addChild(new Text(theme.fg("dim", "Result"), 0, 0));
	box.addChild(new Markdown(details.body, 0, 0, getMarkdownTheme()));
	box.addChild(new Spacer(1));
	box.addChild(metadataText);
	return box;
}
