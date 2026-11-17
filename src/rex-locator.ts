// Rex ids are UUIDs minted per resource and never reused, so the block id is
// the incarnation fence. A block may be moved to another window of its session;
// the window id is presentation, not identity.
import type { LivePaneLocator, LocatorRules } from "./locator-rules.ts";

export type RexLocator = {
	adapter: "rex";
	version: 1;
	kind: "window";
	/** The server endpoint, as Rex gives it to the terminal in REX_SERVER. */
	server: string;
	session: string;
	/** The window the block was created in; shown, never compared. */
	window: string;
	block: string;
	name: string;
	launchFile: string;
};
/** Disposable own-block evidence, including a root Pi that has no Squire launch file. */
export type RexPaneLocator = Omit<RexLocator, "kind" | "launchFile"> & { kind: "pane" };

const bounded = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 4096;

export function rexLocator(value: unknown): RexLocator | undefined {
	if (!value || typeof value !== "object") return undefined;
	const own = value as Partial<RexLocator>;
	return own.adapter === "rex" &&
		own.version === 1 &&
		own.kind === "window" &&
		[own.server, own.session, own.window, own.block, own.name, own.launchFile].every(bounded)
		? (own as RexLocator)
		: undefined;
}
export function rexPaneLocator(value: unknown): RexPaneLocator | undefined {
	if (!value || typeof value !== "object") return undefined;
	const own = value as Partial<RexPaneLocator>;
	return own.adapter === "rex" &&
		own.version === 1 &&
		own.kind === "pane" &&
		[own.server, own.session, own.window, own.block, own.name].every(bounded)
		? (own as RexPaneLocator)
		: undefined;
}
export function sameRexBlock(a: RexLocator | RexPaneLocator, b: RexLocator | RexPaneLocator): boolean {
	return a.server === b.server && a.session === b.session && a.block === b.block;
}

export const rexLocators: LocatorRules = {
	id: "rex",
	terms: { noun: "window", host: "Rex", group: "session" },
	// Rex keeps a terminal whose program failed right after it started.
	retainedAfterExit: true,
	requiresSessionGuard: false,
	ancestorReturnHint: true,
	liveIsWindow: true,
	window: (value: unknown) => !!rexLocator(value),
	normalizeLive(value: unknown): LivePaneLocator | undefined {
		const own = rexPaneLocator(value);
		return own ? { ...own } : undefined;
	},
	runningLive(value: unknown): LivePaneLocator | undefined {
		const own = rexPaneLocator(value);
		return own ? { ...own } : undefined;
	},
	sameWindow(a: object, b: object): boolean {
		const left = a as RexLocator,
			right = b as RexLocator;
		return sameRexBlock(left, right) && left.launchFile === right.launchFile;
	},
	sameLive: (a: object, b: object) => sameRexBlock(a as RexPaneLocator, b as RexPaneLocator),
	presentation(value: object): { windowId: string; windowName: string } {
		const own = value as RexLocator | RexPaneLocator;
		return { windowId: own.window, windowName: own.name };
	},
	paneTarget(value: object): string | undefined {
		return rexPaneLocator(value)?.block;
	},
	autoExitText(on: boolean): string {
		return on
			? "on — Pi exits after a normal completion and Rex closes its terminal (a start that fails at once stays open)"
			: "off — Pi and its Rex window stay open after the result";
	},
};
