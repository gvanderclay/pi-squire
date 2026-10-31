import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { settleTask, type TaskEnd, type TaskReply, type TaskState, taskEnd } from "./task-settlement.ts";
import { readTaskState, taskStatePath, writeTaskState } from "./task-store.ts";

type Inbound = {
	envelope?: { id?: unknown; from?: unknown; kind?: unknown; body?: unknown };
	handled?: boolean;
};
type ReplyPayload = {
	to: string;
	inReplyTo: string[];
	body: string;
	status: TaskReply["status"];
	envelope?: unknown;
	error?: string;
};
export type TaskReplies = { handled(): boolean };

const STARTUP_RETRIES = 2;
const STARTUP_RETRY_MS = 100;

class Answers {
	readonly pi: ExtensionAPI;
	readonly parent: string | undefined;
	state: TaskState | undefined;
	path: string | undefined;
	current: ExtensionContext | undefined;
	end: TaskEnd | undefined;
	failed = false;
	unreadable = false;
	retry: ReturnType<typeof setImmediate> | undefined;
	startupRetry: ReturnType<typeof setTimeout> | undefined;

	constructor(pi: ExtensionAPI, parent?: string) {
		this.pi = pi;
		this.parent = parent;
	}

	warn(error: unknown, advice?: string): void {
		this.failed = true;
		const retained: string = this.state?.outbox.length
			? "The answer is retained"
			: "Task reply handling did not complete";
		const recovery: string = advice ?? `${retained}; retry on reload/reopen or the next settled run.`;
		this.current?.ui.notify(
			`delegate: could not handle the task reply: ${String(error)}. ${recovery} Auto-exit is blocked.`,
			"error",
		);
	}

	save(next: TaskState): void {
		if (this.path === undefined) throw new Error("no task reply state path");
		writeTaskState(this.path, next);
		this.state = next;
	}

	flush(startupRetries = 0): void {
		if (this.startupRetry !== undefined) clearTimeout(this.startupRetry);
		this.startupRetry = undefined;
		if (this.state === undefined) return;
		try {
			while (this.state.outbox.length > 0) {
				const reply: TaskReply = this.state.outbox[0] as TaskReply;
				const payload: ReplyPayload = {
					to: this.state.parent,
					inReplyTo: reply.ids,
					body: reply.body,
					status: reply.status,
				};
				this.pi.events.emit("message:reply", payload);
				if (payload.error !== undefined || payload.envelope === undefined)
					throw new Error(payload.error ?? "no message:reply provider installed");
				// A crash here may resend. Parent correlation suppresses repeated finals.
				const sent: Set<string> = new Set(reply.ids);
				this.save({
					...this.state,
					requests: this.state.requests.filter((request) => !sent.has(request.id)),
					outbox: this.state.outbox.slice(1),
				});
			}
			this.failed = false;
		} catch (error) {
			this.failed = true;
			if (startupRetries === 0) this.warn(error);
			else this.startupRetry = setTimeout(() => this.flush(startupRetries - 1), STARTUP_RETRY_MS).unref();
		}
	}

	start(ctx: ExtensionContext): void {
		this.current = ctx;
		this.path = taskStatePath(ctx.sessionManager.getSessionId());
		this.end = undefined;
		this.failed = false;
		this.unreadable = false;
		try {
			this.state = readTaskState(this.path);
		} catch (error) {
			this.state = undefined;
			this.unreadable = true;
			this.warn(error);
		}
		if (!this.state?.outbox.length) return;
		// Async session_start handlers between squire and mail can delay provider
		// initialization past this turn. Retry actual replies briefly, not probes.
		this.retry = setImmediate(() => {
			this.retry = undefined;
			this.flush(STARTUP_RETRIES);
		});
	}

	stop(): void {
		if (this.retry !== undefined) clearImmediate(this.retry);
		this.retry = undefined;
		if (this.startupRetry !== undefined) clearTimeout(this.startupRetry);
		this.startupRetry = undefined;
		this.current = undefined;
	}

	takeover(payload: Inbound): void {
		const envelope: Inbound["envelope"] = payload?.envelope;
		const owner: string | undefined = this.state?.parent ?? this.parent;
		if (
			this.unreadable ||
			this.current === undefined ||
			payload.handled ||
			envelope?.kind !== "request" ||
			!owner ||
			envelope.from !== owner ||
			typeof envelope.id !== "string" ||
			envelope.id === ""
		)
			return;
		try {
			const base: TaskState = this.state ?? { parent: owner, requests: [], outbox: [] };
			if (base.requests.some((request) => request.id === envelope.id)) {
				payload.handled = true;
				return;
			}
			this.save({ ...base, requests: [...base.requests, { id: envelope.id, held: false, seen: true }] });
			payload.handled = true;
			const text: string = `[delegate] Your task, from the session that started you (${owner}). Your final message this turn goes back to it automatically.\n\n${String(envelope.body ?? "")}`;
			this.prompt(text, envelope.id);
		} catch (error) {
			this.warn(
				error,
				"Task ownership was not recorded and squire did not start the task; fix the storage error and send it again.",
			);
		}
	}

	prompt(text: string, id: string): void {
		const rejected = (error: unknown): void => {
			this.unseen(id);
			this.current?.ui.notify(`delegate: could not start the task: ${String(error)}`, "error");
		};
		try {
			Promise.resolve(this.pi.sendUserMessage(text, { deliverAs: "steer" })).catch(rejected);
		} catch (error) {
			rejected(error);
		}
	}

	unseen(id: unknown): void {
		if (this.state === undefined) return;
		try {
			this.save({
				...this.state,
				requests: this.state.requests.map((request) => (request.id === id ? { ...request, seen: false } : request)),
			});
		} catch (error) {
			this.warn(error);
		}
	}

	settle(): void {
		if (this.state === undefined || this.end === undefined) return;
		try {
			this.save(settleTask(this.state, this.end));
			this.end = undefined;
			this.flush();
		} catch (error) {
			this.warn(error);
		}
	}

	handled(): boolean {
		return !this.failed && (this.state === undefined || this.state.requests.length === 0);
	}
}

/** Restore owed answers even when a session is reopened without launch env. */
export function registerTaskReplies(pi: ExtensionAPI, parent?: string): TaskReplies {
	const answers: Answers = new Answers(pi, parent);
	pi.on("session_start", (_event, ctx) => answers.start(ctx));
	pi.on("session_shutdown", () => answers.stop());
	pi.events.on("message:inbound", (data) => answers.takeover(data as Inbound));
	pi.on("agent_end", (event, ctx) => {
		answers.end = taskEnd(event.messages, ctx.signal?.aborted === true);
	});
	pi.on("agent_settled", () => answers.settle());
	return answers;
}
