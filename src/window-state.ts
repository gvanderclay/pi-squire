// A delegation's window state: adapter matching and close over a shared observation.
// Callers ask once per multiplexer read and look up as many records as they need;
// they never match ids or names or read
// whether a window's program exited themselves.
import { herdrLocator } from "./herdr-locator.ts";
import {
	matchWindow,
	type PaneListing,
	recordLocator,
	type TmuxClient,
	type TmuxWindow,
	type WindowRecord,
} from "./tmux.ts";

export type { WindowRecord } from "./tmux.ts";

/**
 * What one ask says about a delegation's window: its program runs, the window
 * is missing or its program exited, or the multiplexer could not be asked.
 * `unknown` is never treated as gone.
 */
export type WindowState = "running" | "gone" | "unknown";

/** A record's window as one ask saw it. `session` is the tmux session the matching window is listed in, exited or not. */
export type WindowLook = { state: WindowState; session?: string };

/** One ask of the multiplexer, read for any number of records. */
export type WindowStates = {
	/** Whether the multiplexer answered; when it did not, every record is `unknown`. */
	readonly answered: boolean;
	look(record: WindowRecord): WindowLook;
	state(record: WindowRecord): WindowState;
	/** Whether the ask listed the record's window at all, its program running or exited. */
	listed(record: WindowRecord): boolean;
};

/** Window states that can also close what they saw. */
export type ClosableStates = WindowStates & {
	/**
	 * Close the record's window when this ask listed it, its program running or
	 * exited, and resolve whether one was closed. Idempotent: a window already
	 * gone resolves `false` without asking the multiplexer. Rejects when the ask
	 * failed, since an unknown window is never taken as gone.
	 */
	close(record: WindowRecord): Promise<boolean>;
};

/** One `list-panes` ask: the window states, plus the pane listing a caller verifying a live pane reads. */
export type PaneStates = WindowStates & { readonly listing: PaneListing | undefined };

/** Ask the adapter whether this observation contains the record's exact identity. */
function findWindow(windows: readonly TmuxWindow[], record: WindowRecord): TmuxWindow | undefined {
	return matchWindow(windows, record);
}

/** States from one window listing; `undefined` (a failed or skipped ask) makes every record `unknown`. */
export function windowStates(windows: readonly TmuxWindow[] | undefined): WindowStates {
	const look = (record: WindowRecord): WindowLook => {
		if (windows === undefined || !recordLocator(record) || herdrLocator(record.locator)) return { state: "unknown" };
		const own: TmuxWindow | undefined = findWindow(windows, record);
		if (own === undefined) return { state: "gone" };
		// A window whose program exited counts as gone.
		return { state: own.exited ? "gone" : "running", session: own.session };
	};
	return {
		answered: windows !== undefined,
		look,
		state: (record: WindowRecord): WindowState => look(record).state,
		listed: (record: WindowRecord): boolean => windows !== undefined && findWindow(windows, record) !== undefined,
	};
}

/** States from one window listing, bound to the client that closes them. */
function closableStates(tmux: TmuxClient, windows: readonly TmuxWindow[] | undefined): ClosableStates {
	return {
		...windowStates(windows),
		async close(record: WindowRecord): Promise<boolean> {
			if (windows === undefined) throw new Error("could not ask tmux which windows are open, so none was closed");
			if (!recordLocator(record) || herdrLocator(record.locator))
				throw new Error("invalid or unsupported delegate window locator; close refused");
			const own: TmuxWindow | undefined = findWindow(windows, record);
			if (own === undefined) return false;
			await tmux.kill(own.id);
			return true;
		},
	};
}

/** Every record `unknown`: nothing was asked. */
export const UNASKED: PaneStates = { ...windowStates(undefined), listing: undefined };

/** One `list-windows` ask; a failed ask yields `unknown` for every record, never `gone`. */
export async function askWindowStates(tmux: TmuxClient): Promise<ClosableStates> {
	if (tmux.states) return tmux.states();
	let windows: TmuxWindow[] | undefined;
	try {
		windows = await tmux.listWindows();
	} catch {
		windows = undefined;
	}
	return closableStates(tmux, windows);
}

/** One `list-windows` ask before a close; a failed ask rejects with the multiplexer's error, since close never guesses. */
export async function askToClose(tmux: TmuxClient): Promise<ClosableStates> {
	if (tmux.states) return tmux.states(true);
	return closableStates(tmux, await tmux.listWindows());
}

/** One `list-panes` ask; a failed ask yields `unknown` for every record and no listing. */
export async function askPaneStates(tmux: TmuxClient): Promise<PaneStates> {
	let listing: PaneListing | undefined;
	try {
		listing = await tmux.listPanes();
	} catch {
		listing = undefined;
	}
	return { ...(tmux.states ? await askWindowStates(tmux) : windowStates(listing?.windows)), listing };
}
