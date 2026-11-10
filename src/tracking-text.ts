// How `delegation_status` words a delegation's state, auto-exit and age.
import type { DelegationState, StartedRecorded } from "./results.ts";
import { windowTerms } from "./tmux-locator.ts";

/** Records from before auto-exit existed kept their windows open, so they read off. */
export function autoExitLine(record: StartedRecorded): string {
	if (windowTerms(record).noun === "tab")
		return record.autoExit === true
			? "on — Pi exits after a normal completion; a clean exit closes its Herdr pane (errors retain it)"
			: "off — Pi and its Herdr tab stay open after the result";
	return record.autoExit === true
		? "on — the delegate closes its window after a normal completion unless the user took over there"
		: "off — the window stays open after the result";
}

/** The state, worded for the `state:` line. */
export function stateLine(state: DelegationState, record: StartedRecorded): string {
	const { noun, host } = windowTerms(record);
	switch (state) {
		case "running":
			return `running — the ${noun} is open and no result has arrived`;
		case "gone":
			return `closed without a result — the ${noun} is gone and no reply arrived; a late reply would make it done`;
		case "done":
			return `done — result status: ${record.result?.status ?? "unknown"}; the result reaches this session as a [delegate] message on its own`;
		case "closed":
			return "closed — delegation_close recorded it";
		case "window-closed":
			return `closed — the ${noun} is gone`;
		case "unknown":
			return `unknown — ${host} could not be asked whether the ${noun} is open`;
		case "planned":
		case "created":
		case "rolled-back":
		case "retained":
		case "interrupted":
			return `${state} — no window id/start was recorded; a window may still exist`;
	}
}

/** How long ago, worded for the `state:` line: `just now`, `N min ago` or `N h M min ago`. */
export function ago(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	return `${Math.floor(minutes / 60)} h ${minutes % 60} min ago`;
}
