// Frozen executable v0.20.2 (c27b082d19662bdca37f5d4fb02e94b3037ed4ac) src/poll.ts.
// Type annotations stripped; only import paths relocated. See README.md.
// The poll: every few seconds the parent checks its running delegations,
// declares gone those whose window is gone. It runs only while a delegation is
// running.

import { listWindows, windowState } from "./windows.mjs";

/** The hook a tick emits so the provider claims waiting replies before windows are checked. */
const SCAN = "message:scan";
/** How often the parent checks its running delegations. */
const POLL_MS = 5000;

/** Record gone each running delegation whose window is missing or exited; a failed list declares nothing. */
function declareGone(pi, results, windows, live) {
	if (windows === undefined) return;
	for (const record of results.running()) {
		if (windowState(windows, record) !== "gone" || !live()) continue;
		// A reply may have landed while the windows before this one were checked.
		pi.events.emit(SCAN, {});
		results.recordGone(record.id);
	}
}

/** One sweep: claim waiting replies, declare gone every delegation whose window is missing or exited with still no result. */
async function sweep(pi, results, tmux, live) {
	if (results.running().length > 0) {
		results.syncCloses();
		const scan = {};
		pi.events.emit(SCAN, scan);
		// No message:* provider: a waiting reply cannot be ruled out, so nothing is declared gone.
		if (scan.scanned === true) {
			declareGone(pi, results, await listWindows(tmux), live); // one ask per tick
		}
	}
}

/** The poll over the records and tmux. `arm` readies it for a new session; `stop` ends it for good. */
export function createPoll(pi, results, tmux) {
	/** The poll timer; set only while a delegation is running. */
	let poll;
	let ticking = false;
	/** False once the session shuts down, so a tick still awaiting tmux declares nothing. */
	let live = true;

	function stopPolling() {
		if (poll !== undefined) clearInterval(poll);
		poll = undefined;
	}

	/** Whether the poll has anything left to watch. */
	const busy = () => results.running().length > 0;

	async function tick() {
		if (ticking) return;
		ticking = true;
		try {
			if (!busy()) return stopPolling();
			await sweep(pi, results, tmux, () => live);
			if (!busy()) stopPolling();
		} finally {
			ticking = false;
		}
	}

	/** Start the timer while a delegation is running; it never keeps the process alive. */
	function startPolling() {
		if (poll !== undefined || !busy()) return;
		poll = setInterval(() => void tick(), POLL_MS);
		poll.unref?.();
	}

	return {
		start: startPolling,
		stop() {
			live = false;
			stopPolling();
		},
		arm() {
			stopPolling();
			live = true;
		},
	};
}
