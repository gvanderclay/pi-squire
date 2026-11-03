// Optional live-window overrides for known local children, never semantic rewrites.
import { isStarted, type Results, type StartedRecorded, sessionIdOf } from "./results.ts";
import type { PaneListing } from "./tmux.ts";
import type { LiveActivityReader } from "./widget-live.ts";

export async function currentChildWindows(
	results: Results,
	listing: PaneListing | undefined,
	reader: LiveActivityReader,
): Promise<Map<string, { windowId: string; windowName: string }>> {
	const found = new Map<string, { windowId: string; windowName: string }>();
	if (!listing?.server || !listing.windows.length) return found;
	const server = listing.server;
	const latest = new Map<string, StartedRecorded>(
		results
			.list()
			.filter(isStarted)
			.map((record) => [sessionIdOf(record), record]),
	);
	await Promise.all(
		[...latest.values()].map(async (record): Promise<void> => {
			if (
				record.closed ||
				listing.windows.some(
					(window) => window.id === record.windowId && window.name === record.windowName && !window.exited,
				)
			)
				return;
			const live = await reader.locator(sessionIdOf(record));
			if (
				!live ||
				live.locator.socket !== server.socket ||
				live.locator.serverPid !== server.serverPid ||
				live.locator.serverStarted !== server.serverStarted
			)
				return;
			const pane = listing.panes.get(live.locator.paneId);
			if (pane && !pane.exited) found.set(record.id, { windowId: pane.windowId, windowName: pane.windowName });
		}),
	);
	return found;
}
