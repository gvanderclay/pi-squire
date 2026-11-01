// `/delegate-resume` with no arguments: pick one of the delegations a resume
// would accept, write the follow-up in the multi-line editor, then resume it
// the way the command does.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { recordedName, type StartedRecorded } from "./results.ts";

/** What the picker reads from the resume path in `index.ts`. */
export type ResumePickerDeps = {
	/** Why nothing can resume now (not inside tmux), or undefined. */
	unavailable(): string | undefined;
	/** The delegations a resume accepts now, newest first. */
	eligible(ctx: ExtensionContext): Promise<StartedRecorded[]>;
	/** Resume as the command does, notifying the start or the refusal. */
	resume(request: { id: string; task: string }, ctx: ExtensionContext): Promise<void>;
};

/** One picker line; the id prefix keeps two delegations with one name apart. */
const optionFor = (record: StartedRecorded): string =>
	`${recordedName(record)} · ${record.agent} · ${record.id.slice(0, 8)}`;

export async function pickResume(ctx: ExtensionContext, deps: ResumePickerDeps, id?: string): Promise<void> {
	const unavailable = deps.unavailable();
	if (unavailable !== undefined) {
		ctx.ui.notify(`delegate: ${unavailable}`, "error");
		return;
	}
	let records: StartedRecorded[];
	try {
		records = await deps.eligible(ctx);
	} catch (err) {
		ctx.ui.notify(`delegate: ${(err as Error).message}`, "error");
		return;
	}
	if (records.length === 0) {
		ctx.ui.notify("delegate: no delegation can be resumed now", "info");
		return;
	}
	const options = records.map(optionFor);
	const picked =
		id === undefined
			? await ctx.ui.select("Resume which delegation?", options)
			: options[records.findIndex((record) => record.id === id)];
	if (id !== undefined && picked === undefined) {
		ctx.ui.notify("delegate: selected delegation cannot be resumed now", "warning");
		return;
	}
	const record = records[options.indexOf(picked ?? "")];
	if (record === undefined) return;
	const task = await ctx.ui.editor(`Follow-up for ${recordedName(record)}`);
	if (task === undefined) return;
	if (task.trim() === "") {
		ctx.ui.notify("delegate: a task is required", "error");
		return;
	}
	await deps.resume({ id: record.id, task }, ctx);
}
