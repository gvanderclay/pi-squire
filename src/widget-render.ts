import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AncestorRow } from "./widget-ancestors.ts";
import type { DelegateRow } from "./widget-data.ts";

export type WidgetTheme = Pick<Theme, "fg" | "bold">;

/** Foreign names and labels are text, not terminal commands or multiline layout. */
export function widgetText(value: string): string {
	return [...stripVTControlCharacters(value).replace(/\s+/g, " ")]
		.filter((character) => {
			const code: number = character.codePointAt(0) ?? 0;
			return code >= 32 && (code < 127 || code > 159);
		})
		.join("")
		.trim()
		.slice(0, 2048);
}

function age(timestamp: number, now: number): string {
	const minutes: number = Math.floor(Math.max(0, now - timestamp) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	return `${Math.floor(minutes / 60)}h ago`;
}

function appearance(row: DelegateRow): { icon: string; color: "accent" | "success" | "warning" | "error" } {
	if (row.running) return { icon: "◌", color: "accent" };
	if (row.state === "done") return { icon: "✓", color: "success" };
	if (row.state === "failed") return { icon: "✗", color: "error" };
	return { icon: "!", color: "warning" };
}

function metadata(row: DelegateRow, width: number, coreWidth: number, now: number): string {
	const model: string = widgetText(row.model.split("/").slice(1).join("/") || row.model);
	const seen: string = row.lastActive === undefined ? "" : `file ${age(row.lastActive, now)}`;
	const columns: string[] = [seen, model].filter(Boolean);
	// Remove model, then file-age, before sacrificing identity/state/title.
	while (columns.length && coreWidth + visibleWidth(` · ${columns.join(" · ")}`) > width) columns.pop();
	return columns.length ? ` · ${columns.join(" · ")}` : "";
}

function entry(row: DelegateRow, width: number, connector: string, theme: WidgetTheme, now: number): string {
	const { icon, color } = appearance(row);
	const state: string = widgetText(row.state);
	const name: string = widgetText(row.identity);
	if (width < 16) return truncateToWidth(`${theme.fg(color, icon)} ${theme.bold(name)}`, width);
	const prefix: string = `${theme.fg("dim", connector)} ${theme.fg(color, icon)} `;
	const suffix: string = ` · ${theme.fg(color, state)}`;
	const title: string = widgetText(row.title ?? "");
	const preferred: number = visibleWidth(prefix + name + suffix) + (title ? Math.min(24, visibleWidth(title)) + 2 : 0);
	const extra: string = metadata(row, width, preferred, now);
	const room: number = Math.max(1, width - visibleWidth(prefix + suffix + extra));
	const identity: string = truncateToWidth(name, room);
	const titleRoom: number = room - visibleWidth(identity) - 2;
	const description: string = title && title !== name && titleRoom >= 4 ? `  ${truncateToWidth(title, titleRoom)}` : "";
	return truncateToWidth(`${prefix}${theme.bold(identity)}${description}${suffix}${theme.fg("dim", extra)}`, width);
}

/** One secondary line; descendant task counts take priority when both do not fit. */
export function activityLine(
	row: DelegateRow,
	width: number,
	last: boolean,
	theme: WidgetTheme,
	summary = "",
): string | undefined {
	const activity: string =
		row.running && row.activity
			? `${row.activity.kind === "response" ? "response: " : ""}${widgetText(row.activity.text)}`
			: "";
	const facts: string = widgetText(summary);
	if (!activity && !facts) return;
	const prefix: string = last ? "   └─ " : "│  └─ ";
	let text: string = [activity, facts].filter(Boolean).join(" · ");
	if (facts && visibleWidth(prefix + text) > width) text = facts;
	return truncateToWidth(theme.fg("dim", prefix + text), width);
}

export type WidgetRenderOptions = {
	offset?: number;
	selectedKey?: string;
	focused?: boolean;
	ancestors?: readonly AncestorRow[];
	ancestryError?: string;
};

function selectableEntry(
	row: DelegateRow,
	width: number,
	last: boolean,
	theme: WidgetTheme,
	now: number,
	options: WidgetRenderOptions,
): string {
	const gutter: string = options.focused ? "  " : "";
	const marker: string = options.focused && row.key === options.selectedKey ? theme.fg("accent", "▸ ") : gutter;
	return marker + entry(row, width - visibleWidth(marker), last ? "└─" : "├─", theme, now);
}

function ancestorLines(ancestors: readonly AncestorRow[], options: WidgetRenderOptions, theme: WidgetTheme): string[] {
	return ancestors.map((ancestor, index) => {
		const gutter: string = options.focused ? "  " : "";
		const marker: string = options.focused && ancestor.key === options.selectedKey ? theme.fg("accent", "▸ ") : gutter;
		const connector: string = index ? `${"  ".repeat(index - 1)}└─ ` : "";
		return (
			marker +
			connector +
			"↑ " +
			theme.bold(widgetText(ancestor.identity)) +
			(ancestor.parent ? " (parent)" : "") +
			(ancestor.title ? `  ${widgetText(ancestor.title)}` : "")
		);
	});
}

function more(count: number): string {
	return `${count} more direct delegate${count === 1 ? "" : "s"}`;
}

function childLines(
	rows: readonly DelegateRow[],
	cap: number,
	width: number,
	theme: WidgetTheme,
	now: number,
	options: WidgetRenderOptions,
): string[] {
	const depth: number = options.ancestors?.length ?? 0;
	const indent: string = "  ".repeat(depth);
	const gutter: string = options.focused ? "  " : "";
	const branch: string = depth ? `${"  ".repeat(depth - 1)}└─ ` : "";
	const lines: string[] = [gutter + branch + theme.fg("accent", theme.bold("Delegates"))];
	const start: number = Math.max(0, Math.min(options.offset ?? 0, rows.length - cap));
	const visible: readonly DelegateRow[] = rows.slice(start, start + cap);
	const hidden: number = rows.length - start - visible.length;
	if (start) lines.push(gutter + indent + theme.fg("dim", `├─ ↑ ${more(start)}`));
	for (const [index, row] of visible.entries()) {
		const last: boolean = index === visible.length - 1 && hidden === 0;
		lines.push(indent + selectableEntry(row, width - indent.length, last, theme, now, options));
		const secondary: string | undefined = activityLine(
			row,
			width - gutter.length - indent.length,
			last,
			theme,
			row.summary,
		);
		if (secondary) lines.push(gutter + indent + secondary);
	}
	if (hidden) lines.push(gutter + indent + theme.fg("dim", `└─ +${more(hidden)}`));
	return lines;
}

/** Pure layout: the cap counts child entries, not physical lines or hidden children. */
export function renderDelegateWidget(
	rows: readonly DelegateRow[],
	cap: number,
	width: number,
	theme: WidgetTheme,
	now: number = Date.now(),
	options: WidgetRenderOptions = {},
): string[] {
	if (width <= 0) return [];
	const ancestors: readonly AncestorRow[] = options.ancestors ?? [];
	if (!ancestors.length && (cap === 0 || !rows.length) && !options.ancestryError) return [];
	const gutter: string = options.focused ? "  " : "";
	const lines: string[] = ancestorLines(ancestors, options, theme);
	if (options.ancestryError) lines.push(gutter + theme.fg("warning", widgetText(options.ancestryError)));
	if (cap > 0 && rows.length) lines.push(...childLines(rows, cap, width, theme, now, options));
	if (options.focused)
		lines.push(
			theme.fg(
				"dim",
				ancestors.some((ancestor) => ancestor.key === options.selectedKey)
					? "↑↓ select · enter switch · esc prompt"
					: "↑↓ select · enter details · esc prompt",
			),
		);
	return lines.map((line) => truncateToWidth(line, width));
}
