// Opaque locator contracts. Persisted encodings belong to individual adapters.
import type { DelegateHost } from "./host.ts";
/** Adapter-owned durable values. Callers may store them, never inspect their shape. */
export type WindowLocator = object;
export type LivePaneLocator = object;
/** Optional adapter-owned observation and terminal verification for disposable telemetry. */
export type LiveNavigation = {
	observeLivePane?(): Promise<LivePaneLocator | undefined>;
	verifyLivePane?(locator: LivePaneLocator): Promise<VerifiedLiveWindow | undefined>;
	/** Before resume side effects: reject when another live Pi may host the session, or that is unknown. */
	guardSession?(record: WindowRecord, session: { path: string; id: string }, launch: DelegateHost): Promise<void>;
};
/** Legacy fields are read only when no locator property is present. */
export type WindowRecord = { locator?: WindowLocator; windowId?: string; windowName?: string };

export type VerifiedLiveWindow = WindowRecord & { paneTarget: string };
export type LocationTerms = { noun: string; host: string; group: string };
export type LocatorRules = {
	readonly id: string;
	readonly terms: LocationTerms;
	readonly retainedAfterExit: boolean;
	readonly requiresSessionGuard: boolean;
	readonly ancestorReturnHint: boolean;
	/** Whether live evidence itself can name a navigation window (never durable authority). */
	readonly liveIsWindow: boolean;
	window(value: unknown): boolean;
	normalizeLive(value: unknown): LivePaneLocator | undefined;
	runningLive(value: unknown): LivePaneLocator | undefined;
	sameWindow(a: object, b: object): boolean;
	sameLive(a: object, b: object): boolean;
	presentation(value: object): { windowId: string; windowName: string };
	paneTarget(value: object): string | undefined;
	autoExitText(on: boolean): string;
};
