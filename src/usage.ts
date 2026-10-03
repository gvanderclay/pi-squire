// Proactive quota checks: read a provider's usage before a launch, so a model
// whose quota is used up is skipped without spending a request. OpenCode Go and
// Anthropic models used through a Claude subscription login. A failed reading
// never throws and never blocks a launch.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type Mark, recordProactive } from "./limits.ts";

const PROVIDER = "opencode-go";
const CLAUDE = "anthropic";
/** A Claude cache older than this is refreshed, and the refresh runs at most this often. */
const CLAUDE_FETCH_AFTER_MS = 5 * 60_000;
const CLAUDE_TIMEOUT_MS = 30_000;
/** How long one reading is reused, so a burst of launches makes one request. */
const CACHE_MS = 60_000;

// --- Twin of ../dotfiles/pi/extensions/usage-status.ts (parseGoUsage, resetTime,
// --- num, goOriginAllowed, the fetch in refreshGo, parseClaudeCache,
// --- scopedApplies and refreshClaudeCache). Copied, not shared; keep the two in
// --- step until the user decides how to package them. Differences: Claude
// --- windows carry no `windowMs` or credits (they never block); usage-status.ts
// --- reads nothing when CLAUDE_CONFIG_DIR is unset, while claudeCachePath falls
// --- back to ~/.claude.json, Claude Code's default location, so the check works
// --- without the user's alias (refreshClaude then spawns only when
// --- ~/.claude.json or ~/.claude exists, so it never runs for a user without
// --- Claude Code); and the 5-minute rate limit on refreshes lives in
// --- createProactive, not here.

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

export type ClaudeUsage = {
	fiveHour: UsageWindow;
	sevenDay: UsageWindow;
	scoped: UsageWindow | null;
	fetchedAt: number | null;
};

type ClaudeRow = {
	kind?: string;
	percent?: unknown;
	resets_at?: unknown;
	scope?: { model?: { display_name?: unknown } };
};
type ClaudeLegacy = { utilization?: unknown; resets_at?: unknown };

export function parseClaudeCache(state: unknown): ClaudeUsage | null {
	const entry = (
		state as {
			cachedUsageUtilization?: {
				fetchedAtMs?: unknown;
				utilization?: { limits?: unknown; five_hour?: ClaudeLegacy; seven_day?: ClaudeLegacy };
			};
		} | null
	)?.cachedUsageUtilization;
	const u = entry?.utilization;
	if (typeof u !== "object" || u === null) return null;
	const rows: ClaudeRow[] = Array.isArray(u.limits) ? u.limits : [];
	const row = (kind: string): ClaudeRow | undefined => rows.find((r) => r?.kind === kind);
	const window = (label: string, kind: string, legacy: ClaudeLegacy | undefined): UsageWindow => {
		const r = row(kind);
		return {
			label,
			percent: num(r?.percent) ?? num(legacy?.utilization),
			resetsAt: resetTime(r?.resets_at) ?? resetTime(legacy?.resets_at),
			limited: false,
		};
	};
	const scopedRow = row("weekly_scoped");
	const scopedName = scopedRow?.scope?.model?.display_name;
	return {
		fiveHour: window("5h", "session", u.five_hour),
		sevenDay: window("7d", "weekly_all", u.seven_day),
		scoped:
			typeof scopedName === "string" && scopedName
				? {
						label: scopedName,
						percent: num(scopedRow?.percent),
						resetsAt: resetTime(scopedRow?.resets_at),
						limited: false,
					}
				: null,
		fetchedAt: num(entry?.fetchedAtMs),
	};
}

/** The scoped week belongs to a model when its name contains the scope label. */
export function scopedApplies(scopedLabel: string, model: { name?: string; id?: string } | undefined): boolean {
	const needle = scopedLabel.toLowerCase();
	return [model?.name, model?.id].some((s) => typeof s === "string" && s.toLowerCase().includes(needle));
}

function claudeCachePath(): string {
	const dir = process.env.CLAUDE_CONFIG_DIR;
	return dir ? join(dir, ".claude.json") : join(homedir(), ".claude.json");
}

// --- End of the copied section.

export type ClaudeReading = ({ ok: true } & ClaudeUsage) | { ok: false; reason: string };

export type GoReading = { ok: true; windows: UsageWindow[] } | { ok: false; reason: string };

/** The test seam: reads usage. Implementations never throw. */
export type UsageClient = {
	/** Read Go usage with `key`; `baseUrls` are every base URL configured for the provider, all of which must be on the Go origin. */
	readGo(key: string | undefined, baseUrls: (string | undefined)[]): Promise<GoReading>;
	/** Read Claude Code's usage cache as it stands; never waits for a refresh. */
	readClaude(): ClaudeReading;
	/** Start `claude -p /usage` in the background so Claude Code rewrites its cache. Fire and forget; does nothing without Claude Code state (see the guard). */
	refreshClaude(): void;
};

