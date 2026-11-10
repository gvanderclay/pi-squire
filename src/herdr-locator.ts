// Herdr pane/tab ids survive restoration; terminal_id is the incarnation fence.
import type { LivePaneLocator, LocatorRules } from "./locator-rules.ts";
export type HerdrLocator = {
	adapter: "herdr";
	version: 1;
	kind: "window";
	/** null is Herdr's default session (no HERDR_SESSION), reached by its socket. */
	session: string | null;
	socket: string;
	workspace: string;
	tab: string;
	pane: string;
	terminal: string;
	name: string;
	launchFile: string;
};
/** Disposable own-pane evidence, including a root Pi that has no Squire launch file. */
export type HerdrPaneLocator = Omit<HerdrLocator, "kind" | "launchFile"> & { kind: "pane" };
export function herdrPaneLocator(value: unknown): HerdrPaneLocator | undefined {
	if (!value || typeof value !== "object") return undefined;
	const own = value as Partial<HerdrPaneLocator>;
	return own.adapter === "herdr" &&
		own.version === 1 &&
		own.kind === "pane" &&
		sessionField(own.session) &&
		[own.socket, own.workspace, own.tab, own.pane, own.terminal, own.name].every(bounded)
		? (own as HerdrPaneLocator)
		: undefined;
}
export function sameHerdrPane(a: HerdrPaneLocator | HerdrLocator, b: HerdrPaneLocator | HerdrLocator): boolean {
	return (
		a.session === b.session &&
		a.socket === b.socket &&
		a.workspace === b.workspace &&
		a.tab === b.tab &&
		a.pane === b.pane &&
		a.terminal === b.terminal
	);
}
const bounded = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 4096;
/** A named session, or null for the default one; never empty or absent. */
const sessionField = (value: unknown): boolean => value === null || bounded(value);
export function herdrLocator(value: unknown): HerdrLocator | undefined {
	if (!value || typeof value !== "object") return undefined;
	const own = value as Partial<HerdrLocator>;
	return own.adapter === "herdr" &&
		own.version === 1 &&
		own.kind === "window" &&
		sessionField(own.session) &&
		[own.socket, own.workspace, own.tab, own.pane, own.terminal, own.name, own.launchFile].every(bounded)
		? (own as HerdrLocator)
		: undefined;
}
export function sameHerdrLocator(a: HerdrLocator, b: HerdrLocator): boolean {
	return (
		a.session === b.session &&
		a.socket === b.socket &&
		a.workspace === b.workspace &&
		a.tab === b.tab &&
		a.pane === b.pane &&
		a.terminal === b.terminal &&
		a.launchFile === b.launchFile
	);
}

export const herdrLocators: LocatorRules = {
	id: "herdr",
	terms: { noun: "tab", host: "Herdr", group: "workspace" },
	retainedAfterExit: true,
	requiresSessionGuard: true,
	ancestorReturnHint: true,
	liveIsWindow: true,
	window: (value: unknown) => !!herdrLocator(value),
	normalizeLive(value: unknown): LivePaneLocator | undefined {
		const own = herdrPaneLocator(value);
		return own ? { ...own } : undefined;
	},
	runningLive(value: unknown): LivePaneLocator | undefined {
		const own = herdrPaneLocator(value);
		return own ? { ...own } : undefined;
	},
	sameWindow: (a: object, b: object) => sameHerdrLocator(a as HerdrLocator, b as HerdrLocator),
	sameLive: (a: object, b: object) => sameHerdrPane(a as HerdrPaneLocator, b as HerdrPaneLocator),
	presentation(value: object): { windowId: string; windowName: string } {
		const own = value as HerdrLocator | HerdrPaneLocator;
		return { windowId: own.tab, windowName: own.name };
	},
	paneTarget(value: object): string | undefined {
		return herdrPaneLocator(value)?.pane;
	},
	autoExitText(on: boolean): string {
		return on
			? "on — Pi exits after a normal completion; a clean exit closes its Herdr pane (errors retain it)"
			: "off — Pi and its Herdr tab stay open after the result";
	},
};
