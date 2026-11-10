// Read-only navigation projection. Never supplies locators to close or task accounting.
import { herdrLocator } from "./herdr-locator.ts";
import {
	type DelegationState,
	deriveState,
	isStarted,
	type Results,
	recordedName,
	type StartedRecorded,
	sessionIdOf,
} from "./results.ts";
import {
	sameLiveLocator,
	sameWindowLocator,
	type TmuxClient,
	type TmuxWindow,
	windowLocator,
	windowPresentation,
} from "./tmux.ts";
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

function sameLive(a: LiveLocator | undefined, b: LiveLocator | undefined): boolean {
	if (!a || !b) return a === b;
	return (
		a.generation === b.generation &&
		a.ownerToken === b.ownerToken &&
		a.pid === b.pid &&
		a.sessionFile === b.sessionFile &&
		sameLiveLocator(a.locator, b.locator)
	);
}
function sameTarget(a: OpenDelegate, b: OpenDelegate): boolean {
	return (
		(a.live && b.live
			? sameLiveLocator(a.live.locator, b.live.locator)
			: sameWindowLocator({ locator: windowLocator(a.window) }, { locator: windowLocator(b.window) })) &&
		sameLive(a.live, b.live)
	);
}

/** The record's own window when its program runs, as the navigator switches to it. */
function runningWindow(windows: WindowStates, record: StartedRecorded): TmuxWindow | undefined {
	const look = windows.look(record);
	return look.state === "running" || (herdrLocator(record.locator) && windows.listed(record))
		? {
				id: windowPresentation(record).windowId,
				name: windowPresentation(record).windowName,
				locator: record.locator,
				session: look.session ?? "",
				exited: false,
			}
		: undefined;
}

/** Current evidence supersedes historical navigation, but never mutates a saved launch/result. */
export class NavigatorView {
	private readonly results: Results;
	private readonly tmux: TmuxClient;
	private readonly reader: Pick<LiveActivityReader, "locator">;
	// A disappearing/replaced runtime cannot fall back, except a terminal-fenced Herdr shell after a recorded exit.
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
			? ((await this.liveWindow(live, windows)) ??
				(!live && herdrLocator(record.locator) && windows.state(record) === "gone" ? historical : undefined))
			: historical;
		return {
			id: record.id,
			name: recordedName(record),
			state: deriveState(record, windows.state(record)),
			record,
			live,
			navigable: window !== undefined,
			window: window ?? {
				id: windowPresentation(record).windowId,
				name: windowPresentation(record).windowName,
				exited: true,
				session: "",
			},
		};
	}

	private async liveWindow(live: LiveLocator | undefined, windows: WindowStates): Promise<TmuxWindow | undefined> {
		if (!live || !windows.answered) return undefined;
		const pane = await verifyLiveWindow(this.tmux, live).catch(() => undefined);
		if (!pane) return undefined;
		const own: WindowRecord = pane;
		// Exact Pi pane, not a different active pane's pane_dead: a listed window counts as running.
		return windows.listed(own)
			? {
					id: windowPresentation(pane).windowId,
					locator: pane.locator,
					name: windowPresentation(pane).windowName,
					session: windows.look(own).session ?? "",
					exited: false,
				}
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
		return sameLive(final, current.live);
	}
}
