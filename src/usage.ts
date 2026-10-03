// Proactive quota checks: read a provider's usage before a launch, so a model
// whose quota is used up is skipped without spending a request. OpenCode Go and
// Anthropic models used through a Claude subscription login. A failed reading
// never throws and never blocks a launch.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isFree, type Mark, readMarks, recordProactive, removeMark } from "./limits.ts";

const PROVIDER = "opencode-go";
const CLAUDE = "anthropic";
/** A Claude cache older than this is refreshed, and the refresh runs at most this often. */
const CLAUDE_FETCH_AFTER_MS = 5 * 60_000;
const CLAUDE_TIMEOUT_MS = 30_000;
/** How long one reading is reused, so a burst of launches makes one request. */
const CACHE_MS = 60_000;
/** A marked provider is re-checked for an early clear at most this often. */
const RECHECK_MS = 10 * 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS: number = 24 * HOUR_MS;

// --- Twin of ../dotfiles/pi/extensions/usage-status.ts (parseGoUsage, resetTime,
// --- num, goOriginAllowed, the fetch in refreshGo, parseClaudeCache,
// --- scopedApplies and refreshClaudeCache). Copied, not shared; keep the two in
// --- step until the user decides how to package them. Differences: Claude
// --- windows carry no credits (they never block); usage-status.ts
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
export type UsageWindow = {
	label: string;
	percent: number | null;
	resetsAt: number | null;
	limited: boolean;
	/** The window's full length, which with `resetsAt` gives the start of its cycle. */
	windowMs?: number;
};

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
	for (const [key, label, windowMs] of [
		["rolling", "5h", 5 * HOUR_MS],
		["weekly", "wk", 7 * DAY_MS],
		["monthly", "mo", 30 * DAY_MS],
	] as const) {
		const raw = usage[key];
		const ok = raw?.status === "ok" || raw?.status === "rate-limited";
		windows.push({
			label,
			percent: ok ? num(raw?.percent) : null,
			resetsAt: ok ? resetTime(raw?.resetsAt) : null,
			limited: raw?.status === "rate-limited",
			windowMs,
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
	const window = (label: string, kind: string, legacy: ClaudeLegacy | undefined, windowMs: number): UsageWindow => {
		const r = row(kind);
		return {
			label,
			percent: num(r?.percent) ?? num(legacy?.utilization),
			resetsAt: resetTime(r?.resets_at) ?? resetTime(legacy?.resets_at),
			limited: false,
			windowMs,
		};
	};
	const scopedRow = row("weekly_scoped");
	const scopedName = scopedRow?.scope?.model?.display_name;
	return {
		fiveHour: window("5h", "session", u.five_hour, 5 * HOUR_MS),
		sevenDay: window("7d", "weekly_all", u.seven_day, 7 * DAY_MS),
		scoped:
			typeof scopedName === "string" && scopedName
				? {
						label: scopedName,
						percent: num(scopedRow?.percent),
						resetsAt: resetTime(scopedRow?.resets_at),
						limited: false,
						windowMs: 7 * DAY_MS,
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
	find(
		provider: string,
		id: string,
	):
		| {
				baseUrl?: string;
				name?: string;
				id?: string;
				provider?: string;
				cost?: { input?: number; output?: number };
		  }
		| undefined;
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

type Rechecker = {
	readGo(models: Registry, provider: string, id: string, now: number): Promise<GoReading>;
	readClaude(now: number): ClaudeReading;
	/** When each provider was last re-checked, in memory only. */
	rechecked: Map<string, number>;
};

/** The provider's windows, and the scoped one when it applies to the candidate; undefined when unreadable. */
async function windowsFor(
	r: Rechecker,
	models: Registry,
	provider: string,
	id: string,
	now: number,
): Promise<{ provider: UsageWindow[]; scoped?: UsageWindow } | undefined> {
	if (provider === PROVIDER) {
		const reading = await r.readGo(models, provider, id, now);
		return reading.ok ? { provider: reading.windows } : undefined;
	}
	const model = models.find(CLAUDE, id);
	if (!model || !models.isUsingOAuth(model)) return undefined;
	const reading = r.readClaude(now);
	if (!reading.ok) return undefined;
	const { scoped } = reading;
	return {
		provider: [reading.fiveHour, reading.sevenDay],
		scoped: scoped && scopedApplies(scoped.label, model) ? scoped : undefined,
	};
}

/** Whether `w` began a new cycle after `at`; a window without a reset time or length cannot say. */
const resetSince = (w: UsageWindow | undefined, at: number): boolean =>
	w !== undefined && w.resetsAt !== null && !!w.windowMs && w.resetsAt - w.windowMs > at;

/**
 * Clear the active marks on `provider/id` whose quota has reset since they were
 * recorded, at most once per provider every 10 minutes. Headroom alone proves
 * nothing: every applying window must be under 100%, and for a provider mark one
 * of them must have begun a new cycle after the mark (for a model mark, the
 * scoped window). A failed reading keeps the marks.
 */
async function recheckMarks(r: Rechecker, models: Registry, provider: string, id: string): Promise<string[]> {
	const now = Date.now();
	const marks = readMarks(now).filter(
		(m) =>
			m.clearsAt > now &&
			now - m.recordedAt >= RECHECK_MS && // a mark this fresh is itself a recent check
			(m.scope === `${provider}/${id}` || (m.scope === provider && !isFree(models, provider, id))),
	);
	if (marks.length === 0 || (provider !== PROVIDER && provider !== CLAUDE)) return [];
	if (now - (r.rechecked.get(provider) ?? Number.NEGATIVE_INFINITY) < RECHECK_MS) return [];
	r.rechecked.set(provider, now);
	const found = await windowsFor(r, models, provider, id, now);
	if (!found) return [];
	const windows = [...found.provider, ...(found.scoped ? [found.scoped] : [])].filter(
		(w) => w.limited || w.percent !== null,
	);
	if (windows.some((w) => w.limited || (w.percent ?? 0) >= 100)) return [];
	return marks
		.filter((m) =>
			m.scope.includes("/") ? resetSince(found.scoped, m.recordedAt) : windows.some((w) => resetSince(w, m.recordedAt)),
		)
		.filter((m) => removeMark(m.scope, now))
		.map((m) => `Cleared the usage-limit mark on ${m.scope}: its quota has reset since the mark was recorded.`);
}

/** The mark a Claude reading calls for on `anthropic/id`: the 5h or 7d window used up, else the scoped week when it names the model. */
function claudeMark(
	reading: ClaudeUsage,
	model: { name?: string; id?: string },
	id: string,
	now: number,
): Mark | undefined {
	const { scoped } = reading;
	return (
		recordFull(CLAUDE, [reading.fiveHour, reading.sevenDay], now, "Claude") ??
		(scoped && scopedApplies(scoped.label, model) ? recordFull(`${CLAUDE}/${id}`, [scoped], now, "Claude") : undefined)
	);
}

/** Proactive checks over one usage client, with their cache and last reading errors. */
export type Proactive = {
	errors(): ReadingError[];
	/** Forget cached readings, so the next check reads afresh. */
	clear(): void;
	check(models: Registry, provider: string, id: string): Promise<{ notice?: string; mark?: Mark }>;
	/** Clear marks whose quota has reset since they were recorded; a line per mark cleared. */
	recheck(models: Registry, provider: string, id: string): Promise<string[]>;
};

export function createProactive(client: UsageClient): Proactive {
	let refreshedAt = Number.NEGATIVE_INFINITY;
	let cached: { at: number; reading: GoReading } | undefined;
	const lastErrors = new Map<string, ReadingError>();
	const rechecked = new Map<string, number>();

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

	/** Read Claude's cache, refreshing a stale one in the background, and keep the reading error. */
	function readClaude(now: number): ClaudeReading {
		const reading = client.readClaude();
		if (!(reading.ok && reading.fetchedAt !== null && now - reading.fetchedAt <= CLAUDE_FETCH_AFTER_MS))
			refreshClaude(now);
		if (reading.ok) lastErrors.delete(CLAUDE);
		else lastErrors.set(CLAUDE, { provider: CLAUDE, reason: reading.reason, at: new Date(now).toISOString() });
		return reading;
	}

	/** Claude subscription (OAuth) logins only; API-key users rely on reactive marks. */
	function checkClaude(models: Registry, id: string, now: number): { notice?: string; mark?: Mark } {
		const model = models.find(CLAUDE, id);
		if (!model || !models.isUsingOAuth(model)) return {};
		const reading = readClaude(now);
		if (!reading.ok)
			return { notice: `Could not read ${CLAUDE} quota: ${reading.reason}; launched without a proactive check.` };
		return { mark: claudeMark(reading, model, id, now) };
	}

	return {
		/** The last failed reading per provider. */
		errors: (): ReadingError[] => [...lastErrors.values()],
		clear: (): void => {
			cached = undefined;
		},
		recheck: (models: Registry, provider: string, id: string): Promise<string[]> =>
			recheckMarks({ readGo: read, readClaude, rechecked }, models, provider, id),
		/** Check `provider/id` against its quota: a `proactive` mark when a window is used up, or the fail-open `notice`. */
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
