// Read-only dashboard/navigation projection. Never supplies locators to close or task accounting.
import type { DashboardRow } from "./dashboard.ts";
import {
	type DelegationState,
	deriveState,
	isStarted,
	locateSession,
	type Results,
	recordedName,
	type StartedRecorded,
	sessionIdOf,
} from "./results.ts";
import type { TmuxClient, TmuxWindow } from "./tmux.ts";
import { verifyLiveWindow } from "./widget-ancestors.ts";
import { LiveActivityReader, type LiveLocator } from "./widget-live.ts";
import { WidgetTitleMirrors } from "./widget-title.ts";
import { WidgetTitleFiles } from "./widget-title-file.ts";
import { listWindows, ownWindow } from "./windows.ts";

export type OpenDelegate = {
	id: string;
	name: string;
	title?: string;
	agent: string;
	state: DelegationState;
	window: TmuxWindow;
	navigable: boolean;
	live?: LiveLocator;
	record: StartedRecorded;
	resumedAs?: string;
};

/** Membership uses scoped records' session edges, never names, placement or a new tree index. */
export function branchItems(items: OpenDelegate[], target: string | undefined): OpenDelegate[] {
	if (target === undefined) return items;
	const sessions: Set<string> = new Set([target]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const item of items) {
			const parent: string | undefined = item.record.identity?.parent;
			const session: string = sessionIdOf(item.record);
			if (parent && sessions.has(parent) && !sessions.has(session)) {
				sessions.add(session);
				changed = true;
			}
		}
	}
	return items.filter((item) => sessions.has(sessionIdOf(item.record)));
}

function openItem(item: OpenDelegate): boolean {
	if (!item.navigable || item.record.closed || item.record.accountingOnly) return false;
	return (
		["running", "done", "gone"].includes(item.state) || (item.state === "window-closed" && item.live !== undefined)
	);
}

function sameTarget(a: OpenDelegate, b: OpenDelegate): boolean {
	return (
		a.window.id === b.window.id && a.window.name === b.window.name && JSON.stringify(a.live) === JSON.stringify(b.live)
	);
}

/** Current evidence supersedes historical navigation, but never mutates a saved launch/result. */
export class NavigatorView {
	private readonly results: Results;
	private readonly tmux: TmuxClient;
	private readonly reader: Pick<LiveActivityReader, "locator">;
	private readonly titles: WidgetTitleFiles = new WidgetTitleFiles();
	private readonly mirrors: WidgetTitleMirrors = new WidgetTitleMirrors();
	// Once positively observed, a disappearing/replaced current runtime must not fall back to its old window.
	private readonly current: Set<string> = new Set();

	constructor(
		results: Results,
		tmux: TmuxClient,
		reader: Pick<LiveActivityReader, "locator"> = new LiveActivityReader(),
	) {
		this.results = results;
		this.tmux = tmux;
		this.reader = reader;
	}

	async items(history = false): Promise<OpenDelegate[] | undefined> {
		const windows: TmuxWindow[] | undefined = await listWindows(this.tmux);
		if (!windows && !history) return undefined;
		const all: StartedRecorded[] = this.results.list().filter(isStarted);
		const latest: Map<string, string> = new Map(all.map((record) => [sessionIdOf(record), record.id]));
		const items: OpenDelegate[] = await Promise.all(
			all.map(async (record): Promise<OpenDelegate> => {
				const item: OpenDelegate = await this.item(record, latest.get(sessionIdOf(record)) === record.id, windows);
				item.resumedAs = all.find((next) => next.resumedFrom === record.id)?.id;
				return item;
			}),
		);
		if (history) return items;
		return items.filter(openItem).reverse();
	}

