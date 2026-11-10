// Frozen executable v0.20.2 (c27b082d19662bdca37f5d4fb02e94b3037ed4ac) src/child-tasks.ts.
// Type annotations stripped; only import paths relocated. See README.md.
// The direct parent's durable task facts and processing inbox. Not a tree
// index: the shared registry can publish these facts without owning answers.
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readState, writeState } from "../../../src/local-state.ts";

export function readChildRecords(session) {
	const path = join(getAgentDir(), "squire", "child-tasks", `${encodeURIComponent(session)}.json`);
	const state = readState(path);
	if (state !== undefined && (!state || !Array.isArray(state.records) || !Array.isArray(state.outcomes)))
		throw new Error(`invalid child task record for ${session}`);
	return state?.records ?? [];
}
export class ChildTasks {
	path;
	outcomes = [];
	observed = new Set();
	failed = false;
	unreadable = false;
	restoreFailure;
	paused = false;

	blockRestore(error) {
		this.restoreFailure ??= String(error);
		this.failed = true;
	}

	restore(session) {
		this.path = join(getAgentDir(), "squire", "child-tasks", `${encodeURIComponent(session)}.json`);
		this.outcomes = [];
		this.paused = false;
		this.observed.clear();
		this.failed = false;
		this.unreadable = false;
		this.restoreFailure = undefined;
		try {
			const state = readState(this.path);
			if (state !== undefined && (!state || !Array.isArray(state.records) || !Array.isArray(state.outcomes)))
				throw new Error("invalid child task record: expected records and outcomes arrays");
			if (state?.paused !== undefined && typeof state.paused !== "boolean") throw new Error("invalid root stop state");
			this.paused = state?.paused === true;
			this.outcomes = state?.outcomes ?? [];
			return state?.records ?? [];
		} catch (error) {
			this.failed = true;
			this.unreadable = true;
			throw error;
		}
	}

	save(records) {
		try {
			if (this.restoreFailure)
				throw new Error(`child task restoration failed: ${this.restoreFailure}; repair storage and reopen`);
			if (this.unreadable) throw new Error("child tasks were unreadable; repair storage and reload before continuing");
			if (!this.path) throw new Error("child task state has not been restored");
			writeState(this.path, { records, outcomes: this.outcomes, paused: this.paused });
			this.failed = false;
		} catch (error) {
			this.failed = true;
			throw error;
		}
	}

	storageProblem() {
		if (this.unreadable) return "child tasks were unreadable; repair storage and reload before launching";
		if (this.restoreFailure)
			return `child task restoration failed: ${this.restoreFailure}; repair storage and reopen before launching`;
		if (this.failed) return "child task storage failed; repair storage and reload before launching";
		if (!this.path) return "child task storage has not been restored";
		return undefined;
	}

	delivered(key) {
		for (const outcome of this.outcomes) if (outcome.key === key) outcome.delivered = true;
	}

	wakeAllowed(coordinator) {
		return coordinator || !this.paused;
	}

	replay(pi, coordinator) {
		if (!this.wakeAllowed(coordinator)) return;
		let wake = false;
		for (const outcome of this.outcomes) {
			if (!coordinator && outcome.delivered) {
				wake = true;
				continue;
			}
			pi.sendMessage(
				{ customType: "delegate", content: outcome.content, details: outcome.details, display: true },
				{ triggerTurn: true, deliverAs: "steer" },
			);
			this.delivered(outcome.key);
		}
		if (wake)
			pi.sendMessage(
				{
					customType: "delegate-recovery",
					display: false,
					content: "[delegate] Saved delegate outcomes still need processing. Continue with them before settling.",
				},
				{ triggerTurn: true, deliverAs: "steer" },
			);
	}

	observe() {
		this.observed = new Set(this.outcomes.map(({ key }) => key));
	}

	settled(records, stopped) {
		if (this.restoreFailure || this.unreadable) throw new Error(this.storageProblem());
		if (stopped) return;
		this.outcomes = this.outcomes.filter(({ key }) => !this.observed.has(key));
		this.observed.clear();
		this.save(records);
	}

	needsProcessing() {
		return this.outcomes.some(({ key }) => !this.observed.has(key));
	}

	/** Each exact model request receives all unprocessed direct-child outcomes. */
	context(event) {
		this.paused = false;
		this.observe();
		const missing = this.outcomes.filter(
			({ details }) =>
				!event.messages.some(
					(message) =>
						message.role === "custom" &&
						message.customType === "delegate" &&
						message.details?.id === details.id &&
						message.details?.kind === details.kind,
				),
		);
		if (!missing.length) return;
		return {
			messages: [
				...event.messages,
				...missing.map(({ content, details }) => ({
					role: "custom",
					customType: "delegate",
					content,
					details,
					display: true,
					timestamp: Date.now(),
				})),
			],
		};
	}

	register(pi, records, context, coordinator = () => false) {
		let stopped = false;
		pi.on("context", (event) => this.context(event));
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
		pi.on("agent_before_settle", () => {
			if (stopped || this.failed || !this.wakeAllowed(coordinator()) || !this.needsProcessing()) return;
			// A bare continue can be rejected when the transcript ends with an
			// assistant. Supply runnable context; context() supplies the outcomes.
			return {
				continue: true,
				entries: [
					{
						type: "custom_message",
						customType: "delegate",
						content: coordinator()
							? "[delegate] Child outcomes arrived after the last model request. Process them before your final task report."
							: "[delegate] Delegate outcomes arrived after the last model request. Process them before finishing this response.",
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
