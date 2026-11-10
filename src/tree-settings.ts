import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { treeCaps as read, type TreeCaps } from "./settings.ts";

export type { TreeCaps };

/** Call-time settings; malformed cap state must never silently become unlimited. */
export function treeCaps(): TreeCaps {
	return read(getAgentDir());
}
