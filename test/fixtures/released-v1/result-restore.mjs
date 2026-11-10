// Frozen executable v0.20.2 (c27b082d19662bdca37f5d4fb02e94b3037ed4ac) src/result-restore.ts.
// Type annotations stripped; only import paths relocated. See README.md.
// Restore local semantic facts without trusting foreign transcript copies.
// Any incomplete authoritative read latches a failure until a fresh restore.

import { isStarted } from "../../../src/result-types.ts";

import { belongsTo, restoredStarts } from "./tree-view.mjs";

export function restoreRecords(ctx, tasks) {
	const byId = new Map();
	let local = [];
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
function accept(record, ctx, tasks, local) {
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
function transcript(ctx, tasks, byId) {
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== "delegate") continue;
		const data = entry.data;
		if (!data || typeof data.id !== "string") continue;
		if (data.kind === "workspace-attempt" || typeof data.requestId === "string") {
			restoreStart(data, ctx, tasks, byId);
		} else {
			applyTerminal(byId.get(data.id), data);
		}
	}
}
function restoreStart(record, ctx, tasks, byId) {
	const existing = byId.get(record.id);
	if (!isStarted(record) && existing && isStarted(existing)) return;
	if (accept(record, ctx, tasks, false)) byId.set(record.id, { ...record });
}
function applyTerminal(record, data) {
	if (!record || !isStarted(record)) return;
	if (typeof data.result?.replyId === "string") record.result = data.result;
	else if (data.closed === true) record.closed = true;
	else if (data.gone === true) {
		record.gone = true;
		if (typeof data.sessionPath === "string") record.sessionPath = data.sessionPath;
	}
}
function interrupt(records) {
	for (const record of records) {
		if (isStarted(record)) continue;
		const attempt = record;
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
