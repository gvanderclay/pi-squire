// Session model-call usage shared by settlement and live status; not provider quota.
import { readFileSync } from "node:fs";
import { Type } from "typebox";

type TokenCounts = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type SessionUsage = TokenCounts & { turns: number; cost?: number; contextTokens: number };

export const SessionUsageSchema = Type.Object({
	turns: Type.Integer({ minimum: 0 }),
	input: Type.Number({ minimum: 0 }),
	output: Type.Number({ minimum: 0 }),
	cacheRead: Type.Number({ minimum: 0 }),
	cacheWrite: Type.Number({ minimum: 0 }),
	cost: Type.Optional(Type.Number({ minimum: 0 })),
	contextTokens: Type.Number({ minimum: 0 }),
});

function nonnegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function tokenCounts(value: unknown): value is TokenCounts {
	if (!value || typeof value !== "object") return false;
	const counts = value as Partial<TokenCounts>;
	return [counts.input, counts.output, counts.cacheRead, counts.cacheWrite].every(nonnegative);
}

/** Optional in older records; malformed stored usage blocks restoration, never silently drops accounting. */
export function validateSessionUsage(value: unknown): void {
	if (value === undefined) return;
	if (!tokenCounts(value)) throw new Error("invalid delegation usage; restoration blocked");
	const usage = value as Partial<SessionUsage>;
	if (
		!Number.isInteger(usage.turns) ||
		!nonnegative(usage.turns) ||
		!nonnegative(usage.contextTokens) ||
		(usage.cost !== undefined && !nonnegative(usage.cost))
	)
		throw new Error("invalid delegation usage; restoration blocked");
}

type Billed = { usage: TokenCounts & { cost?: { total?: unknown } }; assistant: boolean; failed: boolean };
const USAGE_ENTRIES: ReadonlySet<unknown> = new Set(["usage", "compaction", "branch_summary"]);

/** Pi 1.5.0 docs/session-format.md: UsageEntry, CompactionEntry, BranchSummaryEntry;
 * docs/message-types.md: assistant usage and ToolResultMessage's separate nested model work.
 * Unknown standalone usage kinds still count. Never also count message.usage on another role.
 */
function billed(line: string): Billed | undefined {
	let entry: {
		type?: unknown;
		usage?: unknown;
		message?: { role?: unknown; usage?: unknown; stopReason?: unknown };
	};
	try {
		entry = JSON.parse(line);
	} catch {
		return undefined;
	}
	const assistant = entry?.type === "message" && entry.message?.role === "assistant";
	let usage: unknown;
	if (entry?.type === "message" && (assistant || entry.message?.role === "toolResult")) usage = entry.message?.usage;
	else if (USAGE_ENTRIES.has(entry?.type)) usage = entry?.usage;
	if (!tokenCounts(usage)) return undefined;
	const stop: unknown = entry.message?.stopReason;
	return { usage, assistant, failed: stop === "error" || stop === "aborted" };
}

/**
 * Whole-file sums across all branches measure spend, not active-branch context.
 * Turns count assistant messages with usable usage; context is the input plus
 * cache reads/writes, without output, of the last assistant request that
 * neither failed nor was aborted and reported tokens (zero if none exists).
 * Pi writes error and aborted messages with all-zero usage and skips them the
 * same way when it reads context (its compaction `getAssistantUsage`).
 * Missing files, malformed lines and files without billed usage give no report.
 */
export function sessionUsage(sessionPath: string | undefined): SessionUsage | undefined {
	if (sessionPath === undefined) return undefined;
	try {
		return readUsage(sessionPath);
	} catch {
		// Reporting must never lose an already claimed reply.
		return undefined;
	}
}

function readUsage(sessionPath: string): SessionUsage | undefined {
	const lines: string[] = readFileSync(sessionPath, "utf8").split("\n");
	let total: SessionUsage = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 };
	let counted = false;
	for (const line of lines) {
		const item = billed(line);
		if (item === undefined) continue;
		const { usage, assistant, failed } = item;
		const cost = usage.cost?.total;
		const context: number = usage.input + usage.cacheRead + usage.cacheWrite;
		const next: SessionUsage = {
			turns: total.turns + Number(assistant),
			input: total.input + usage.input,
			output: total.output + usage.output,
			cacheRead: total.cacheRead + usage.cacheRead,
			cacheWrite: total.cacheWrite + usage.cacheWrite,
			contextTokens: assistant && !failed && context > 0 ? context : total.contextTokens,
			...(total.cost !== undefined && nonnegative(cost) ? { cost: total.cost + cost } : {}),
		};
		if (!Object.values(next).every(nonnegative)) continue;
		total = next;
		counted = true;
	}
	return counted ? total : undefined;
}

function tokens(count: number): string {
	const whole: number = Math.round(count);
	// 999,950 and up would print as "1000k": it rounds to a million.
	if (whole >= 999_950) return `${Number((whole / 1_000_000).toFixed(1))}M`;
	if (whole >= 1000) return `${Number((whole / 1000).toFixed(1))}k`;
	return String(whole);
}

/** A known cost; under half a cent reads `<$0.01`, so it is not mistaken for free. */
function dollars(cost: number): string {
	return cost > 0 && cost < 0.005 ? "<$0.01" : `$${cost.toFixed(2)}`;
}

/**
 * Shared wording, without a heading, for result headers, full status blocks and expanded results.
 * `earlier` marks a resumed or forked delegation, whose session file also holds the work before it.
 */
export function usageText(usage: SessionUsage, earlier = false): string {
	const input = tokens(usage.input + usage.cacheRead + usage.cacheWrite);
	const cost = usage.cost === undefined ? "" : `, ${dollars(usage.cost)}`;
	const scope = earlier ? " Counts the whole session, including work before this delegation." : "";
	return `${usage.turns} turn${usage.turns === 1 ? "" : "s"}, ${input} tokens in (${tokens(usage.cacheRead)} cached), ${tokens(usage.output)} out${cost}; context at finish ${tokens(usage.contextTokens)}.${scope}`;
}
