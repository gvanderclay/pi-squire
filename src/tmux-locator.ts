// The tmux adapter owns only tmux encodings and exact server/pane matching.
import type {
	LivePaneLocator,
	LocatorRules,
	VerifiedLiveWindow,
	WindowLocator,
	WindowRecord,
} from "./locator-rules.ts";
import type { PaneListing, PaneLocator, TmuxClient, TmuxWindow } from "./tmux.ts";

// Compatibility exports for released imports; host-neutral rules live in locators.ts.
export * from "./locators.ts";

type TmuxLocator = { adapter: "tmux"; version: 1; kind: "window"; id: string; name: string };
type TmuxPaneLocator = { adapter: "tmux"; version: 1; kind: "pane"; pane: PaneLocator };

function bounded(value: unknown, empty = false): value is string {
	return typeof value === "string" && (empty || value.length > 0) && Buffer.byteLength(value) <= 512;
}

export function tmuxLocator(value: unknown): value is WindowLocator {
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

export function tmuxWindowLocator(window: { id: string; name: string }): WindowLocator {
	const locator: TmuxLocator = { adapter: "tmux", version: 1, kind: "window", id: window.id, name: window.name };
	if (!tmuxLocator(locator)) throw new Error("invalid tmux window locator");
	return locator;
}
function tmuxRecord(record: WindowRecord): TmuxLocator | undefined {
	if ("locator" in record) return tmuxLocator(record.locator) ? (record.locator as TmuxLocator) : undefined;
	if (typeof record.windowId !== "string" || typeof record.windowName !== "string") return undefined;
	const locator = { adapter: "tmux", version: 1, kind: "window", id: record.windowId, name: record.windowName };
	return tmuxLocator(locator) ? (locator as TmuxLocator) : undefined;
}
export function matchWindow(windows: readonly TmuxWindow[], record: WindowRecord): TmuxWindow | undefined {
	const own = tmuxRecord(record);
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
	return pane && !pane.exited
		? { locator: tmuxWindowLocator({ id: pane.windowId, name: pane.windowName }) }
		: undefined;
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
	const record = { locator: tmuxWindowLocator({ id: pane.windowId, name: pane.windowName }) };
	const windows = await tmux.listWindows().catch(() => undefined);
	return windows && matchWindow(windows, record) ? { ...record, paneTarget: pane.paneId } : undefined;
}

export const tmuxLocators: LocatorRules = {
	id: "tmux",
	terms: { noun: "window", host: "tmux", group: "session" },
	retainedAfterExit: false,
	requiresSessionGuard: false,
	ancestorReturnHint: false,
	liveIsWindow: false,
	window: tmuxLocator,
	normalizeLive(value: unknown): LivePaneLocator | undefined {
		const pane = paneLocator(value);
		return pane ? liveLocator(pane) : undefined;
	},
	runningLive(value: unknown): LivePaneLocator | undefined {
		const pane = paneLocator(value);
		return pane && !pane.exited ? liveLocator(pane) : undefined;
	},
	sameWindow(a: object, b: object): boolean {
		const left = a as TmuxLocator,
			right = b as TmuxLocator;
		return left.id === right.id && left.name === right.name;
	},
	sameLive(a: object, b: object): boolean {
		const left = paneLocator(a),
			right = paneLocator(b);
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
	},
	presentation(value: object): { windowId: string; windowName: string } {
		const own = value as TmuxLocator;
		return { windowId: own.id, windowName: own.name };
	},
	paneTarget(value: object): string | undefined {
		return paneLocator(value)?.paneId;
	},
	autoExitText(on: boolean): string {
		return on
			? "on — the delegate closes its window after a normal completion unless the user took over there"
			: "off — the window stays open after the result";
	},
};
