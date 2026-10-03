// Usage-limit marks: which providers and models are out of quota, kept in one
// JSON file in Pi's agent directory so every Pi session on the machine sees
// them. A delegate records a mark when its run ends on a usage-limit error;
// the parent refuses to launch on a marked model until the mark clears.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

const MINUTE = 60_000;
const HOUR: number = 60 * MINUTE;
const FIRST_COOLDOWN: number = 5 * MINUTE;
const MAX_COOLDOWN: number = 6 * HOUR;
/** An expired mark stays this long, only so the next hit escalates. */
const KEEP_EXPIRED: number = 24 * HOUR;
const MAX_REASON = 300;
const MAX_DELEGATIONS = 10;

export type Mark = {
	/** `provider` for a whole provider, `provider/model` for one model. */
	scope: string;
	reason: string;
	/** Epoch milliseconds. */
	recordedAt: number;
	/** Epoch milliseconds. */
	clearsAt: number;
	source: "reactive" | "proactive";
	hits: number;
	/** The last delegation ids that hit this mark. */
	delegations: string[];
};

/** The slice of Pi's model registry this module reads. */
export type Models = { find(provider: string, id: string): { cost?: { input?: number; output?: number } } | undefined };

export const limitsFile = (): string => join(getAgentDir(), "pi-squire-limits.json");

function isMark(value: unknown): value is Mark {
	const mark = value as Partial<Mark> | null;
	return (
		typeof mark === "object" &&
		mark !== null &&
		typeof mark.scope === "string" &&
		typeof mark.reason === "string" &&
		Number.isFinite(mark.recordedAt) &&
		Number.isFinite(mark.clearsAt) &&
		(mark.source === "reactive" || mark.source === "proactive") &&
		Number.isFinite(mark.hits) &&
		Array.isArray(mark.delegations)
	);
}

/** Every mark still worth keeping, active or recently expired. Never throws. */
export function readMarks(now = Date.now()): Mark[] {
	try {
		const parsed: unknown = JSON.parse(readFileSync(limitsFile(), "utf8"));
		return Array.isArray(parsed) ? parsed.filter(isMark).filter((mark) => mark.clearsAt + KEEP_EXPIRED > now) : [];
	} catch {
		return [];
	}
}

function writeMarks(marks: Mark[]): void {
	const file = limitsFile();
	mkdirSync(getAgentDir(), { recursive: true });
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, JSON.stringify(marks, null, 2));
	renameSync(temp, file);
}

/** Whether a model is free: an id ending in `-free`, or zero cost in the registry. */
export function isFree(models: Models, provider: string, id: string): boolean {
	if (id.endsWith("-free")) return true;
	const cost = models.find(provider, id)?.cost;
	return cost !== undefined && cost.input === 0 && cost.output === 0;
}

/** The active mark that covers provider/id, if any. A provider mark never covers a free model. */
export function activeMark(models: Models, provider: string, id: string, now = Date.now()): Mark | undefined {
	const active = readMarks(now).filter((mark) => mark.clearsAt > now);
	return (
		active.find((mark) => mark.scope === `${provider}/${id}`) ??
		(isFree(models, provider, id) ? undefined : active.find((mark) => mark.scope === provider))
	);
}

const LIMIT_PATTERN =
	/GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|insufficient_quota|quota exceeded|subscription_sharing_usage_limit_exceeded|usage_limit_reached|usage limit reached|rate_limit_error/i;

/** The reset time an error text states: "try again in N units", "retry after", or a `resets_at` field. */
function statedReset(message: string, now: number): number | undefined {
	const relative = /(?:try again in|retry after)\s+(\d+(?:\.\d+)?)\s*(second|minute|hour)s?/i.exec(message);
	if (relative !== null) {
		return (
			now + Number(relative[1]) * { second: 1000, minute: MINUTE, hour: HOUR }[relative[2].toLowerCase() as "second"]
		);
	}
	const text = /resets_?at\W{1,4}([0-9][0-9T:.+\-Z]*)/i.exec(message)?.[1];
	if (text === undefined) return undefined;
	return /^\d+(\.\d+)?$/.test(text) ? Number(text) * (Number(text) > 1e12 ? 1 : 1000) : Date.parse(text);
}

export type Response = { status: number; headers: Record<string, string> };

const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: MINUTE, h: HOUR };

/** A duration string such as `1s` or `6m0s`, in milliseconds. */
function duration(text: string): number | undefined {
	const parts = [...text.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)];
	return parts.length === 0 || parts.map((part) => part[0]).join("") !== text.trim()
		? undefined
		: parts.reduce((sum, part) => sum + Number(part[1]) * UNIT_MS[part[2]], 0);
}

/**
 * The reset time a failed response's headers state, if any, in the order
 * `retry-after`, `anthropic-ratelimit-*-reset`, `x-ratelimit-reset-*`. Only a
 * non-2xx response counts, and only a time in the future.
 */
