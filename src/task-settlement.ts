// Request settlement belongs to squire; asks remain the mail provider's work.
// Wording and held-through-failure semantics follow pi-session-mail v0.5.0.
export const NO_ANSWER = "(The session settled with no answer text.)";
export const TOOK_OVER =
	"(The user stopped an earlier run partway and took over; the answer that follows is from the run that completed after that.)";
export const UNSEEN =
	"(The session was stopped before it read the message. Nothing was done; send it again if it is still needed.)";

export type TaskRequest = { id: string; held: boolean; seen: boolean };
export type TaskReply = { ids: string[]; body: string; status: "done" | "failed" | "stopped" };
export type TaskState = { parent: string; requests: TaskRequest[]; outbox: TaskReply[] };
type Message = { role?: string; content?: unknown; stopReason?: unknown; errorMessage?: unknown };
export type TaskEnd = { stopped: boolean; error?: string; answer?: string };

function textOf(message: Message): string | undefined {
	const content = message.content;
	let text = "";
	if (typeof content === "string") text = content;
	else if (Array.isArray(content))
		text = content
			.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
			.map((part) => part.text)
			.join("\n");
	return text.trim() === "" ? undefined : text;
}

export function taskEnd(messages: readonly unknown[], aborted: boolean): TaskEnd {
	const assistants: Message[] = (messages as Message[]).filter((message) => message?.role === "assistant");
	const last: Message | undefined = assistants.at(-1);
	const stopped: boolean = aborted || last?.stopReason === "aborted";
	let error: string | undefined;
	if (!stopped && last?.stopReason === "error")
		error =
			typeof last.errorMessage === "string" && last.errorMessage.trim() !== ""
				? last.errorMessage.trim().replace(/\.+$/, "")
				: "unknown error";
	const answer: string | undefined =
		stopped || error !== undefined
			? assistants.map(textOf).findLast((text) => text !== undefined)
			: last && textOf(last);
	return { stopped, error, answer };
}

/** Freeze the final body before transport, batching at the provider's 50-id limit. */
export function settleTask(state: TaskState, end: TaskEnd): TaskState {
	const requests: TaskRequest[] = [];
	const groups: Map<string, TaskReply> = new Map();
	const queued: Set<string> = new Set(state.outbox.flatMap((reply) => reply.ids));
	for (const request of state.requests) {
		if (queued.has(request.id)) {
			requests.push(request);
			continue;
		}
		if (request.seen && (end.stopped || (request.held && end.error !== undefined))) {
			requests.push({ ...request, held: true });
			continue;
		}
		const reply: TaskReply = describe(request, end);
		const key: string = JSON.stringify([reply.status, reply.body]);
		const group: TaskReply = groups.get(key) ?? { ...reply, ids: [] };
		group.ids.push(request.id);
		groups.set(key, group);
		requests.push(request);
	}
	const outbox: TaskReply[] = [...state.outbox];
	for (const group of groups.values())
		for (let start = 0; start < group.ids.length; start += 50)
			outbox.push({ ...group, ids: group.ids.slice(start, start + 50) });
	return { ...state, requests, outbox };
}

function describe(request: TaskRequest, end: TaskEnd): TaskReply {
	const ids: string[] = [request.id];
	if (!request.seen) return { ids, body: UNSEEN, status: "failed" };
	if (request.held) return { ids, body: `${TOOK_OVER}\n\n${end.answer ?? NO_ANSWER}`, status: "done" };
	if (end.error !== undefined) {
		const opening: string = `(The run ended on an error before it finished: ${end.error}. The text that follows, if any, is partial.)`;
		return { ids, body: opening + (end.answer === undefined ? "" : `\n\n${end.answer}`), status: "failed" };
	}
	return { ids, body: end.answer ?? NO_ANSWER, status: "done" };
}
