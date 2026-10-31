import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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

/** Pure render seam: future selection/activity/tree rows can compose around stable row keys. */
export function renderDelegateWidget(
	rows: readonly DelegateRow[],
	cap: number,
	width: number,
	theme: WidgetTheme,
	now: number = Date.now(),
): string[] {
	if (cap === 0 || rows.length === 0 || width <= 0) return [];
	const visible: readonly DelegateRow[] = rows.slice(0, cap);
	const hidden: number = rows.length - visible.length;
	const lines: string[] = [theme.fg("accent", theme.bold("Delegates"))];
	for (const [index, row] of visible.entries()) {
		const last: boolean = index === visible.length - 1 && hidden === 0;
		lines.push(entry(row, width, last ? "└─" : "├─", theme, now));
	}
	if (hidden) lines.push(theme.fg("dim", `└─ +${hidden} more direct delegate${hidden === 1 ? "" : "s"}`));
	return lines.map((line) => truncateToWidth(line, width));
}
