// The direct parent's durable task facts and processing inbox. Not a tree
// index: the shared registry can publish these facts without owning answers.
import { join } from "node:path";
import {
	type ContextEvent,
	type ContextEventResult,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { readState, writeState } from "./local-state.ts";
import type { Recorded } from "./result-types.ts";
import type { MessageDetails } from "./results.ts";

export type ChildOutcome = {
	key: string;
	content: string;
	details: MessageDetails;
};
type State = { records: Recorded[]; outcomes: ChildOutcome[] };
export function readChildRecords(session: string): Recorded[] {
	const path = join(getAgentDir(), "squire", "child-tasks", `${encodeURIComponent(session)}.json`);
	const state = readState<State>(path);
	if (state !== undefined && (!state || !Array.isArray(state.records) || !Array.isArray(state.outcomes)))
		throw new Error(`invalid child task record for ${session}`);
	return state?.records ?? [];
}
export class ChildTasks {
	path: string | undefined;
	outcomes: ChildOutcome[] = [];
	observed = new Set<string>();
	failed = false;
	unreadable = false;

	restore(session: string): Recorded[] {
		this.path = join(getAgentDir(), "squire", "child-tasks", `${encodeURIComponent(session)}.json`);
		this.outcomes = [];
		this.observed.clear();
		this.failed = false;
		this.unreadable = false;
		try {
			const state = readState<State>(this.path);
			if (state !== undefined && (!state || !Array.isArray(state.records) || !Array.isArray(state.outcomes)))
				throw new Error("invalid child task record: expected records and outcomes arrays");
			this.outcomes = state?.outcomes ?? [];
			return state?.records ?? [];
		} catch (error) {
			this.failed = true;
			this.unreadable = true;
			throw error;
		}
	}

	save(records: Recorded[]): void {
		try {
			if (this.unreadable) throw new Error("child tasks were unreadable; repair storage and reload before continuing");
			if (!this.path) throw new Error("child task state has not been restored");
			writeState(this.path, { records, outcomes: this.outcomes } satisfies State);
			this.failed = false;
		} catch (error) {
			this.failed = true;
			throw error;
		}
	}

	storageProblem(): string | undefined {
		if (this.unreadable) return "child tasks were unreadable; repair storage and reload before launching";
		if (this.failed) return "child task storage failed; repair storage and reload before launching";
		if (!this.path) return "child task storage has not been restored";
		return undefined;
	}

	observe(): void {
		this.observed = new Set(this.outcomes.map(({ key }) => key));
	}

	settled(records: Recorded[], stopped: boolean): void {
		if (stopped) return;
		this.outcomes = this.outcomes.filter(({ key }) => !this.observed.has(key));
		this.observed.clear();
		this.save(records);
	}

	needsProcessing(): boolean {
		return this.outcomes.some(({ key }) => !this.observed.has(key));
	}

	/** Each exact model request receives all unprocessed direct-child outcomes. */
	context(event: ContextEvent): ContextEventResult | undefined {
		this.observe();
		const missing = this.outcomes.filter(
			({ details }) =>
				!event.messages.some(
					(message) =>
						message.role === "custom" &&
						message.customType === "delegate" &&
						(message.details as MessageDetails | undefined)?.id === details.id &&
						(message.details as MessageDetails | undefined)?.kind === details.kind,
				),
		);
		if (!missing.length) return;
		return {
			messages: [
				...event.messages,
				...missing.map(({ content, details }) => ({
					role: "custom" as const,
					customType: "delegate",
					content,
					details,
					display: true,
					timestamp: Date.now(),
				})),
			],
		};
	}

	register(pi: ExtensionAPI, records: () => Recorded[], context: () => ExtensionContext | undefined): void {
		let stopped = false;
		pi.on("context", (event) => this.context(event));
		pi.on("agent_end", (event, ctx) => {
			const last = event.messages.findLast((message) => message.role === "assistant");
			stopped = last?.stopReason === "aborted" || ctx.signal?.aborted === true;
		});
		pi.on("agent_before_settle", () => {
			if (stopped || this.failed || !this.needsProcessing()) return;
			// A bare continue can be rejected when the transcript ends with an
			// assistant. Supply runnable context; context() supplies the outcomes.
			return {
				continue: true,
				entries: [
					{
						type: "custom_message",
						customType: "delegate",
						content:
							"[delegate] Child outcomes arrived after the last model request. Process them before your final task report.",
						display: true,
					},
				],
			};
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
