// One tmux observation answers many records; low-level listing and kill stay here.

import type { OpenedWindow } from "./host.ts";
import { matchWindow, type PaneListing, recordLocator, type TmuxClient, type TmuxWindow } from "./tmux.ts";
import { currentLiveWindow, type LivePaneLocator, tmuxLocator } from "./tmux-locator.ts";
import type {
	ClosableStates,
	LivePanes,
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

/**
 * Close a start that has no task. A refused kill is reported with recovery
 * wording unless a fresh listing proves the window already went (its program
 * may exit on its own), so a failed rollback never hides a taskless Pi.
 */
export async function closeTasklessWindow(
	tmux: Pick<TmuxClient, "kill" | "listWindows">,
	opened: OpenedWindow,
): Promise<void> {
	let refusal: unknown;
	try {
		await tmux.kill(opened.id);
		return;
	} catch (error) {
		refusal = error;
	}
	const gone = await tmux.listWindows().then(
		(windows) => !windows.some((window) => window.id === opened.id),
		() => false,
	);
	if (gone) return;
	const where = opened.session === undefined ? "" : ` in session ${opened.session}`;
	throw new Error(
		`the delegate's tmux window ${opened.id}${where} could not be closed (${(refusal as Error).message ?? String(refusal)}) and may still run Pi with no task. Check it is the delegate, then close it yourself (tmux kill-window -t ${opened.id})`,
		{ cause: refusal },
	);
}

export async function tmuxStates(tmux: TmuxClient, strict = false): Promise<ClosableStates> {
	if (strict) return closableStates(tmux, await tmux.listWindows());
	return closableStates(tmux, await tmux.listWindows().catch(() => undefined));
}
export async function tmuxPaneStates(tmux: TmuxClient): Promise<PaneStates> {
	const listing = await tmux.listPanes().catch(() => undefined);
	const states = windowStates(listing?.windows);
	return { ...states, livePanes: listing ? livePanes(listing, states) : undefined };
}

/** Panes on one positively identified server with windows; anything else places nothing. */
function livePanes(listing: PaneListing, states: WindowStates): LivePanes | undefined {
	if (!listing.server || !listing.windows.length) return undefined;
	return {
		running: (record: WindowRecord): boolean => states.state(record) === "running",
		windowOf: (live: LivePaneLocator): WindowRecord | undefined => currentLiveWindow(listing, live),
	};
}
