// A shared observation and close protocol; hosts own how they obtain it.
import type { DelegateHost } from "./host.ts";
import type { LivePaneLocator } from "./locators.ts";
import { windowStates } from "./tmux-state.ts";

export type { WindowRecord } from "./locators.ts";
export { windowStates } from "./tmux-state.ts";

import type { WindowRecord } from "./locators.ts";

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

/** One host snapshot that places a live pane in its current window without another ask. */
export type LivePanes = {
	/** Whether this snapshot lists the record's own window with its program running. */
	running(record: WindowRecord): boolean;
	/** The running window this snapshot lists the live pane in, when this host owns the pane. */
	windowOf(live: LivePaneLocator): WindowRecord | undefined;
};

/**
 * One pane ask: the window states, plus the live panes it can place.
 * `livePanes` is absent when the ask failed, it listed nothing to place, or the host has no live pane.
 */
export type PaneStates = WindowStates & { readonly livePanes: LivePanes | undefined };

/** Every record unknown: nothing was asked. */
export const UNASKED: PaneStates = { ...windowStates(undefined), livePanes: undefined };
export function askWindowStates(host: DelegateHost): Promise<ClosableStates> {
	return host.states();
}
export function askToClose(host: DelegateHost): Promise<ClosableStates> {
	return host.states(true);
}
export async function askPaneStates(host: DelegateHost): Promise<PaneStates> {
	return host.paneStates ? host.paneStates() : { ...(await host.states()), livePanes: undefined };
}
