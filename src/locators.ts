// Read-only dispatch of adapter-owned codecs/facts. Unknown tags fail closed.
// This table is deliberately closed for durable readers: adding a host adds its
// codec here; older released readers must refuse that tag before any mutation.
import { herdrLocators } from "./herdr-locator.ts";
import type { DelegateHost } from "./host.ts";
import type {
	LivePaneLocator,
	LocationTerms,
	LocatorRules,
	VerifiedLiveWindow,
	WindowLocator,
	WindowRecord,
} from "./locator-rules.ts";
import { paseoLocators } from "./paseo-locator.ts";
import { tmuxLocators, tmuxWindowLocator } from "./tmux-locator.ts";

export type {
	LiveNavigation,
	LivePaneLocator,
	VerifiedLiveWindow,
	WindowLocator,
	WindowRecord,
} from "./locator-rules.ts";
// Terminal-specific compatibility helpers; these are not the shared host protocol.
export { currentLiveWindow, liveLocator, matchWindow, paneLocator } from "./tmux-locator.ts";

const adapters = (): readonly LocatorRules[] => [tmuxLocators, herdrLocators, paseoLocators];
function codec(value: unknown): LocatorRules | undefined {
	if (!value || typeof value !== "object" || !("adapter" in value)) return undefined;
	return adapters().find((adapter) => adapter.id === value.adapter);
}
export function locatorRules(value: unknown): LocatorRules | undefined {
	const own = codec(value);
	return own && (own.window(value) || own.normalizeLive(value)) ? own : undefined;
}
export function validWindowLocator(value: unknown): value is WindowLocator {
	return codec(value)?.window(value) === true;
}
/** Explicit malformed/foreign identity never downgrades to legacy fields. */
export function recordLocator(record: WindowRecord): WindowLocator | undefined {
	if ("locator" in record) return validWindowLocator(record.locator) ? record.locator : undefined;
	if (typeof record.windowId !== "string" || typeof record.windowName !== "string") return undefined;
	const value = { adapter: "tmux", version: 1, kind: "window", id: record.windowId, name: record.windowName };
	return validWindowLocator(value) ? value : undefined;
}
/** Mint tmux identity only for released id/name inputs; explicit locators keep their owner. */
export function windowLocator(window: { id: string; name: string; locator?: WindowLocator }): WindowLocator {
	if (window.locator) {
		const own = locatorRules(window.locator);
		if (!own || (!own.window(window.locator) && !own.liveIsWindow)) throw new Error("invalid navigation locator");
		return window.locator;
	}
	return tmuxWindowLocator(window);
}
export function locatedRecord<T extends WindowRecord>(record: T): T {
	const locator = recordLocator(record);
	if (!locator) throw new Error("invalid or unsupported delegate window locator");
	const copy = { ...record, locator };
	delete copy.windowId;
	delete copy.windowName;
	return copy;
}
export function sameWindowLocator(a: WindowRecord, b: WindowRecord): boolean {
	const left = recordLocator(a),
		right = recordLocator(b),
		own = codec(left);
	return !!left && !!right && !!own && own === codec(right) && own.sameWindow(left, right);
}
/** Presentation defaults preserve legacy wording, never confer routing authority. */
export function windowTerms(record: WindowRecord): LocationTerms {
	const own = codec(record.locator);
	return own?.window(record.locator) ? own.terms : tmuxLocators.terms;
}
export function windowPresentation(record: WindowRecord): { windowId: string; windowName: string } {
	const value = recordLocator(record) ?? record.locator,
		own = locatorRules(value);
	return value && own && (own.window(value) || own.liveIsWindow)
		? own.presentation(value)
		: { windowId: "not-recorded", windowName: "not-recorded" };
}
export function windowFacts(
	record: WindowRecord,
): Pick<LocatorRules, "retainedAfterExit" | "requiresSessionGuard" | "ancestorReturnHint"> {
	return locatorRules(record.locator ?? recordLocator(record)) ?? tmuxLocators;
}
export function autoExitText(record: WindowRecord, on: boolean): string {
	const own = codec(record.locator);
	return (own?.window(record.locator) ? own : tmuxLocators).autoExitText(on);
}
/** Bare released tmux pane telemetry is the only untagged live input. */
export function normalizeLiveLocator(value: unknown): LivePaneLocator | undefined {
	return (codec(value) ?? tmuxLocators).normalizeLive(value);
}
export function runningLiveLocator(value: unknown): LivePaneLocator | undefined {
	return (codec(value) ?? tmuxLocators).runningLive(value);
}
export function sameLiveLocator(a: unknown, b: unknown): boolean {
	const left = normalizeLiveLocator(a),
		right = normalizeLiveLocator(b),
		own = codec(left);
	return !!left && !!right && !!own && own === codec(right) && own.sameLive(left, right);
}
/** Navigation may use an adapter's disposable live evidence, never close/resume authority. */
export function sameNavigationWindow(a: WindowRecord, b: WindowRecord): boolean {
	const own = locatorRules(a.locator);
	return own?.liveIsWindow && own.normalizeLive(a.locator)
		? sameLiveLocator(a.locator, b.locator)
		: sameWindowLocator(a, b);
}
export function sameVerifiedWindow(a: VerifiedLiveWindow, b: VerifiedLiveWindow): boolean {
	return sameNavigationWindow(a, b) && a.paneTarget === b.paneTarget;
}
export async function verifyPaneWindow(
	host: DelegateHost,
	value: LivePaneLocator,
): Promise<VerifiedLiveWindow | undefined> {
	return host.verifyLivePane?.(value);
}
export function livePaneTarget(value: LivePaneLocator): string | undefined {
	const normalized = normalizeLiveLocator(value);
	return normalized ? locatorRules(normalized)?.paneTarget(normalized) : undefined;
}
