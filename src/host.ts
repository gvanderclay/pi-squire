// The verbs shared by delegate hosts. Concrete adapters own terminal protocols.
import type { LiveNavigation, WindowLocator } from "./tmux-locator.ts";
import type { WindowPlacement } from "./window-placement.ts";
import type { ClosableStates, PaneStates } from "./window-state.ts";

/** One window to open: its name, working directory, command and environment. */
export type WindowSpec = {
	name: string;
	cwd: string;
	argv: readonly string[];
	env: Readonly<Record<string, string>>;
};

export type OpenedWindow = {
	id: string;
	session: string | undefined;
	locator?: WindowLocator;
	location?: string;
};

/**
 * Why a window could not be opened, and whether one may exist anyway:
 * `not-opened` only when nothing was dispatched to tmux that could create it.
 * Anything else, a timeout or a malformed answer included, is `unknown`.
 */
export class WindowOpenError extends Error {
	certainty: "not-opened" | "unknown";
	constructor(message: string, certainty: "not-opened" | "unknown") {
		super(message);
		this.name = "WindowOpenError";
		this.certainty = certainty;
	}
}

/** Where a delegate window is: its tmux window id and, when known, the exact pane to read. */
export type WindowTarget = { windowId: string; paneId?: string; locator?: WindowLocator };

/** Showing either switched, was canceled by verification, or could not find a viewing terminal. */
export type ShowResult = { shown: true; returnHint: string } | { shown: false } | NoViewer;

/**
 * Why no terminal can show a window. `text` is the full reason, `brief` the
 * short one, and `cause` the error when a lookup failed rather than found nothing.
 * Delegate navigation displays the full reason; ancestor navigation preserves
 * its short refusal for a missing client and propagates lookup errors.
 */
export type NoViewer = { text: string; brief: string; cause?: unknown };

export interface DelegateHost extends LiveNavigation {
	/** Setting/inheritance key; never inferred from a presentation noun. */
	readonly id: string;
	/** Accept only navigation/durable locators this host can route safely. */
	ownsLocator(value: unknown): boolean;
	readonly windowNoun?: string;
	/** Whether launch uses the caller's tmux placement policy. */
	readonly usesWindowPlacement: boolean;
	/** Whether resume needs the session file before other checks. */
	readonly requiresSessionGuard: boolean;
	states(strict?: boolean): Promise<ClosableStates>;
	/** Optional terminal navigation snapshot; hosts without panes omit it. */
	paneStates?(): Promise<PaneStates>;
	forLaunch?(): DelegateHost;
	unavailable(): string | undefined;
	unavailable(checkVersion: true): Promise<string | undefined>;
	show(target: WindowTarget, verify: () => Promise<boolean>): Promise<ShowResult>;
	readonly windowListRefusal: string;
	peek(target: WindowTarget): Promise<string>;
	openWindow(spec: WindowSpec, placement: WindowPlacement, companion: string): Promise<OpenedWindow>;
	/** Optional positively observed startup recovery; absence never adopts by name. */
	currentWindow?(): Promise<{ id: string; name: string } | undefined>;
}
