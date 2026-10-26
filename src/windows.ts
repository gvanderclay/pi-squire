// Reading tmux's window list against the delegation records.
import type { StartedRecorded, WindowState } from "./results.ts";
import type { TmuxClient, TmuxWindow } from "./tmux.ts";

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
	return windows.find((window) => window.id === record.windowId && window.name === record.windowName);
}

/** What the listing says about a delegation's window; a matching window whose program exited counts as gone. */
export function windowState(windows: TmuxWindow[] | undefined, record: StartedRecorded): WindowState {
	if (windows === undefined) return "unknown";
	const own = ownWindow(windows, record);
	return own !== undefined && !own.exited ? "open" : "gone";
}