export function createUsageClient(): UsageClient {
	return {
		readClaude(): ClaudeReading {
			try {
				const usage = parseClaudeCache(JSON.parse(readFileSync(claudeCachePath(), "utf8")));
				return usage ? { ok: true, ...usage } : { ok: false, reason: "no usage in Claude Code's cache" };
			} catch (err) {
				return { ok: false, reason: `cache unreadable: ${String((err as Error)?.message).slice(0, 100)}` };
			}
		},
		refreshClaude(): void {
			try {
				// Never spawn without Claude Code state: the config directory, or with
				// CLAUDE_CONFIG_DIR unset, ~/.claude.json or ~/.claude.
				const dir = process.env.CLAUDE_CONFIG_DIR;
				if (
					!(dir
						? existsSync(dir)
						: existsSync(join(homedir(), ".claude.json")) || existsSync(join(homedir(), ".claude")))
				)
					return;
				const child = spawn("claude", ["-p", "/usage", "--no-session-persistence"], { cwd: tmpdir(), stdio: "ignore" });
				const kill = setTimeout(() => child.kill(), CLAUDE_TIMEOUT_MS);
				kill.unref();
				const done = () => clearTimeout(kill);
				child.on("error", done); // a missing `claude` is not worth a word
				child.on("close", done);
				child.unref();
			} catch {
				// Fire and forget: a failed spawn costs nothing.
			}
		},
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
	find(provider: string, id: string): { baseUrl?: string; name?: string; id?: string; provider?: string } | undefined;
	isUsingOAuth(model: { provider?: string; id?: string }): boolean;
};

/** The windows that are used up, recorded as one proactive mark on `provider`. */
function recordFull(scope: string, windows: UsageWindow[], now: number, name = "Go"): Mark | undefined {
	// A window at 100% whose reset time has passed has reset; the reading is stale.
	const full = windows.filter(
		(w) => w.limited || ((w.percent ?? 0) >= 100 && (w.resetsAt === null || w.resetsAt > now)),
	);
	if (full.length === 0) return undefined;
	const resets = full.map((w) => w.resetsAt).filter((t): t is number => t !== null && t > now);
	const reason = full
		.map((w) =>
			w.percent === null ? `${name} ${w.label} window rate-limited` : `${name} ${w.label} window at ${w.percent}%`,
		)
		.join(", ");
	return recordProactive(scope, reason, resets.length > 0 ? Math.max(...resets) : undefined, now);
}

/** Proactive checks over one usage client, with their cache and last reading errors. */
export function createProactive(client: UsageClient): {
	errors(): ReadingError[];
	/** Forget cached readings, so the next check reads afresh. */
	clear(): void;
	check(models: Registry, provider: string, id: string): Promise<{ notice?: string; mark?: Mark }>;
} {
	let refreshedAt = Number.NEGATIVE_INFINITY;
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

	/** Have Claude Code refetch its cache, at most every 5 minutes per process, never waited for. */
	function refreshClaude(now: number): void {
		if (now - refreshedAt < CLAUDE_FETCH_AFTER_MS) return;
		refreshedAt = now;
		try {
			client.refreshClaude();
		} catch {
			// A refresh never blocks a launch.
		}
	}

	/** Claude subscription (OAuth) logins only; API-key users rely on reactive marks. */
	function checkClaude(models: Registry, id: string, now: number): { notice?: string; mark?: Mark } {
		const model = models.find(CLAUDE, id);
		if (!model || !models.isUsingOAuth(model)) return {};
		const reading = client.readClaude();
		const fresh = reading.ok && reading.fetchedAt !== null && now - reading.fetchedAt <= CLAUDE_FETCH_AFTER_MS;
		if (!fresh) refreshClaude(now);
		if (!reading.ok) {
			lastErrors.set(CLAUDE, { provider: CLAUDE, reason: reading.reason, at: new Date(now).toISOString() });
			return { notice: `Could not read ${CLAUDE} quota: ${reading.reason}; launched without a proactive check.` };
		}
		lastErrors.delete(CLAUDE);
		const mark = recordFull(CLAUDE, [reading.fiveHour, reading.sevenDay], now, "Claude");
		if (mark) return { mark };
		const scoped = reading.scoped;
		if (scoped && scopedApplies(scoped.label, model))
			return { mark: recordFull(`${CLAUDE}/${id}`, [scoped], now, "Claude") };
		return {};
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
			const now = Date.now();
			if (provider === CLAUDE) return checkClaude(models, id, now);
			if (provider !== PROVIDER) return {};
			const reading = await read(models, provider, id, now);
			if (!reading.ok)
				return { notice: `Could not read ${provider} quota: ${reading.reason}; launched without a proactive check.` };
			return { mark: recordFull(provider, reading.windows, now) };
		},
	};
}

export type Proactive = ReturnType<typeof createProactive>;
