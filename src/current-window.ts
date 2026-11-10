// Which window a delegation is in now: its recorded window, superseded by the
// child's own verified live pane. Read-only presentation; never close, resume or
// task authority, and never a rewrite of a saved launch or result.
//
// A host with no live pane answers through the same paths: it has no
// `verifyLivePane` and no `livePanes` snapshot, so live evidence never places a
// delegation there and only its recorded window counts.
import type { DelegateHost } from "./host.ts";
import {
	sameLiveLocator,
	type VerifiedLiveWindow,
	verifyPaneWindow,
	type WindowLocator,
	type WindowRecord,
	windowFacts,
	windowPresentation,
} from "./locators.ts";
import { isStarted, type Results, type StartedRecorded, sessionIdOf } from "./results.ts";
import type { LiveActivityReader, LiveLocator } from "./widget-live.ts";
import type { PaneStates, WindowStates } from "./window-state.ts";

/** Navigation projection, not a host inventory or lifecycle authority. */
export type NavigationWindow = { id: string; name: string; session: string; exited: boolean; locator?: WindowLocator };

/** Where one delegation is now: the live evidence read, and the window it places, if any. */
export type Placement = { live?: LiveLocator; window?: NavigationWindow };

type LiveReader = Pick<LiveActivityReader, "locator">;

/** The same published runtime: generation, owner, process, session file and pane. */
export function sameLive(a: LiveLocator | undefined, b: LiveLocator | undefined): boolean {
	if (!a || !b) return a === b;
	return (
		a.generation === b.generation &&
		a.ownerToken === b.ownerToken &&
		a.pid === b.pid &&
		a.sessionFile === b.sessionFile &&
		sameLiveLocator(a.locator, b.locator)
	);
}

/** The same live target to switch to: generation, owner and pane. */
export function sameLiveTarget(a: LiveLocator, b: LiveLocator): boolean {
	return a.generation === b.generation && a.ownerToken === b.ownerToken && sameLiveLocator(a.locator, b.locator);
}

/**
 * Positive own-server + exact target-pane + id/name listing, not a launch snapshot.
 * Undefined when the pane is not verified, or this host has no live pane.
 */
export async function verifyLiveWindow(host: DelegateHost, live: LiveLocator): Promise<VerifiedLiveWindow | undefined> {
	return verifyPaneWindow(host, live.locator);
}

/** The record's own window when its program runs, as the navigator switches to it. */
function recordedWindow(windows: WindowStates, record: StartedRecorded): NavigationWindow | undefined {
	const look = windows.look(record);
	return look.state === "running" || (windowFacts(record).retainedAfterExit && windows.listed(record))
		? {
				id: windowPresentation(record).windowId,
				name: windowPresentation(record).windowName,
				locator: record.locator,
				session: look.session ?? "",
				exited: false,
			}
		: undefined;
}

/** Current evidence supersedes the recorded window for navigation. */
export class CurrentWindows {
	private readonly host: DelegateHost;
	private readonly reader: LiveReader;
	// A disappearing/replaced runtime cannot fall back, except a host-retained resource after a recorded exit.
	private readonly current: Set<string> = new Set();

	constructor(host: DelegateHost, reader: LiveReader) {
		this.host = host;
		this.reader = reader;
	}

	/** The session's live evidence now, read again for a final check. */
	live(sessionId: string): Promise<LiveLocator | undefined> {
		return this.reader.locator(sessionId);
	}

	/** Only the latest open record of a session reads live evidence; older ones keep their recorded window. */
	async place(record: StartedRecorded, latest: boolean, windows: WindowStates): Promise<Placement> {
		const historical: NavigationWindow | undefined = recordedWindow(windows, record);
		const live: LiveLocator | undefined =
			latest && !record.closed ? await this.reader.locator(sessionIdOf(record)) : undefined;
		if (live) this.current.add(record.id);
		const window: NavigationWindow | undefined = this.current.has(record.id)
			? ((await this.liveWindow(live, windows)) ??
				(!live && windowFacts(record).retainedAfterExit && windows.state(record) === "gone" ? historical : undefined))
			: historical;
		return { live, window };
	}

	private async liveWindow(
		live: LiveLocator | undefined,
		windows: WindowStates,
	): Promise<NavigationWindow | undefined> {
		if (!live || !windows.answered) return undefined;
		const pane = await verifyLiveWindow(this.host, live).catch(() => undefined);
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
}

/**
 * Optional live-window overrides for known local children, never semantic
 * rewrites: each latest open record whose own window is not running, placed by
 * the one pane snapshot. No snapshot (no ask, or no live pane) reads nothing.
 */
export async function currentChildWindows(
	results: Results,
	windows: PaneStates,
	reader: LiveReader,
): Promise<Map<string, WindowRecord>> {
	const found = new Map<string, WindowRecord>();
	const panes = windows.livePanes;
	if (!panes) return found;
	const latest = new Map<string, StartedRecorded>(
		results
			.list()
			.filter(isStarted)
			.map((record) => [sessionIdOf(record), record]),
	);
	await Promise.all(
		[...latest.values()].map(async (record): Promise<void> => {
			if (record.closed || panes.running(record)) return;
			const live = await reader.locator(sessionIdOf(record));
			const current = live ? panes.windowOf(live.locator) : undefined;
			if (current) found.set(record.id, current);
		}),
	);
	return found;
}
