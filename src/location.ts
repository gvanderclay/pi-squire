// How the extension words where a delegate is: the noun (window or tab), the
// group it sits in (session or workspace) and the phrase the started, resume,
// fork, status and navigation text use. The public fields windowId, windowName
// and windowSession stay as they are; this module only words them.
import { type WindowRecord, windowPresentation, windowTerms } from "./tmux-locator.ts";

/** The fields a start or resume result carries about where the window opened. */
export type OpenedWhere = {
	/** The adapter's own wording for where it opened (a Herdr tab); absent keeps the tmux wording. */
	location?: string;
	windowName: string;
	windowSession?: string;
};

/** The noun, host and group a recorded delegate's window goes by. */
export function locationTerms(record: WindowRecord): { noun: string; host: string; group: string } {
	return windowTerms(record);
}

/** The session a window opened in, for the start text. */
export function inSession(session: string | undefined): string {
	return session === undefined ? "" : ` in session ${session}`;
}

/**
 * Where a delegate opened, for the start, resume and fork text: the adapter's
 * wording, else the tmux window and, unless `session` is false, its session.
 */
export function openedIn(opened: OpenedWhere, { session = true }: { session?: boolean } = {}): string {
	return opened.location ?? `window ${opened.windowName}${session ? inSession(opened.windowSession) : ""}`;
}

/** The expanded start result's line: the window, its id and its session. */
export function windowDetail(opened: { windowName: string; windowId: string; windowSession?: string }): string {
	return `window ${opened.windowName} (${opened.windowId})${inSession(opened.windowSession)}`;
}

/** The status line for a recorded delegate's window; an empty session is left out. */
export function recordedLocation(record: WindowRecord, session: string | undefined): string {
	const { noun, group } = locationTerms(record);
	const { windowName, windowId } = windowPresentation(record);
	return `${noun}: ${windowName} (${windowId})${session === undefined || session === "" ? "" : ` in ${group} ${session}`}`;
}

/** The notice for a delegation whose `noun` has no verified open pane. */
export function noVerifiedOpen(noun: string, { changed = true }: { changed?: boolean } = {}): string {
	return `no verified open ${noun}${changed ? ` for this delegation; ${noun} changed or unavailable` : ""}`;
}