	private async item(
		record: StartedRecorded,
		latest: boolean,
		windows: TmuxWindow[] | undefined,
	): Promise<OpenDelegate> {
		const historical: TmuxWindow | undefined = windows ? ownWindow(windows, record) : undefined;
		const live: LiveLocator | undefined =
			latest && !record.closed ? await this.reader.locator(sessionIdOf(record)) : undefined;
		if (live) this.current.add(record.id);
		const window: TmuxWindow | undefined = this.current.has(record.id)
			? await this.liveWindow(live, windows)
			: historical;
		const path: string | undefined = live?.sessionFile ?? locateSession({ ...record }, undefined);
		const title: string | undefined =
			this.titles.read(path, sessionIdOf(record))?.name ?? this.mirrors.read(sessionIdOf(record));
		let state: import("./results.ts").WindowState = "unknown";
		if (windows) state = historical && !historical.exited ? "open" : "gone";
		return {
			id: record.id,
			name: recordedName(record),
			title,
			agent: record.displayName ?? record.agent,
			state: deriveState(record, state),
			record,
			live,
			navigable: !!window && !window.exited,
			window: window ?? { id: record.windowId, name: record.windowName, exited: true, session: "" },
		};
	}

	private async liveWindow(
		live: LiveLocator | undefined,
		windows: TmuxWindow[] | undefined,
	): Promise<TmuxWindow | undefined> {
		if (!live || !windows || !(await verifyLiveWindow(this.tmux, live).catch(() => false))) return undefined;
		const found: TmuxWindow | undefined = windows.find(
			(entry) => entry.id === live.locator.windowId && entry.name === live.locator.windowName,
		);
		// Exact Pi pane, not a different active pane's pane_dead.
		return found ? { ...found, exited: false } : undefined;
	}

	async verified(item: OpenDelegate): Promise<boolean> {
		const all: StartedRecorded[] = this.results.list().filter(isStarted);
		const record: StartedRecorded | undefined = all.find((entry) => entry.id === item.id);
		if (!record || sessionIdOf(record) !== sessionIdOf(item.record)) return false;
		const latest: boolean = all.filter((entry) => sessionIdOf(entry) === sessionIdOf(record)).at(-1)?.id === record.id;
		const current: OpenDelegate = await this.item(record, latest, await listWindows(this.tmux));
		if (!current.navigable || !sameTarget(item, current)) return false;
		if (!current.live) return true;
		const final: LiveLocator | undefined = await this.reader.locator(sessionIdOf(record));
		return JSON.stringify(final) === JSON.stringify(current.live);
	}
}

function detailLines(item: OpenDelegate): string[] {
	const record: StartedRecorded = item.record;
	return [
		`delegation: ${record.id} · session: ${sessionIdOf(record)}`,
		`parent: ${record.identity?.parent ?? "this session"} · root: ${record.identity?.root ?? "this session"} · depth: ${record.identity?.depth ?? 1}`,
		`title: ${item.title ?? "not set"}`,
		`launch window: ${record.windowName} (${record.windowId})`,
		`current verified window: ${item.navigable ? `${item.window.name} (${item.window.id}) in ${item.window.session}` : "unavailable"}`,
		`cwd: ${record.cwd ?? "unknown"} · workspace: ${record.workspace?.cwd ?? "none recorded"}`,
		`session file: ${item.live?.sessionFile ?? locateSession({ ...record }, undefined) ?? "not found"}`,
		`session directory: ${record.sessionDir ?? "not recorded"}`,
		`result: ${record.result?.status ?? "none received"} · envelope: ${record.result?.envelopePath ?? "none"}`,
		`resumed from: ${record.resumedFrom ?? "none"} · resumed as: ${item.resumedAs ?? "none"} · auto-exit: ${record.autoExit === true ? "on" : "off"}`,
		`model: ${record.model} · thinking: ${record.thinking}`,
	];
}

export function dashboardRows(items: readonly OpenDelegate[]): DashboardRow[] {
	const baseDepth: number = Math.min(...items.map((item) => item.record.identity?.depth ?? 1));
	return items.map((item): DashboardRow => {
		const where: string = item.navigable ? `${item.window.id} in ${item.window.session}` : "window unavailable";
		const title: string = item.title && item.title !== item.name ? ` · ${item.title}` : "";
		const outcome: string = item.record.result ? ` (${item.record.result.status})` : "";
		return {
			id: item.id,
			label: `${item.name}${title} · ${item.agent} · ${item.state}${outcome} · ${where}`,
			depth: Math.max(0, (item.record.identity?.depth ?? 1) - baseDepth),
			details: detailLines(item),
		};
	});
}
