// The poll: every few seconds the parent checks its running delegations,
// declares gone those whose window is gone, and closes the popups of windows
// that went. It runs while a delegation is running or a popup is open.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createPopups, type Popup, type Popups } from "./popups.ts";
import type { Results } from "./results.ts";
import type { TmuxClient, TmuxWindow } from "./tmux.ts";
import { listWindows, windowState } from "./windows.ts";

/** The hook a tick emits so the provider claims waiting replies before windows are checked. */
const SCAN = "message:scan";
/** How often the parent checks its running delegations. */
const POLL_MS = 5000;

/** Record gone each running delegation whose window is missing or exited; a failed list declares nothing. */
function declareGone(pi: ExtensionAPI, results: Results, windows: TmuxWindow[] | undefined, live: () => boolean): void {
	if (windows === undefined) return;
	for (const record of results.running()) {
		if (windowState(windows, record) !== "gone" || !live()) continue;
		// A reply may have landed while the windows before this one were checked.
		pi.events.emit(SCAN, {});
		results.recordGone(record.id);
	}
}

/** One sweep: claim waiting replies, declare gone every delegation whose window is missing or exited with still no result, and close the popups of gone windows. */
async function sweep(
	pi: ExtensionAPI,
	results: Results,
	tmux: TmuxClient,
	popups: Popups,
	live: () => boolean,
): Promise<void> {
	let windows: TmuxWindow[] | undefined;
	let asked = false;
	if (results.running().length > 0) {
		const scan: { scanned?: boolean } = {};
		pi.events.emit(SCAN, scan);
		// No message:* provider: a waiting reply cannot be ruled out, so nothing is declared gone.
		if (scan.scanned === true) {
			windows = await listWindows(tmux); // one ask per tick
			asked = true;
			declareGone(pi, results, windows, live);
		}
	}
	if (popups.count() > 0) await popups.closeGone(asked ? windows : await listWindows(tmux));
}

/** The poll over the records and tmux. `arm` readies it for a new session; `stop` ends it for good. */
export function createPoll(
	pi: ExtensionAPI,
	results: Results,
	tmux: TmuxClient,
): { start(): void; stop(): void; arm(): void; track(popup: Popup): () => void } {
	/** The poll timer; set only while something is running or a popup is open. */
	let poll: ReturnType<typeof setInterval> | undefined;
	let ticking = false;
	/** False once the session shuts down, so a tick still awaiting tmux declares nothing. */
	let live = true;
	const popups = createPopups(tmux);

	function stopPolling(): void {
		if (poll !== undefined) clearInterval(poll);
		poll = undefined;
	}

	/** Whether the poll has anything left to watch. */
	const busy = (): boolean => results.running().length > 0 || popups.count() > 0;

	async function tick(): Promise<void> {
		if (ticking) return;
		ticking = true;
		try {
			if (!busy()) return stopPolling();
			await sweep(pi, results, tmux, popups, () => live);
			if (!busy()) stopPolling();
		} finally {
			ticking = false;
		}
	}

	/** Start the timer when something is running or a popup is open; it never keeps the process alive. */
	function startPolling(): void {
		if (poll !== undefined || !busy()) return;
		poll = setInterval(() => void tick(), POLL_MS);
		poll.unref?.();
	}

	return {
		start: startPolling,
		track(popup: Popup): () => void {
			const forget = popups.track(popup);
			startPolling();
			return (): void => {
				forget();
				if (!busy()) stopPolling();
			};
		},
		stop(): void {
			live = false;
			stopPolling();
			popups.clear();
		},
		arm(): void {
			stopPolling();
			popups.clear();
			live = true;
		},
	};
}
