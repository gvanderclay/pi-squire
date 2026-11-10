// Behaviour tests project the adapter-owned durable locator to the same window
// text their fake multiplexer observes. Schema tests inspect the raw records.
import { type WindowRecord, windowPresentation } from "../src/tmux.ts";

export function windowFields<T extends object>(record: T): T & { windowId: string; windowName: string } {
	return ("locator" in record ? { ...record, ...windowPresentation(record as WindowRecord) } : record) as T & {
		windowId: string;
		windowName: string;
	};
}
