// Optional live-window overrides for known local children, never semantic rewrites.
import { isStarted, type Results, type StartedRecorded, sessionIdOf } from "./results.ts";
import { currentLiveWindow, type PaneListing, type WindowRecord } from "./tmux.ts";
import type { LiveActivityReader } from "./widget-live.ts";
import { windowStates } from "./window-state.ts";

export async function currentChildWindows(
	results: Results,
	listing: PaneListing | undefined,
	reader: LiveActivityReader,
): Promise<Map<string, WindowRecord>> {
	const found = new Map<string, WindowRecord>();
	if (!listing?.server || !listing.windows.length) return found;
	const windows = windowStates(listing.windows);
	const latest = new Map<string, StartedRecorded>(
		results
			.list()
			.filter(isStarted)
			.map((record) => [sessionIdOf(record), record]),
	);
	await Promise.all(
		[...latest.values()].map(async (record): Promise<void> => {
			if (record.closed || windows.state(record) === "running") return;
			const live = await reader.locator(sessionIdOf(record));
			const current = live ? currentLiveWindow(listing, live.locator) : undefined;
			if (current) found.set(record.id, current);
		}),
	);
	return found;
}