export function headerReset(response: Response | undefined, now = Date.now()): number | undefined {
	if (response === undefined || (response.status >= 200 && response.status < 300)) return undefined;
	const headers = Object.entries(response.headers).map(([name, value]) => [name.toLowerCase(), String(value)] as const);
	const future = (times: (number | undefined)[]): number | undefined => {
		const found = times.filter((time): time is number => time !== undefined && time > now);
		return found.length === 0 ? undefined : Math.max(...found);
	};
	const retry = headers.find(([name]) => name === "retry-after")?.[1].trim();
	let retryTime: number | undefined;
	if (retry !== undefined) retryTime = /^\d+$/.test(retry) ? now + Number(retry) * 1000 : Date.parse(retry);
	const retryAt = future([retryTime]);
	if (retryAt !== undefined) return retryAt;
	const anthropic = future(
		headers.filter(([name]) => /^anthropic-ratelimit-.*-reset$/.test(name)).map(([, value]) => Date.parse(value)),
	);
	if (anthropic !== undefined) return anthropic;
	return future(
		headers
			.filter(([name]) => name === "x-ratelimit-reset-requests" || name === "x-ratelimit-reset-tokens")
			.map(([, value]) => {
				const ms = duration(value);
				return ms === undefined ? undefined : now + ms;
			}),
	);
}

/**
 * Whether an error message (Pi's `<status>: <body>`) is a usage limit, and
 * the reset time the text states, if any. Overloaded and 5xx errors never are.
 */
export function classify(message: string, now = Date.now()): { resetAt?: number } | undefined {
	if (/overloaded/i.test(message) || /^\s*5\d\d\b/.test(message)) return undefined;
	if (!LIMIT_PATTERN.test(message) && !/^\s*429\b/.test(message)) return undefined;
	const resetAt = statedReset(message, now);
	return resetAt !== undefined && resetAt > now ? { resetAt } : {};
}

/**
 * Record a reactive mark for a delegate's usage-limit failure. The scope is
 * the provider, or only the model for a free model or `FreeUsageLimitError`.
 */
export function recordLimit(
	models: Models,
	hit: { provider: string; model: string; message: string; delegation: string; response?: Response },
	now = Date.now(),
): void {
	const limit = classify(hit.message, now);
	if (limit === undefined) return;
	const single = isFree(models, hit.provider, hit.model) || /FreeUsageLimitError/i.test(hit.message);
	const scope = single ? `${hit.provider}/${hit.model}` : hit.provider;
	const marks = readMarks(now);
	const old = marks.find((mark) => mark.scope === scope);
	const hits = (old?.hits ?? 0) + 1;
	const mark: Mark = {
		scope,
		reason: hit.message.slice(0, MAX_REASON),
		recordedAt: now,
		clearsAt:
			headerReset(hit.response, now) ?? limit.resetAt ?? now + Math.min(FIRST_COOLDOWN * 2 ** (hits - 1), MAX_COOLDOWN),
		source: "reactive",
		hits,
		delegations: [...(old?.delegations ?? []), hit.delegation].slice(-MAX_DELEGATIONS),
	};
	writeMarks([...marks.filter((item) => item !== old), mark]);
}

/**
 * Record a proactive mark: a quota reading says `provider` is used up. It
 * clears at `clearsAt`, or after the escalating cooldown when none is known.
 * A failed write is swallowed; the mark is returned either way.
 */
export function recordProactive(
	provider: string,
	reason: string,
	clearsAt: number | undefined,
	now = Date.now(),
): Mark {
	const marks = readMarks(now);
	const old = marks.find((mark) => mark.scope === provider);
	const hits = (old?.hits ?? 0) + 1;
	const mark: Mark = {
		scope: provider,
		reason: reason.slice(0, MAX_REASON),
		recordedAt: now,
		clearsAt: clearsAt ?? now + Math.min(FIRST_COOLDOWN * 2 ** (hits - 1), MAX_COOLDOWN),
		source: "proactive",
		hits,
		delegations: old?.delegations ?? [],
	};
	try {
		writeMarks([...marks.filter((item) => item !== old), mark]);
	} catch {
		// The reading is real even if the file is not writable: the caller blocks on the returned mark.
	}
	return mark;
}

/**
 * Remove marks for `target`: `all`, a provider (its mark and every model mark
 * under it) or `provider/model` (that mark and the provider mark covering it).
 * Removing also forgets the escalation history. Returns the scopes of the
 * active marks removed; when none, the file is left alone.
 */
export function clearMarks(target: string, now = Date.now()): string[] {
	const marks = readMarks(now);
	const hit = (mark: Mark): boolean =>
		target === "all" ||
		mark.scope === target ||
		(target.includes("/") ? mark.scope === target.slice(0, target.indexOf("/")) : mark.scope.startsWith(`${target}/`));
	const cleared = marks.filter((mark) => hit(mark) && mark.clearsAt > now).map((mark) => mark.scope);
	if (cleared.length > 0) writeMarks(marks.filter((mark) => !hit(mark)));
	return cleared;
}

/** Remove the mark with exactly this scope, and with it the escalation history. False when it could not be written. */
export function removeMark(scope: string, now = Date.now()): boolean {
	try {
		writeMarks(readMarks(now).filter((mark) => mark.scope !== scope));
		return true;
	} catch {
		return false;
	}
}
