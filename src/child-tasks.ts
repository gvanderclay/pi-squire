// The direct parent's durable task facts and processing inbox. Not a tree
// index: the shared registry can publish these facts without owning answers.
import { join } from "node:path";
import {
	type AgentBeforeSettleEvent,
	type AgentBeforeSettleEventResult,
	type ContextEvent,
	type CustomMessageEntryDraft,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { readState, writeState } from "./local-state.ts";
import { isStarted, isV2Start, type Recorded } from "./result-types.ts";
import type { Inbound, MessageDetails } from "./results.ts";
import { locatedRecord } from "./tmux.ts";

export type ChildOutcome = {
	key: string;
	content: string;
	details: MessageDetails;
	/**
	 * This process asked Pi to write the outcome into the session. It records
	 * what was attempted, never what the transcript holds: a restart recomputes
	 * it from the restored branch.
	 */
	delivered?: boolean;
};

/** What a request message or a restored branch entry shows the presence check. */
type Carried = { role?: string; customType?: string; details?: unknown; toolName?: string };

/**
 * Whether one message already tells the model this outcome: its own delegate
 * message, or the `delegation_close` tool result that reported the close.
 */
function carries(message: Carried, details: MessageDetails): boolean {
	if (message.role === "custom") {
		const found = message.details as MessageDetails | undefined;
		return message.customType === "delegate" && found?.id === details.id && found.kind === details.kind;
	}
	if (details.kind !== "gone" || details.reason !== "explicit-close" || message.toolName !== "delegation_close")
		return false;
	const members = (message.details as { members?: { id?: string; closed?: boolean }[] } | undefined)?.members ?? [];
	return members.some((member) => member.id === details.id && member.closed === true);
}

/** The outcomes these messages carry; the session entry is the only carrier, never a request rewrite. */
function carried(outcomes: readonly ChildOutcome[], messages: readonly unknown[]): ChildOutcome[] {
	return outcomes.filter((outcome) => messages.some((message) => carries(message as Carried, outcome.details)));
}

/** A boundary draft that writes the whole outcome into the session. */
function outcomeDraft({ content, details }: ChildOutcome, display = true): CustomMessageEntryDraft {
	return { type: "custom_message", customType: "delegate", content, details, display };
}

/**
 * Settlement continuations one outcome may cause. Pi keeps only the last
 * handler's boundary entries, so an outcome another extension's entry drops
 * must not hold the run in the settle boundary forever; it stays pending.
 */
const MAX_SETTLE_CONTINUATIONS = 3;

/** A body-free request to process carried outcomes when the transcript ends on an assistant. */
function continuationNotice(coordinator: boolean): CustomMessageEntryDraft {
	return {
		type: "custom_message",
		customType: "delegate",
		content: coordinator
			? "[delegate] Child outcomes arrived after the last model request. Process them before your final task report."
			: "[delegate] Delegate outcomes arrived after the last model request. Process them before finishing this response.",
		display: true,
	};
}
type State = { records: Recorded[]; outcomes: ChildOutcome[]; checkReplies?: Inbound[]; paused?: boolean };
type StoredState = { version: 2; state: State };
/** Released readers require top-level arrays; this wrapper makes their restore/save fail closed. */
function childState(value: unknown): State | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object") throw new Error("invalid child task record");
	let state = value as Partial<State>;
	const versioned = "version" in value || "state" in value;
	if (versioned) {
		const wire = value as Partial<StoredState>;
		if (
			wire.version !== 2 ||
			!wire.state ||
			typeof wire.state !== "object" ||
			"records" in value ||
			"outcomes" in value
		)
			throw new Error("unsupported or malformed child task record version; reload a compatible Squire");
		state = wire.state;
	}
	if (!Array.isArray(state.records) || !Array.isArray(state.outcomes))
		throw new Error("invalid child task record: expected records and outcomes arrays");
	validateCheckReplies(state.checkReplies);
	if (state.paused !== undefined && typeof state.paused !== "boolean") throw new Error("invalid root stop state");
	if (
		versioned &&
		state.records.some((record) => !record || typeof record !== "object" || (isStarted(record) && !isV2Start(record)))
	)
		throw new Error("invalid v2 child task record; restoration blocked");
	return state as State;
}
function validateCheckReplies(replies: Inbound[] | undefined): void {
	if (replies === undefined) return;
	if (
		!Array.isArray(replies) ||
		replies.some(
			(payload) =>
				typeof payload?.envelope?.id !== "string" ||
				!Array.isArray(payload.envelope.in_reply_to) ||
				!Array.isArray(payload.requests),
		)
	)
		throw new Error("invalid pending delegate check replies");
}

