// Restore local semantic facts without trusting foreign transcript copies.
// Any incomplete authoritative read latches a failure until a fresh restore.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChildTasks } from "./child-tasks.ts";
import { isStarted, type Recorded, type WorkspaceAttempt } from "./result-types.ts";
import type { Delegation, Result } from "./results.ts";
import { belongsTo, restoredStarts } from "./tree-view.ts";

export function restoreRecords(ctx: ExtensionContext, tasks: ChildTasks): Recorded[] {
	const byId: Map<string, Recorded> = new Map();
	let local: Recorded[] = [];
	try {
		local = tasks.restore(ctx.sessionManager.getSessionId());
	} catch (error) {
		tasks.blockRestore(error);
	}
	try {
		transcript(ctx, tasks, byId);
	} catch (error) {
		tasks.blockRestore(error);
	}
	try {
		for (const record of local) if (accept(record, ctx, tasks, true)) byId.set(record.id, record);
	} catch (error) {
		tasks.blockRestore(error);
	}
	try {
		for (const record of restoredStarts(ctx))
			if (!byId.has(record.id) && accept(record, ctx, tasks, false)) byId.set(record.id, record);
	} catch (error) {
		ctx.ui.notify(`delegate: shared launch recovery unavailable: ${String(error)}`, "warning");
	}
	try {
		interrupt([...byId.values()]);
	} catch (error) {
		tasks.blockRestore(error);
	}
	return [...byId.values()];
}
function accept(record: Recorded, ctx: ExtensionContext, tasks: ChildTasks, local: boolean): boolean {
	try {
		return belongsTo(record, ctx);
	} catch (error) {
		tasks.blockRestore(error);
		// Keep known own obligations while blocked, never make a foreign copy local.
		if (!isStarted(record)) return record.parentId === ctx.sessionManager.getSessionId();
		if (record.identity) return record.identity.parent === ctx.sessionManager.getSessionId();
		return local;
	}
}
function transcript(ctx: ExtensionContext, tasks: ChildTasks, byId: Map<string, Recorded>): void {
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== "delegate") continue;
		const data = entry.data as
			| Partial<Delegation & { kind: string; result: Result; closed: boolean; gone: boolean }>
			| undefined;
		if (!data || typeof data.id !== "string") continue;
		if (data.kind === "workspace-attempt" || typeof data.requestId === "string") {
			restoreStart(data as Recorded, ctx, tasks, byId);
		} else {
			applyTerminal(byId.get(data.id), data);
		}
	}
}
function restoreStart(record: Recorded, ctx: ExtensionContext, tasks: ChildTasks, byId: Map<string, Recorded>): void {
	const existing: Recorded | undefined = byId.get(record.id);
	if (!isStarted(record) && existing && isStarted(existing)) return;
	if (accept(record, ctx, tasks, false)) byId.set(record.id, { ...record });
}
function applyTerminal(
	record: Recorded | undefined,
	data: Partial<Delegation & { result: Result; closed: boolean; gone: boolean }>,
): void {
	if (!record || !isStarted(record)) return;
	if (typeof data.result?.replyId === "string") record.result = data.result;
	else if (data.closed === true) record.closed = true;
	else if (data.gone === true) {
		record.gone = true;
		if (typeof data.sessionPath === "string") record.sessionPath = data.sessionPath;
	}
}
function interrupt(records: Recorded[]): void {
	for (const record of records) {
		if (isStarted(record)) continue;
		const attempt: WorkspaceAttempt = record;
		const { phase, resources } = attempt.attempt;
		if (phase === "planned" || phase === "created")
			attempt.attempt = {
				phase: "interrupted",
				resources,
				lastPhase: phase,
				reason: `the parent session ended while the launch was ${phase}; whether anything was created is unknown`,
			};
	}
}
