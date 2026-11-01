// Presentation only. The navigator resolves these opaque ids and owns every action/refusal.
import { type Component, isKeyRelease, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { type WidgetTheme, widgetText } from "./widget-render.ts";

export type DashboardRow = { id: string; label: string; details: readonly string[]; depth?: number };
export type DashboardIntent =
	| { action: "switch" | "close" | "peek" | "resume"; id: string }
	| { action: "new" }
	| { action: "close-all" }
	| undefined;
export type DashboardPosition = { id?: string; detail: boolean; offset: number; branchList?: boolean };
type DashboardOptions = {
	items: readonly DashboardRow[];
	root?: boolean;
	branch?: string;
	position: DashboardPosition;
	detailBack: "list" | "exit";
	theme: WidgetTheme;
	done(result: DashboardIntent): void;
	redraw(): void;
	rows(): number;
};

function label(row: DashboardRow): string {
	return "  ".repeat(Math.max(0, Math.min(64, row.depth ?? 0))) + widgetText(row.label);
}

/** One screen used by command and widget entry, with durable position across action dialogs. */
export class Dashboard implements Component {
	private readonly options: DashboardOptions;

	constructor(options: DashboardOptions) {
		this.options = options;
		const found: boolean = options.items.some((row) => row.id === options.position.id);
		if (!found) {
			options.position.id = options.items[0]?.id;
			options.position.offset = 0;
			options.position.detail = false;
		}
	}

	invalidate(): void {}

	private selected(): DashboardRow | undefined {
		return this.options.items.find((row) => row.id === this.options.position.id);
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		const { position, done } = this.options;
		if (matchesKey(data, "escape")) {
			if (position.detail && (this.options.detailBack === "list" || position.branchList)) {
				position.detail = false;
				position.offset = 0;
			} else done(undefined);
		} else if (matchesKey(data, "b") && this.options.branch !== undefined) {
			position.branchList = true;
			position.detail = false;
			position.offset = 0;
		} else if (matchesKey(data, "n")) done({ action: "new" });
		else if (matchesKey(data, "a") && this.options.root) done({ action: "close-all" });
		else if (matchesKey(data, "up")) this.move(-1);
		else if (matchesKey(data, "down")) this.move(1);
		else this.action(data);
		this.options.redraw();
	}

	private action(data: string): void {
		const item: DashboardRow | undefined = this.selected();
		if (!item) return;
		const { position, done } = this.options;
		if (matchesKey(data, "enter")) {
			if (position.detail) done({ action: "switch", id: item.id });
			else {
				position.detail = true;
				position.offset = 0;
			}
		} else if (matchesKey(data, "p")) done({ action: "peek", id: item.id });
		else if (matchesKey(data, "x")) done({ action: "close", id: item.id });
		else if (matchesKey(data, "r")) done({ action: "resume", id: item.id });
	}

	private move(direction: -1 | 1): void {
		const { items, position } = this.options;
		if (position.detail) {
			const max: number = Math.max(0, (this.selected()?.details.length ?? 0) - this.height());
			position.offset = Math.max(0, Math.min(max, position.offset + direction));
			return;
		}
		const index: number = items.findIndex((row) => row.id === position.id);
		position.id = items[Math.max(0, Math.min(items.length - 1, index + direction))]?.id;
	}

	private height(): number {
		return Math.max(1, this.options.rows() - 6);
	}

	render(width: number): string[] {
		const { items, position, theme } = this.options;
		const fit = (text: string): string => truncateToWidth(text, Math.max(0, width));
		const item: DashboardRow | undefined = this.selected();
		if (!item)
			return [theme.bold(this.heading()), "", `No open delegates · n new · esc close${this.closeAllHint()}`].map(fit);
		if (position.detail) return this.details(item).map(fit);
		const index: number = items.indexOf(item);
		const start: number = Math.max(0, index - this.height() + 1);
		const rows: string[] = items
			.slice(start, start + this.height())
			.map((row) => (row.id === item.id ? theme.fg("accent", `▸ ${label(row)}`) : `  ${label(row)}`));
		return [
			theme.bold(this.heading()),
			"",
			...rows,
			`${index + 1}/${items.length}`,
			theme.fg(
				"dim",
				`↑↓ select · enter details · p peek · x close · r resume · n new · esc leave${this.closeAllHint()}`,
			),
		].map(fit);
	}

	private heading(): string {
		return this.options.branch === undefined ? "Delegates" : `Delegate branch: ${widgetText(this.options.branch)}`;
	}

	private closeAllHint(): string {
		if (!this.options.root) return "";
		return this.options.branch === undefined ? " · a close all subtrees" : " · a close ALL ROOT subtrees";
	}

	private details(item: DashboardRow): string[] {
		const { position, theme } = this.options;
		return [
			theme.bold(`Delegate: ${widgetText(item.label)}`),
			"",
			...item.details.slice(position.offset, position.offset + this.height()).map(widgetText),
			"",
			theme.fg(
				"dim",
				`↑↓ scroll · enter switch · p peek · x close · r resume · n new · esc back${this.options.branch === undefined ? "" : " · b branch list"}${this.closeAllHint()}`,
			),
		];
	}
}
