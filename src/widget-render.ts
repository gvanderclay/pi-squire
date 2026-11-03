import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Breadcrumb, WidgetIdentity } from "./widget-ancestors.ts";
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

export function widgetName(row: WidgetIdentity): string {
	const prefix = row.agent ? `${row.agent}-` : "";
	return widgetText(
		prefix && row.identity.startsWith(prefix) && row.identity.length > prefix.length
			? row.identity.slice(prefix.length)
			: row.identity,
	);
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
	const seen: string = row.lastActive === undefined ? "" : `active ${age(row.lastActive, now)}`;
	const columns: string[] = [seen, model].filter(Boolean);
	// Remove model, then active-age, before sacrificing identity/state/title.
	while (columns.length && coreWidth + visibleWidth(` · ${columns.join(" · ")}`) > width) columns.pop();
	return columns.length ? ` · ${columns.join(" · ")}` : "";
}

function entry(row: DelegateRow, width: number, connector: string, theme: WidgetTheme, now: number): string {
	const { icon, color } = appearance(row);
	const state: string = widgetText(row.state);
	const name: string = widgetName(row);
	if (width < 16) return truncateToWidth(`${theme.fg(color, icon)} ${theme.bold(name)}`, width);
	const prefix: string = `${theme.fg("dim", connector)} ${theme.fg(color, icon)} `;
	const suffix: string = ` · ${theme.fg(color, state)}`;
	const title: string = widgetText(row.title ?? "");
	const preferred: number = visibleWidth(prefix + name + suffix) + (title ? Math.min(24, visibleWidth(title)) + 2 : 0);
	const extra: string = metadata(row, width, preferred, now);
	const count = !row.expanded && row.descendantCount ? theme.fg("dim", ` +${row.descendantCount}`) : "";
	const room: number = Math.max(1, width - visibleWidth(prefix + suffix + extra + count));
	const identity: string = truncateToWidth(name, room);
	const titleRoom: number = room - visibleWidth(identity) - 2;
	const description: string = title && title !== name && titleRoom >= 4 ? `  ${truncateToWidth(title, titleRoom)}` : "";
	return truncateToWidth(
		`${prefix}${theme.bold(identity)}${description}${suffix}${theme.fg("dim", extra)}${count}`,
		width,
	);
}

/** One secondary line for live task activity. */
export function activityLine(row: DelegateRow, width: number, last: boolean, theme: WidgetTheme): string | undefined {
	const activity: string =
		row.running && row.activity
			? `${row.activity.kind === "response" ? "response: " : ""}${widgetText(row.activity.text)}`
			: "";
	if (!activity) return;
	const prefix: string = last ? "   └─ " : "│  └─ ";
	return truncateToWidth(theme.fg("dim", prefix + activity), width);
}

export type WidgetRenderOptions = {
	offset?: number;
	selectedKey?: string;
	focused?: boolean;
	breadcrumb?: Breadcrumb;
	ancestryError?: string;
};

// Unfocused rows keep the selection column so focusing the list never shifts the tree.
const GUTTER = "  ";

function selectableEntry(
	row: DelegateRow,
	width: number,
	last: boolean,
	theme: WidgetTheme,
	now: number,
	options: WidgetRenderOptions,
): string {
	const marker: string = options.focused && row.key === options.selectedKey ? theme.fg("accent", "▸ ") : GUTTER;
	return marker + entry(row, width - visibleWidth(marker), last ? "└─" : "├─", theme, now);
}

function breadcrumbLine(
	breadcrumb: Breadcrumb,
	width: number,
	options: WidgetRenderOptions,
	theme: WidgetTheme,
): string {
	const marker = options.focused && breadcrumb.key === options.selectedKey ? theme.fg("accent", "▸ ") : GUTTER;
	const names = breadcrumb.crumbs.map(widgetName);
	const self = `${widgetName(breadcrumb.self)} (you)`;
	let trail = [...names, self].join(" › ");
	const room = Math.max(0, width - visibleWidth(marker));
	if (visibleWidth(trail) > room && names.length > 2)
		trail = [names[0], "…", names[names.length - 1], self].join(" › ");
	const title = widgetText(breadcrumb.parentTitle ?? "");
	const titleRoom = room - visibleWidth(trail) - 2;
	return (
		marker +
		theme.bold(truncateToWidth(trail, room)) +
		(title && titleRoom >= 4 ? `  ${truncateToWidth(title, titleRoom)}` : "")
	);
}

function more(count: number): string {
	return `${count} more delegate${count === 1 ? "" : "s"}`;
}

function childLines(
	rows: readonly DelegateRow[],
	cap: number,
	width: number,
	theme: WidgetTheme,
	now: number,
	options: WidgetRenderOptions,
): string[] {
	const lines: string[] = options.breadcrumb ? [] : [GUTTER + theme.fg("accent", theme.bold("Delegates"))];
	const start: number = Math.max(0, Math.min(options.offset ?? 0, rows.length - cap));
	const visible: readonly DelegateRow[] = rows.slice(start, start + cap);
	const hidden: number = rows.length - start - visible.length;
	if (start) lines.push(GUTTER + theme.fg("dim", `├─ ↑ ${more(start)}`));
	for (const [index, row] of visible.entries()) {
		const last: boolean = index === visible.length - 1 && hidden === 0;
		const rowIndent = "  ".repeat(row.depth ?? 0);
		lines.push(rowIndent + selectableEntry(row, width - rowIndent.length, last, theme, now, options));
		const secondary: string | undefined = activityLine(row, width - GUTTER.length - rowIndent.length, last, theme);
		if (secondary) lines.push(GUTTER + rowIndent + secondary);
	}
	if (hidden) lines.push(GUTTER + theme.fg("dim", `└─ +${more(hidden)}`));
	return lines;
}

function focusedHint(rows: readonly DelegateRow[], options: WidgetRenderOptions): string {
	if (options.breadcrumb && options.breadcrumb.key === options.selectedKey)
		return "↑↓ select · enter parent · esc prompt";
	const selected = rows.find((row) => row.key === options.selectedKey);
	let treeHint = "";
	if (selected?.descendantCount) treeHint = selected.expanded ? " · ← collapse" : " · → expand";
	if (!selected?.expanded && selected?.depth) treeHint += " · ← parent";
	return `↑↓ select · enter open · x close${treeHint} · esc prompt`;
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
	const breadcrumb = options.breadcrumb;
	if (!breadcrumb && (cap === 0 || !rows.length) && !options.ancestryError) return [];
	const lines: string[] = breadcrumb ? [breadcrumbLine(breadcrumb, width, options, theme)] : [];
	if (options.ancestryError) lines.push(GUTTER + theme.fg("warning", widgetText(options.ancestryError)));
	if (cap > 0 && rows.length) lines.push(...childLines(rows, cap, width, theme, now, options));
	if (options.focused) lines.push(theme.fg("dim", focusedHint(rows, options)));
	else lines.push(theme.fg("dim", "↓ to manage delegates"));
	return lines.map((line) => truncateToWidth(line, width));
}
