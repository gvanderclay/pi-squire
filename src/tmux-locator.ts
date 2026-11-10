// The tmux adapter owns durable locator encoding, validation and comparison.
import { herdrLocator, herdrPaneLocator, sameHerdrLocator, sameHerdrPane } from "./herdr-locator.ts";
import type { DelegateHost } from "./host.ts";
import type { PaneListing, PaneLocator, TmuxClient, TmuxWindow } from "./tmux.ts";

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
type TmuxLocator = { adapter: "tmux"; version: 1; kind: "window"; id: string; name: string };
type TmuxPaneLocator = { adapter: "tmux"; version: 1; kind: "pane"; pane: PaneLocator };

function bounded(value: unknown, empty = false): value is string {
	return typeof value === "string" && (empty || value.length > 0) && Buffer.byteLength(value) <= 512;
}
export function validWindowLocator(value: unknown): value is WindowLocator {
	if (herdrLocator(value)) return true;
	if (!value || typeof value !== "object") return false;
	const own = value as Partial<TmuxLocator>;
	return (
		own.adapter === "tmux" &&
		own.version === 1 &&
		own.kind === "window" &&
		typeof own.id === "string" &&
		/^@[0-9]+$/.test(own.id) &&
		typeof own.name === "string"
	);
}
/** Mint only after a positive adapter observation or create response. */
export function windowLocator(window: { id: string; name: string; locator?: WindowLocator }): WindowLocator {
	if (window.locator) {
		if (!validWindowLocator(window.locator) && !herdrPaneLocator(window.locator))
			throw new Error("invalid navigation locator");
		return window.locator;
	}
	const locator: TmuxLocator = { adapter: "tmux", version: 1, kind: "window", id: window.id, name: window.name };
	if (!validWindowLocator(locator)) throw new Error("invalid tmux window locator");
	return locator;
}
export function recordLocator(record: WindowRecord): WindowLocator | undefined {
	// An explicit malformed/foreign value must never downgrade to legacy identity.
	if ("locator" in record) return validWindowLocator(record.locator) ? record.locator : undefined;
	if (typeof record.windowId !== "string" || typeof record.windowName !== "string") return undefined;
	const locator = { adapter: "tmux", version: 1, kind: "window", id: record.windowId, name: record.windowName };
	return validWindowLocator(locator) ? locator : undefined;
}
export function sameWindowLocator(a: WindowRecord, b: WindowRecord): boolean {
	const herdrA = herdrLocator(recordLocator(a));
	const herdrB = herdrLocator(recordLocator(b));
	if (herdrA || herdrB) return !!herdrA && !!herdrB && sameHerdrLocator(herdrA, herdrB);
	const left = recordLocator(a) as TmuxLocator | undefined;
	const right = recordLocator(b) as TmuxLocator | undefined;
	return !!left && !!right && left.id === right.id && left.name === right.name;
}
export function windowTerms(record: WindowRecord): { noun: string; host: string; group: string } {
	return herdrLocator(record.locator)
		? { noun: "tab", host: "Herdr", group: "workspace" }
		: { noun: "window", host: "tmux", group: "session" };
}
/** Public display/result fields are presentation only, never routing authority. */
export function windowPresentation(record: WindowRecord): { windowId: string; windowName: string } {
	const herdr = herdrLocator(recordLocator(record)) ?? herdrPaneLocator(record.locator);
	if (herdr) return { windowId: herdr.tab, windowName: herdr.name };
	const own = recordLocator(record) as TmuxLocator | undefined;
	return { windowId: own?.id ?? "not-recorded", windowName: own?.name ?? "not-recorded" };
}
/** Upgrade released records on read/write without retaining duplicate routing authority. */
export function locatedRecord<T extends WindowRecord>(record: T): T {
	const locator = recordLocator(record);
	if (!locator) throw new Error("invalid or unsupported delegate window locator");
	const copy = { ...record, locator };
	delete copy.windowId;
	delete copy.windowName;
	return copy;
}
export function matchWindow(windows: readonly TmuxWindow[], record: WindowRecord): TmuxWindow | undefined {
	if (herdrLocator(recordLocator(record))) return undefined;
	const own = recordLocator(record) as TmuxLocator | undefined;
	return own ? windows.find((window) => window.id === own.id && window.name === own.name) : undefined;
}
function validPane(value: unknown): value is PaneLocator {
	if (!value || typeof value !== "object") return false;
	const own = value as Partial<PaneLocator>;
	return (
		bounded(own.socket) &&
		Number.isSafeInteger(own.serverPid) &&
		(own.serverPid ?? 0) > 0 &&
		bounded(own.serverStarted) &&
		bounded(own.paneId) &&
		/^%[0-9]+$/.test(own.paneId) &&
		bounded(own.windowId) &&
		/^@[0-9]+$/.test(own.windowId) &&
		bounded(own.windowName, true) &&
		typeof own.exited === "boolean"
	);
}
export function liveLocator(pane: PaneLocator): LivePaneLocator {
	if (!validPane(pane)) throw new Error("invalid tmux pane locator");
	return { adapter: "tmux", version: 1, kind: "pane", pane: { ...pane } } satisfies TmuxPaneLocator;
}
/** Released live telemetry used bare PaneLocator. An explicit adapter envelope cannot fall back. */
export function paneLocator(value: unknown): PaneLocator | undefined {
	if (!value || typeof value !== "object") return undefined;
	if ("adapter" in value || "version" in value || "kind" in value) {
		const own = value as Partial<TmuxPaneLocator>;
		return own.adapter === "tmux" && own.version === 1 && own.kind === "pane" && validPane(own.pane)
			? { ...own.pane }
			: undefined;
	}
	return validPane(value) ? { ...value } : undefined;
}
/** Accept released telemetry on read, but always publish an adapter envelope. */
export function normalizeLiveLocator(value: unknown): LivePaneLocator | undefined {
	const herdr = herdrPaneLocator(value);
	if (herdr) return { ...herdr };
	const pane = paneLocator(value);
	return pane ? liveLocator(pane) : undefined;
}
export function runningLiveLocator(value: unknown): LivePaneLocator | undefined {
	const herdr = herdrPaneLocator(value);
	if (herdr) return { ...herdr };
	const pane = paneLocator(value);
	return pane && !pane.exited ? liveLocator(pane) : undefined;
}
export function sameLiveLocator(a: unknown, b: unknown): boolean {
	const h = herdrPaneLocator(a),
		other = herdrPaneLocator(b);
	if (h || other) return !!h && !!other && sameHerdrPane(h, other);
	const left = paneLocator(a);
	const right = paneLocator(b);
	return (
		!!left &&
		!!right &&
		left.socket === right.socket &&
		left.serverPid === right.serverPid &&
		left.serverStarted === right.serverStarted &&
		left.paneId === right.paneId &&
		left.windowId === right.windowId &&
		left.windowName === right.windowName &&
		left.exited === right.exited
	);
}

