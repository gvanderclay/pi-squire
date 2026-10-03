// Proactive quota checks: read a provider's usage before a launch, so a model
// whose quota is used up is skipped without spending a request. Only OpenCode
// Go for now. A failed reading never throws and never blocks a launch.
import { type Mark, recordProactive } from "./limits.ts";

const PROVIDER = "opencode-go";
/** How long one reading is reused, so a burst of launches makes one request. */
const CACHE_MS = 60_000;

// --- Twin of ../dotfiles/pi/extensions/usage-status.ts (parseGoUsage, resetTime,
// --- num, goOriginAllowed and the fetch in refreshGo). Copied, not shared; keep
// --- the two in step until the user decides how to package them.

const GO_TIMEOUT_MS = 20_000;
const GO_ORIGIN = "https://opencode.ai";
const GO_USAGE_URL = `${GO_ORIGIN}/zen/go/v1/usage`;

/** One quota window; `limited` is the provider's own `rate-limited` status. */
export type UsageWindow = { label: string; percent: number | null; resetsAt: number | null; limited: boolean };

function num(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Epoch ms from an ISO string or epoch seconds. */
function resetTime(value: unknown): number | null {
	if (typeof value === "string" && value.trim()) {
		const ms = Date.parse(value);
		return Number.isNaN(ms) ? null : ms;
	}
	const seconds = num(value);
	return seconds === null ? null : seconds * 1000;
}

export function parseGoUsage(payload: unknown): UsageWindow[] | null {
	const usage = (
		payload as { usage?: Record<string, { status?: unknown; percent?: unknown; resetsAt?: unknown }> } | null
	)?.usage;
	if (typeof usage !== "object" || usage === null) return null;
	const windows: UsageWindow[] = [];
	for (const [key, label] of [
		["rolling", "5h"],
		["weekly", "wk"],
		["monthly", "mo"],
	] as const) {
		const raw = usage[key];
		const ok = raw?.status === "ok" || raw?.status === "rate-limited";
		windows.push({
			label,
			percent: ok ? num(raw?.percent) : null,
			resetsAt: ok ? resetTime(raw?.resetsAt) : null,
			limited: raw?.status === "rate-limited",
		});
	}
	return windows.some((w) => w.percent !== null || w.limited) ? windows : null;
}

/** Every configured OpenCode Go base URL must stay on the origin the key belongs to. */
export function goOriginAllowed(urls: (string | undefined)[]): boolean {
	return urls.every((url) => !url || !URL.canParse(url) || new URL(url).origin === GO_ORIGIN);
}

// --- End of the copied section.

export type GoReading = { ok: true; windows: UsageWindow[] } | { ok: false; reason: string };

/** The test seam: reads usage. Implementations never throw. */
export type UsageClient = {
	/** Read Go usage with `key`; `baseUrls` are every base URL configured for the provider, all of which must be on the Go origin. */
	readGo(key: string | undefined, baseUrls: (string | undefined)[]): Promise<GoReading>;
};

export function createUsageClient(): UsageClient {
	return {
		async readGo(key: string | undefined, baseUrls: (string | undefined)[]): Promise<GoReading> {
			if (!goOriginAllowed(baseUrls)) return { ok: false, reason: `a base URL is not on ${GO_ORIGIN}; key not sent` };
			if (!key) return { ok: false, reason: "no API key" };
			try {
				const response = await fetch(GO_USAGE_URL, {
					headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
					redirect: "error",
					signal: AbortSignal.timeout(GO_TIMEOUT_MS),
				});
				if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
				const windows = parseGoUsage(await response.json());
				return windows ? { ok: true, windows } : { ok: false, reason: "unreadable response" };
			} catch (err) {
				const e = err as Error;
				return {
					ok: false,
					reason: e?.name === "TimeoutError" ? "timed out" : `network error: ${String(e?.message).slice(0, 100)}`,
				};
			}
		},
	};
}

/** A provider's last failed reading. */
export type ReadingError = { provider: string; reason: string; at: string };

/** The slice of Pi's model registry the check reads. */
type Registry = {
	getApiKeyForProvider(provider: string): Promise<string | undefined>;
	getProvider(provider: string): { baseUrl?: string } | undefined;
	find(provider: string, id: string): { baseUrl?: string } | undefined;
};

/** The windows that are used up, recorded as one proactive mark on `provider`. */
function recordFull(provider: string, windows: UsageWindow[], now: number): Mark | undefined {
	const full = windows.filter((w) => w.limited || (w.percent ?? 0) >= 100);
	if (full.length === 0) return undefined;
	const resets = full.map((w) => w.resetsAt).filter((t): t is number => t !== null && t > now);
	const reason = full
		.map((w) => (w.percent === null ? `Go ${w.label} window rate-limited` : `Go ${w.label} window at ${w.percent}%`))
		.join(", ");
	return recordProactive(provider, reason, resets.length > 0 ? Math.max(...resets) : undefined, now);
}

/** Proactive checks over one usage client, with their cache and last reading errors. */
export function createProactive(client: UsageClient): {
	errors(): ReadingError[];
	/** Forget cached readings, so the next check reads afresh. */
	clear(): void;
	check(models: Registry, provider: string, id: string): Promise<{ notice?: string; mark?: Mark }>;
} {
	let cached: { at: number; reading: GoReading } | undefined;
	const lastErrors = new Map<string, ReadingError>();

	async function read(models: Registry, provider: string, id: string, now: number): Promise<GoReading> {
		if (cached !== undefined && now - cached.at < CACHE_MS) return cached.reading;
		let reading: GoReading;
		try {
			reading = await client.readGo(await models.getApiKeyForProvider(provider), [
				models.getProvider(provider)?.baseUrl,
				models.find(provider, id)?.baseUrl,
			]);
		} catch (err) {
			reading = { ok: false, reason: `error: ${String((err as Error)?.message).slice(0, 100)}` };
		}
		cached = { at: now, reading };
		if (reading.ok) lastErrors.delete(provider);
		else lastErrors.set(provider, { provider, reason: reading.reason, at: new Date(now).toISOString() });
		return reading;
	}

	return {
		/** The last failed reading per provider. */
		errors: (): ReadingError[] => [...lastErrors.values()],
		clear: (): void => {
			cached = undefined;
		},
		/**
		 * Check `provider/id` against its quota. Records a `proactive` mark when a
		 * window is used up and returns it (even if the file could not be written),
		 * or the fail-open line as `notice` when the reading failed.
		 */
		async check(models: Registry, provider: string, id: string): Promise<{ notice?: string; mark?: Mark }> {
			if (provider !== PROVIDER) return {};
			const now = Date.now();
			const reading = await read(models, provider, id, now);
			if (!reading.ok)
				return { notice: `Could not read ${provider} quota: ${reading.reason}; launched without a proactive check.` };
			return { mark: recordFull(provider, reading.windows, now) };
		},
	};
}

export type Proactive = ReturnType<typeof createProactive>;
