// The popups the parent opened over the user's tmux clients. tmux closes a
// popup's contents when the delegate's window goes, but not the popup itself:
// the poll closes it, through this registry, once its window is gone.
import type { TmuxClient, TmuxWindow } from "./tmux.ts";

/** A popup the parent opened: the window it shows and the client it is on. */
export type Popup = { windowId: string; windowName: string; client: string };

export type Popups = {
	/** Remember a popup. */
	track(popup: Popup): void;
	/** How many popups are remembered. */
	count(): number;
	/** Forget every popup, closing none. */
	clear(): void;
	/** Close each popup whose window is not in `windows`; a failed listing (undefined) keeps them all for the next tick. */
	closeGone(windows: TmuxWindow[] | undefined): Promise<void>;
};

export function createPopups(tmux: TmuxClient): Popups {
	const open: Popup[] = [];
	return {
		track: (popup: Popup): void => {
			open.push(popup);
		},
		count: (): number => open.length,
		clear: (): void => {
			open.length = 0;
		},
		async closeGone(windows: TmuxWindow[] | undefined): Promise<void> {
			if (windows === undefined) return;
			for (const popup of [...open]) {
				if (windows.some((window) => window.id === popup.windowId && window.name === popup.windowName)) continue;
				try {
					await tmux.closePopup(popup.client);
				} catch {
					// The popup may already be closed or its client gone; one try, then forget it.
				}
				const at = open.indexOf(popup);
				if (at >= 0) open.splice(at, 1);
			}
		},
	};
}
