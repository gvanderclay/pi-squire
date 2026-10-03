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
	hit: { provider: string; model: string; message: string; delegation: string },
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
		clearsAt: limit.resetAt ?? now + Math.min(FIRST_COOLDOWN * 2 ** (hits - 1), MAX_COOLDOWN),
		source: "reactive",
		hits,
		delegations: [...(old?.delegations ?? []), hit.delegation].slice(-MAX_DELEGATIONS),
	};
	writeMarks([...marks.filter((item) => item !== old), mark]);
}