export function readChildRecords(session: string): Recorded[] {
	const path = join(getAgentDir(), "squire", "child-tasks", `${encodeURIComponent(session)}.json`);
	const state = childState(readState<unknown>(path));
	return (state?.records ?? []).map((record) => (isStarted(record) ? locatedRecord(record) : record));
}
export class ChildTasks {
	path: string | undefined;
	outcomes: ChildOutcome[] = [];
	checkReplies = new Map<string, Inbound>();
	observed = new Set<string>();
	failed = false;
	unreadable = false;
	restoreFailure: string | undefined;
	paused = false;
	/** A run started after restore, so its own first request carries the saved outcomes. */
	ran = false;
	/** Settlement continuations asked for per outcome, bounded so a dropped carrier cannot loop. */
	continuations = new Map<string, number>();

	blockRestore(error: unknown): void {
		this.restoreFailure ??= String(error);
		this.failed = true;
	}

	/** Rebuild the inbox; `branch` is what the restored active transcript already carries. */
	restore(session: string, branch: readonly unknown[] = []): Recorded[] {
		this.path = join(getAgentDir(), "squire", "child-tasks", `${encodeURIComponent(session)}.json`);
		this.outcomes = [];
		this.checkReplies.clear();
		this.paused = false;
		this.observed.clear();
		this.ran = false;
		this.continuations.clear();
		this.failed = false;
		this.unreadable = false;
		this.restoreFailure = undefined;
		try {
			const state = childState(readState<unknown>(this.path));
			this.paused = state?.paused === true;
			this.outcomes = state?.outcomes ?? [];
			const shown = carried(this.outcomes, branch);
			for (const outcome of this.outcomes) outcome.delivered = shown.includes(outcome);
			for (const payload of state?.checkReplies ?? []) this.checkReplies.set(payload.envelope.id, payload);
			return (state?.records ?? []).map((record) => (isStarted(record) ? locatedRecord(record) : record));
		} catch (error) {
			this.failed = true;
			this.unreadable = true;
			throw error;
		}
	}

	save(records: Recorded[]): void {
		try {
			if (this.restoreFailure)
				throw new Error(`child task restoration failed: ${this.restoreFailure}; repair storage and reopen`);
			if (this.unreadable) throw new Error("child tasks were unreadable; repair storage and reload before continuing");
			if (!this.path) throw new Error("child task state has not been restored");
			writeState(this.path, {
				version: 2,
				state: {
					records,
					outcomes: this.outcomes,
					paused: this.paused,
					...(this.checkReplies.size ? { checkReplies: [...this.checkReplies.values()] } : {}),
				},
			} satisfies StoredState);
			this.failed = false;
		} catch (error) {
			this.failed = true;
			throw error;
		}
	}

	storageProblem(): string | undefined {
		if (this.unreadable) return "child tasks were unreadable; repair storage and reload before launching";
		if (this.restoreFailure)
			return `child task restoration failed: ${this.restoreFailure}; repair storage and reopen before launching`;
		if (this.failed) return "child task storage failed; repair storage and reload before launching";
		if (!this.path) return "child task storage has not been restored";
		return undefined;
	}

	delivered(key: string): void {
		for (const outcome of this.outcomes) if (outcome.key === key) outcome.delivered = true;
	}

	wakeAllowed(coordinator: boolean): boolean {
		return coordinator || !this.paused;
	}

	/** Ask Pi to write one outcome into the session; the transcript carries it, not a request. */
	publish(pi: ExtensionAPI, outcome: ChildOutcome): void {
		pi.sendMessage(
			{ customType: "delegate", content: outcome.content, details: outcome.details, display: true },
			{ triggerTurn: false },
		);
		outcome.delivered = true;
	}

	replay(pi: ExtensionAPI, coordinator: boolean): void {
		if (!this.wakeAllowed(coordinator) || this.ran || !this.outcomes.length) return;
		for (const outcome of this.outcomes) if (!outcome.delivered) this.publish(pi, outcome);
		pi.sendMessage(
			{
				customType: "delegate-recovery",
				display: false,
				content: "[delegate] Saved delegate outcomes still need processing. Continue with them before settling.",
			},
			{ triggerTurn: true, deliverAs: "steer" },
		);
	}

