import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_WIDGET_SETTINGS, widgetSettings as read, type WidgetSettings } from "./settings.ts";

export { DEFAULT_WIDGET_SETTINGS, type WidgetSettings };

/** Cosmetic settings never block delegation; the caller reports errors and uses defaults. */
export function widgetSettings(): WidgetSettings {
	return read(getAgentDir());
}
