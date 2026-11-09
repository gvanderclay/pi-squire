// Read-only navigation projection. Never supplies locators to close or task accounting.
import {
	type DelegationState,
	deriveState,
	isStarted,
	type Results,
	recordedName,
	type StartedRecorded,
	sessionIdOf,
} from "./results.ts";
import type { TmuxClient, TmuxWindow } from "./tmux.ts";
import { verifyLiveWindow } from "./widget-ancestors.ts";
import { LiveActivityReader, type LiveLocator } from "./widget-live.ts";
import { askWindowStates, type WindowRecord, type WindowStates } from "./window-state.ts";

export type OpenDelegate = {
	id: string;
	name: string;
	state: DelegationState;
	window: TmuxWindow;
	navigable: boolean;
	live?: LiveLocator;
	record: StartedRecorded;
};

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

/** The record's own window when its program runs, as the navigator switches to it. */
function runningWindow(windows: WindowStates, record: StartedRecorded): TmuxWindow | undefined {
	const look = windows.look(record);
	return look.state === "running"
		? { id: record.windowId, name: record.windowName, session: look.session ?? "", exited: false }
		: undefined;
}

/** Current evidence supersedes historical navigation, but never mutates a saved launch/result. */
export class NavigatorView {
	private readonly results: Results;
	private readonly tmux: TmuxClient;
	private readonly reader: Pick<LiveActivityReader, "locator">;
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

	async items(): Promise<OpenDelegate[] | undefined> {
		const windows: WindowStates = await askWindowStates(this.tmux);
		if (!windows.answered) return undefined;
		const all: StartedRecorded[] = this.results.list().filter(isStarted);
		const latest: Map<string, string> = new Map(all.map((record) => [sessionIdOf(record), record.id]));
		const items: OpenDelegate[] = await Promise.all(
			all.map(async (record): Promise<OpenDelegate> => {
				return this.item(record, latest.get(sessionIdOf(record)) === record.id, windows);
			}),
		);
		return items.filter(openItem).reverse();
	}

	private async item(record: StartedRecorded, latest: boolean, windows: WindowStates): Promise<OpenDelegate> {
		const historical: TmuxWindow | undefined = runningWindow(windows, record);
		const live: LiveLocator | undefined =
			latest && !record.closed ? await this.reader.locator(sessionIdOf(record)) : undefined;
		if (live) this.current.add(record.id);
		const window: TmuxWindow | undefined = this.current.has(record.id)
			? await this.liveWindow(live, windows)
			: historical;
		return {
			id: record.id,
			name: recordedName(record),
			state: deriveState(record, windows.state(record)),
			record,
			live,
			navigable: window !== undefined,
			window: window ?? { id: record.windowId, name: record.windowName, exited: true, session: "" },
		};
	}

	private async liveWindow(live: LiveLocator | undefined, windows: WindowStates): Promise<TmuxWindow | undefined> {
		if (!live || !windows.answered) return undefined;
		const pane = await verifyLiveWindow(this.tmux, live).catch(() => undefined);
		if (!pane) return undefined;
		const own: WindowRecord = { windowId: pane.windowId, windowName: pane.windowName };
		// Exact Pi pane, not a different active pane's pane_dead: a listed window counts as running.
		return windows.listed(own)
			? { id: pane.windowId, name: pane.windowName, session: windows.look(own).session ?? "", exited: false }
			: undefined;
	}

	async verified(item: OpenDelegate): Promise<boolean> {
		const all: StartedRecorded[] = this.results.list().filter(isStarted);
		const record: StartedRecorded | undefined = all.find((entry) => entry.id === item.id);
		if (!record || sessionIdOf(record) !== sessionIdOf(item.record)) return false;
		const latest: boolean = all.filter((entry) => sessionIdOf(entry) === sessionIdOf(record)).at(-1)?.id === record.id;
		const current: OpenDelegate = await this.item(record, latest, await askWindowStates(this.tmux));
		if (!current.navigable || !sameTarget(item, current)) return false;
		if (!current.live) return true;
		const final: LiveLocator | undefined = await this.reader.locator(sessionIdOf(record));
		return JSON.stringify(final) === JSON.stringify(current.live);
	}
}