	/** Write every outcome this process has not published yet; a held root stays held. */
	publishMissing(pi: ExtensionAPI, coordinator: boolean): void {
		if (!this.wakeAllowed(coordinator)) return;
		for (const outcome of this.outcomes) if (!outcome.delivered) this.publish(pi, outcome);
	}

	settled(records: Recorded[], stopped: boolean): void {
		if (this.restoreFailure || this.unreadable) throw new Error(this.storageProblem());
		if (stopped) return;
		this.outcomes = this.outcomes.filter(({ key }) => !this.observed.has(key));
		this.observed.clear();
		this.continuations.clear();
		this.save(records);
	}

	/**
	 * Record which outcomes this request carries. It never changes the request:
	 * an outcome reaches the model only as a saved session message or tool
	 * result, so a request's prefix is the growing transcript itself.
	 */
	context(event: ContextEvent): undefined {
		this.mark(this.outcomes, event.messages, this.observed);
		return undefined;
	}

	/** Mark the outcomes these messages carry as written, and optionally as read by a request. */
	mark(outcomes: readonly ChildOutcome[], messages: readonly unknown[], read?: Set<string>): void {
		for (const outcome of carried(outcomes, messages)) {
			outcome.delivered = true;
			read?.add(outcome.key);
		}
	}

	/**
	 * Ask for one continuation request that carries every unread outcome, and
	 * draft what the projection no longer holds. Nothing is left to do once
	 * every outcome was read.
	 */
	settle(event: AgentBeforeSettleEvent, coordinator: boolean): AgentBeforeSettleEventResult | undefined {
		const shown = event.context?.contextMessages;
		if (shown !== undefined) this.mark(this.outcomes, shown);
		const pending = this.outcomes.filter(
			({ key }) => !this.observed.has(key) && (this.continuations.get(key) ?? 0) < MAX_SETTLE_CONTINUATIONS,
		);
		if (pending.length === 0) return undefined;
		for (const { key } of pending) this.continuations.set(key, (this.continuations.get(key) ?? 0) + 1);
		// A compacted or never-written outcome is written again, hidden when it
		// was displayed once before; an unrecognised projection writes what this
		// process has not written yet.
		const missing = pending.filter((outcome) =>
			shown === undefined ? !outcome.delivered : !carried([outcome], shown).length,
		);
		const entries = missing.map((outcome) => outcomeDraft(outcome, !outcome.delivered));
		for (const outcome of missing) outcome.delivered = true;
		// Ending on an assistant message leaves nothing runnable, so name the
		// work that forced another request instead.
		if (entries.length === 0 && event.context?.canContinue !== true) entries.push(continuationNotice(coordinator));
		return { continue: true, entries };
	}

	register(
		pi: ExtensionAPI,
		records: () => Recorded[],
		context: () => ExtensionContext | undefined,
		coordinator: () => boolean = () => false,
	): void {
		let stopped = false;
		pi.on("context", (event) => this.context(event));
		pi.on("before_agent_start", (event) => {
			this.ran = true;
			// A user prompt is the input that releases a stopped root's held outcomes.
			if (event.messageType === "user") this.paused = false;
			this.publishMissing(pi, coordinator());
		});
		pi.on("agent_end", (event, ctx) => {
			const last = event.messages.findLast((message) => message.role === "assistant");
			stopped = last?.stopReason === "aborted" || ctx.signal?.aborted === true;
			if (stopped && !coordinator()) {
				this.paused = true;
				try {
					this.save(records());
				} catch (error) {
					ctx.ui.notify(
						`delegate: could not persist root user stop: ${String(error)}; completion is blocked.`,
						"error",
					);
				}
			}
		});
		pi.on("agent_before_settle", (event) => {
			if (stopped || this.failed || !this.wakeAllowed(coordinator())) return;
			return this.settle(event, coordinator());
		});
		pi.on("agent_settled", () => {
			try {
				this.settled(records(), stopped);
			} catch (error) {
				context()?.ui.notify(
					`delegate: could not persist child-result processing: ${String(error)}; completion is blocked.`,
					"error",
				);
			}
		});
	}
}
