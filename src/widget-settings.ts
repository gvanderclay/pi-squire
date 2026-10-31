import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type WidgetSettings = { placement: "aboveEditor" | "belowEditor"; maxEntries: number };
export const DEFAULT_WIDGET_SETTINGS: WidgetSettings = { placement: "aboveEditor", maxEntries: 3 };

/** Cosmetic settings never block delegation; the caller reports errors and uses defaults. */
export function widgetSettings(): WidgetSettings {
	const file: string = join(getAgentDir(), "squire", "settings.json");
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_WIDGET_SETTINGS };
		throw new Error(`could not read widget settings in ${file}: ${String(error)}`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`invalid widget settings in ${file}: expected an object`);
	const settings: Record<string, unknown> = value as Record<string, unknown>;
	const placement: unknown =
		settings.delegateWidgetPlacement === undefined ? "above" : settings.delegateWidgetPlacement;
	const cap: unknown = settings.delegateWidgetMaxEntries === undefined ? 3 : settings.delegateWidgetMaxEntries;
	if (placement !== "above" && placement !== "below")
		throw new Error(`invalid delegateWidgetPlacement in ${file}: expected above or below`);
	if (typeof cap !== "number" || !Number.isSafeInteger(cap) || cap < 0)
		throw new Error(`invalid delegateWidgetMaxEntries in ${file}: expected a nonnegative integer`);
	return { placement: placement === "above" ? "aboveEditor" : "belowEditor", maxEntries: cap };
}
