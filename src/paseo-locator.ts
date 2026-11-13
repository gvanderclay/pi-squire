// A Paseo agent id is the durable identity; the agent's title is presentation only.
import type { LivePaneLocator, LocatorRules } from "./locator-rules.ts";
export type PaseoLocator = { adapter: "paseo"; version: 1; kind: "window"; agent: string; name: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bounded = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 4096;
export function paseoLocator(value: unknown): PaseoLocator | undefined {
	if (!value || typeof value !== "object") return undefined;
	const own = value as Partial<PaseoLocator>;
	return own.adapter === "paseo" &&
		own.version === 1 &&
		own.kind === "window" &&
		typeof own.agent === "string" &&
		uuid.test(own.agent) &&
		bounded(own.name)
		? (own as PaseoLocator)
		: undefined;
}

export const paseoLocators: LocatorRules = {
	id: "paseo",
	terms: { noun: "agent", host: "Paseo", group: "workspace" },
	retainedAfterExit: false,
	requiresSessionGuard: false,
	ancestorReturnHint: false,
	liveIsWindow: false,
	window: (value: unknown) => !!paseoLocator(value),
	normalizeLive(): LivePaneLocator | undefined {
		return undefined;
	},
	runningLive(): LivePaneLocator | undefined {
		return undefined;
	},
	sameWindow(a: object, b: object): boolean {
		return (a as PaseoLocator).agent === (b as PaseoLocator).agent;
	},
	sameLive(): boolean {
		return false;
	},
	presentation(value: object): { windowId: string; windowName: string } {
		const own = value as PaseoLocator;
		return { windowId: own.agent, windowName: own.name };
	},
	paneTarget(): string | undefined {
		return undefined;
	},
	autoExitText(on: boolean): string {
		return on
			? "on — the Paseo agent is archived after its task reply and nested work are handled unless the user took over"
			: "off — the Paseo agent stays open after the result";
	},
};
