// One tmux observation answers many records; low-level listing and kill stay here.

import { matchWindow, recordLocator, type TmuxClient, type TmuxWindow } from "./tmux.ts";
import { tmuxLocator } from "./tmux-locator.ts";
import type {
	ClosableStates,
	PaneStates,
	WindowLook,
	WindowRecord,
	WindowState,
	WindowStates,
} from "./window-state.ts";

/** Ask the adapter whether this observation contains the record's exact identity. */
function findWindow(windows: readonly TmuxWindow[], record: WindowRecord): TmuxWindow | undefined {
	return matchWindow(windows, record);
}

/** States from one window listing; `undefined` (a failed or skipped ask) makes every record `unknown`. */
export function windowStates(windows: readonly TmuxWindow[] | undefined): WindowStates {
	const look = (record: WindowRecord): WindowLook => {
		if (windows === undefined || !tmuxLocator(recordLocator(record))) return { state: "unknown" };
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
			if (!tmuxLocator(recordLocator(record)))
				throw new Error("invalid or unsupported delegate window locator; close refused");
			const own: TmuxWindow | undefined = findWindow(windows, record);
			if (own === undefined) return false;
			await tmux.kill(own.id);
			return true;
		},
	};
}

export async function tmuxStates(tmux: TmuxClient, strict = false): Promise<ClosableStates> {
	if (strict) return closableStates(tmux, await tmux.listWindows());
	return closableStates(tmux, await tmux.listWindows().catch(() => undefined));
}
export async function tmuxPaneStates(tmux: TmuxClient): Promise<PaneStates> {
	const listing = await tmux.listPanes().catch(() => undefined);
	return { ...windowStates(listing?.windows), listing };
}
