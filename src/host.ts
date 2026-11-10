// The verbs shared by delegate hosts. Concrete adapters own terminal protocols.
import type { LiveNavigation, WindowLocator } from "./locators.ts";
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
 * `not-opened` only when nothing was dispatched that could create it.
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

/** A navigation target. Public ids are presentation; a locator is routing authority. */
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

export type StartKind = "launch" | "resume" | "fork";
export type StartConfiguration = {
	kind: StartKind;
	sessionId: string;
	launchId: string;
	model: string;
	thinking: string;
	cwd: string;
	sessionDir: string;
};

export interface DelegateHost extends LiveNavigation {
	/** New terminal sessions receive mail before open; reopened ones after it. */
	taskMailTiming(kind: StartKind): "before-open" | "after-open";
	/** Optional API configuration after open; requires after-open task mail for every start kind. */
	configureStart?(opened: OpenedWindow, configuration: StartConfiguration): Promise<void>;
	/** Setting/inheritance key; never inferred from a presentation noun. */
	readonly id: string;
	/** Accept owned identity; with a navigation target, also validate its adapter-specific routing fields. */
	ownsLocator(value: unknown, target?: WindowTarget): boolean;
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
	/** Roll back an opened resume with no task; any refusal includes the host-specific recovery wording. */
	closeTaskless(opened: OpenedWindow): Promise<void>;
	/** Optional positively observed startup recovery; absence never adopts by name. */
	currentWindow?(): Promise<{ id: string; name: string } | undefined>;
}
