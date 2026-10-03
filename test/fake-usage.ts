// The test stand-in for the usage readers, the package's second injected seam.
// It answers `readGo` with whatever the test scripted and counts the calls.
// With nothing scripted it reports "no reading": no windows, so nothing blocks.
import type { GoReading, UsageClient, UsageWindow } from "../src/usage.ts";

/** A quota window with a percent used and an optional reset time. */
export const win = (
	label: string,
	percent: number | null,
	resetsAt: number | null = null,
	limited = false,
): UsageWindow => ({
	label,
	percent,
	resetsAt,
	limited,
});

export class FakeUsage implements UsageClient {
	/** What the next reads answer. */
	go: GoReading = { ok: true, windows: [] };
	/** Every call to `readGo`, with the key and base URLs it was given. */
	readonly calls: { key: string | undefined; baseUrls: (string | undefined)[] }[] = [];

	async readGo(key: string | undefined, baseUrls: (string | undefined)[]): Promise<GoReading> {
		this.calls.push({ key, baseUrls });
		return this.go;
	}
}
