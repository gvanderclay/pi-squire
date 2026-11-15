// The verbs shared by delegate hosts. Concrete adapters own terminal protocols.
import type { LiveNavigation, WindowLocator } from "./locators.ts";
import type { WindowPlacement } from "./window-placement.ts";
import type { ClosableStates, PaneStates } from "./window-state.ts";
import type { PaseoReceipt } from "./worktree.ts";

/** Exact native session identity; the host must verify it before reopening. */
export type ResumeSource = { locator: object; sessionId: string; path: string; cwd: string; home?: string };
export type ResumeConfiguration = { model: string; thinking: string };

/** One window to open: its name, working directory, command and environment. */
export type WindowSpec = {
	name: string;
	cwd: string;
	argv: readonly string[];
	env: Readonly<Record<string, string>>;
	/** Persist known resource facts synchronously before the host continues; throwing stops launch. */
	onProgress?: (progress: OpenProgress) => void;
};

/** Placement facts, not proof a requested agent exists or that dispatch has completed. */
export type OpenProgress = { paseo?: PaseoReceipt; locator?: WindowLocator; sessionId?: string };

export type OpenedWindow = {
	id: string;
	paseo?: PaseoReceipt;
	session: string | undefined;
	/** The Pi session id, when the host assigned one instead of using the requested id. */
	sessionId?: string;
	locator?: WindowLocator;
	location?: string;
};

/** Positive daemon readback: this exact native resume was archived before any new task mail. */
export type NativeResumeRollback = { kind: "native-resume-closed"; sessionId: string; agentId: string };

/**
 * Whether an open may remain: not-opened requires no possible dispatch, or a
 * positively confirmed closed native rollback before new task mail. A timeout
 * or unconfirmed rollback stays unknown. Started terminal opens are not refunded.
 */
export class WindowOpenError extends Error {
	certainty: "not-opened" | "unknown";
	readonly nativeResumeRollback?: NativeResumeRollback;
	constructor(message: string, certainty: "not-opened" | "unknown", nativeResumeRollback?: NativeResumeRollback) {
		super(message);
		this.name = "WindowOpenError";
		this.certainty = certainty;
		this.nativeResumeRollback = nativeResumeRollback;
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
/** Static launch requirements, checked before reservations or workspace creation. */
export type StartOptions = { kind: StartKind; skills?: boolean; contextFiles?: boolean };
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
	/** Undefined means supported; refusal names the option and a usable alternative. */
	startProblem?(options: StartOptions): string | undefined;
	/** New terminal sessions receive mail before open; reopened ones after it. */
	taskMailTiming(kind: StartKind): "before-open" | "after-open";
	/** Optional API configuration after open; requires after-open task mail for every start kind. */
	configureStart?(opened: OpenedWindow, configuration: StartConfiguration): Promise<void>;
	/** Native frozen-config resume: inspect read-only, then revalidate and reopen before task mail. */
	resumeConfiguration?(source: ResumeSource): Promise<ResumeConfiguration>;
	resumeSession?(source: ResumeSource): Promise<OpenedWindow>;
	/** Setting/inheritance key; never inferred from a presentation noun. */
	readonly id: string;
	/** Accept owned identity; with a navigation target, also validate its adapter-specific routing fields. */
	ownsLocator(value: unknown, target?: WindowTarget): boolean;
	readonly windowNoun?: string;
	/** Whether launch uses the caller's tmux placement policy. */
	readonly usesWindowPlacement: boolean;
	/** Whether resume needs the session file before other checks. */
	readonly requiresSessionGuard: boolean;
	/** Delegates never auto-exit on this host. */
	readonly keepsDelegatesOpen?: boolean;
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
