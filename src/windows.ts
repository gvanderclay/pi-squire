// Window-list helpers for the callers not yet moved to `window-state.ts`
// (close, resume, fork and tree reconciliation). The match rule itself lives in
// `window-state.ts`.
import type { StartedRecorded } from "./results.ts";
import type { TmuxClient, TmuxWindow } from "./tmux.ts";
import { findWindow, type WindowState, windowStates } from "./window-state.ts";

/** Every window on the server, asked once; a failed ask is `undefined`, never an empty list. */
export async function listWindows(tmux: TmuxClient): Promise<TmuxWindow[] | undefined> {
	try {
		return await tmux.listWindows();
	} catch {
		return undefined;
	}
}

/** The window a delegation owns: one with both its recorded id and its recorded name, since ids restart with every tmux server. */
export function ownWindow(windows: TmuxWindow[], record: StartedRecorded): TmuxWindow | undefined {
	return findWindow(windows, record);
}

/** What the listing says about a delegation's window; a matching window whose program exited counts as gone. */
export function windowState(windows: TmuxWindow[] | undefined, record: StartedRecorded): WindowState {
	return windowStates(windows).state(record);
}
