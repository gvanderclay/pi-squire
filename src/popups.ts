// The popups the parent opened over the user's tmux clients. tmux closes a
// popup's contents when the delegate's window goes, but not the popup itself:
// the poll closes it, through this registry, once its window is gone. A client
// shows one popup at a time, so the registry holds the current popup per
// client; a new popup replaces the old record, and a record is dropped when
// its own popup's process ends, so a stale record never closes a newer popup.
import type { TmuxClient, TmuxWindow } from "./tmux.ts";

/** A popup the parent opened: the window it shows and the client it is on. */
export type Popup = { windowId: string; windowName: string; client: string };

export type Popups = {
	/** Remember a popup as its client's current one; returns the call that forgets exactly this popup. */
	track(popup: Popup): () => void;
	/** How many popups are remembered. */
	count(): number;
	/** Forget every popup, closing none. */
	clear(): void;
	/** Close each current popup whose window is not in `windows`; a failed listing (undefined) keeps them all for the next tick. */
	closeGone(windows: TmuxWindow[] | undefined): Promise<void>;
};

export function createPopups(tmux: TmuxClient): Popups {
	const current = new Map<string, Popup>();
	return {
		track(popup: Popup): () => void {
			const entry = { ...popup };
			current.set(entry.client, entry);
			return (): void => {
				if (current.get(entry.client) === entry) current.delete(entry.client);
			};
		},
		count: (): number => current.size,
		clear: (): void => current.clear(),
		async closeGone(windows: TmuxWindow[] | undefined): Promise<void> {
			if (windows === undefined) return;
			for (const entry of [...current.values()]) {
				const here = windows.some((window) => window.id === entry.windowId && window.name === entry.windowName);
				if (here || current.get(entry.client) !== entry) continue;
				current.delete(entry.client); // forgotten first, so nothing closes it twice
				try {
					await tmux.closePopup(entry.client);
				} catch {
					// The popup may already be closed or its client gone; one try, then forgotten.
				}
			}
		},
	};
}