/** Project one verified live pane onto its current window without exposing locator internals. */
export function currentLiveWindow(listing: PaneListing, value: LivePaneLocator): WindowRecord | undefined {
	const locator = paneLocator(value);
	const server = listing.server;
	if (
		!locator ||
		!server ||
		locator.socket !== server.socket ||
		locator.serverPid !== server.serverPid ||
		locator.serverStarted !== server.serverStarted
	)
		return undefined;
	const pane = listing.panes.get(locator.paneId);
	return pane && !pane.exited ? { locator: windowLocator({ id: pane.windowId, name: pane.windowName }) } : undefined;
}
export type VerifiedLiveWindow = WindowRecord & { paneTarget: string };
export function sameVerifiedWindow(a: VerifiedLiveWindow, b: VerifiedLiveWindow): boolean {
	return (
		(herdrPaneLocator(a.locator) ? sameLiveLocator(a.locator, b.locator) : sameWindowLocator(a, b)) &&
		a.paneTarget === b.paneTarget
	);
}
/** Same-server, exact-pane, then id/name listing; preserves the existing three asks. */
export async function verifyTmuxPaneWindow(
	tmux: TmuxClient,
	value: LivePaneLocator,
): Promise<VerifiedLiveWindow | undefined> {
	const locator = paneLocator(value);
	if (!locator) return undefined;
	const sameServer = (pane: PaneLocator): boolean =>
		pane.socket === locator.socket &&
		pane.serverPid === locator.serverPid &&
		pane.serverStarted === locator.serverStarted;
	const own = await tmux.inspectPane?.();
	if (!own || !sameServer(own)) return undefined;
	const pane = await tmux.inspectPane?.(locator.paneId);
	if (!pane || pane.exited || !sameServer(pane)) return undefined;
	const record = { locator: windowLocator({ id: pane.windowId, name: pane.windowName }) };
	const windows = await tmux.listWindows().catch(() => undefined);
	return windows && matchWindow(windows, record) ? { ...record, paneTarget: pane.paneId } : undefined;
}
export async function verifyPaneWindow(
	host: DelegateHost,
	value: LivePaneLocator,
): Promise<VerifiedLiveWindow | undefined> {
	return host.verifyLivePane?.(value);
}
export function livePaneTarget(value: LivePaneLocator): string | undefined {
	return herdrPaneLocator(value)?.pane ?? paneLocator(value)?.paneId;
}
