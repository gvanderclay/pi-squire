// A delegation's window state: the one place that matches a delegation record
// to a window tmux lists. Callers ask once per multiplexer read and look up as
// many records as they need; they never match ids or names themselves.
import type { StartedRecorded } from "./results.ts";
import type { PaneListing, TmuxClient, TmuxWindow } from "./tmux.ts";

/**
 * What one ask says about a delegation's window: its program runs, the window
 * is missing or its program exited, or the multiplexer could not be asked.
 * `unknown` is never treated as gone.
 */
export type WindowState = "running" | "gone" | "unknown";

/** The fields of a record that locate its window. */
export type WindowRecord = Pick<StartedRecorded, "windowId" | "windowName">;

/** A record's window as one ask saw it. `session` is the tmux session the matching window is listed in, exited or not. */
export type WindowLook = { state: WindowState; session?: string };

/** One ask of the multiplexer, read for any number of records. */
export type WindowStates = {
	look(record: WindowRecord): WindowLook;
	state(record: WindowRecord): WindowState;
};

/** One `list-panes` ask: the window states, plus the pane listing a caller verifying a live pane reads. */
export type PaneStates = WindowStates & { readonly listing: PaneListing | undefined };

/** The window a record owns: both its recorded id and its recorded name, since tmux ids restart with every server. */
export function findWindow(windows: readonly TmuxWindow[], record: WindowRecord): TmuxWindow | undefined {
	return windows.find((window) => window.id === record.windowId && window.name === record.windowName);
}

/** States from one window listing; `undefined` (a failed or skipped ask) makes every record `unknown`. */
export function windowStates(windows: readonly TmuxWindow[] | undefined): WindowStates {
	const look = (record: WindowRecord): WindowLook => {
		if (windows === undefined) return { state: "unknown" };
		const own: TmuxWindow | undefined = findWindow(windows, record);
		if (own === undefined) return { state: "gone" };
		// A window whose program exited counts as gone.
		return { state: own.exited ? "gone" : "running", session: own.session };
	};
	return { look, state: (record: WindowRecord): WindowState => look(record).state };
}

/** Every record `unknown`: nothing was asked. */
export const UNASKED: PaneStates = { ...windowStates(undefined), listing: undefined };

/** One `list-windows` ask; a failed ask yields `unknown` for every record, never `gone`. */
export async function askWindowStates(tmux: TmuxClient): Promise<WindowStates> {
	let windows: TmuxWindow[] | undefined;
	try {
		windows = await tmux.listWindows();
	} catch {
		windows = undefined;
	}
	return windowStates(windows);
}

/** One `list-panes` ask; a failed ask yields `unknown` for every record and no listing. */
export async function askPaneStates(tmux: TmuxClient): Promise<PaneStates> {
	let listing: PaneListing | undefined;
	try {
		listing = await tmux.listPanes();
	} catch {
		listing = undefined;
	}
	return { ...windowStates(listing?.windows), listing };
}
