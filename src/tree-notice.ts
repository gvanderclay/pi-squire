// Bounded discovery is a notice only. Exact-session restore never uses this budget.
import { statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findSession } from "./result-sessions.ts";
import { ownerDetails, sessionIsOwned } from "./session-owner.ts";
import type { TmuxClient, TmuxWindow } from "./tmux.ts";
import { listTreeRoots, readTree, type TreeEntry, treePath } from "./tree-registry.ts";
import { listWindows } from "./windows.ts";

export const NOTICE_TREES = 64;
export const NOTICE_OWNERS = 10;
export const NOTICE_MS = 200;
export async function treeNotice(
	ctx: ExtensionContext,
	tmux: TmuxClient,
	active: () => boolean = () => true,
): Promise<void> {
	const deadline: number = performance.now() + NOTICE_MS;
	const session: string = ctx.sessionManager.getSessionId();
	const dir: string = ctx.sessionManager.getSessionDir();
	const roots: string[] = listTreeRoots().filter((root) => root !== session);
	const newest: string[] = roots.sort((a, b) => modified(b) - modified(a)).slice(0, NOTICE_TREES);
	if (!newest.length) return;
	const windows: TmuxWindow[] | undefined = await noticeWindows(tmux, deadline);
	if (!active()) return;
	if (!windows) {
		ctx.ui.notify(
			"delegate: owner discovery unavailable: tmux could not be asked within the total notice budget; no absence or ownership was inferred.",
			"warning",
		);
		return;
	}
	const owners: Map<string, TreeEntry> = new Map();
	let unavailable = 0,
		scanned = 0,
		ownerErrors = 0;
	for (const root of newest) {
		if (!active() || remaining(deadline) <= 0 || owners.size >= NOTICE_OWNERS) break;
		try {
			collectOwners(root, session, dir, windows, owners, deadline);
		} catch {
			unavailable++;
		}
		scanned++;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	if (!active()) return;
	ownerErrors = reportOwners(ctx, dir, owners, deadline);
	if (roots.length > NOTICE_TREES || scanned < newest.length || unavailable || ownerErrors)
		ctx.ui.notify(
			`delegate: discovery is limited to newest ${NOTICE_TREES} trees and ${NOTICE_OWNERS} owners in this agent/session directory, with a ${NOTICE_MS} ms total budget and 1 MiB per tree; ${unavailable} registries unavailable and ${ownerErrors} owner records unreadable. Reopen an exact owner to restore its full tree.`,
			"warning",
		);
}
function reportOwners(ctx: ExtensionContext, dir: string, owners: Map<string, TreeEntry>, deadline: number): number {
	let ownerErrors = 0;
	for (const [parent, entry] of [...owners].slice(0, NOTICE_OWNERS)) {
		const path: string | undefined = remaining(deadline) > 0 ? findSession(dir, parent) : undefined;
		let action: string;
		try {
			action = sessionIsOwned(parent)
				? "Its Squire owner is already open; return to that process."
				: `Reopen the owning Pi session with pi --session ${shellArg(path ?? parent)} --session-dir ${shellArg(dir)}.`;
		} catch {
			ownerErrors++;
			action = `Owner status is unavailable: ${ownerDetails(parent)}. Inspect it before reopening.`;
		}
		ctx.ui.notify(
			`delegate: earlier session ${parent} has running delegates (tree ${entry.identity.root}). ${action} This session does not adopt them.`,
			"info",
		);
	}
	return ownerErrors;
}
async function noticeWindows(tmux: TmuxClient, deadline: number): Promise<TmuxWindow[] | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			listWindows(tmux),
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), remaining(deadline));
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
function remaining(deadline: number): number {
	return Math.max(0, deadline - performance.now());
}
function collectOwners(
	root: string,
	session: string,
	dir: string,
	windows: TmuxWindow[],
	owners: Map<string, TreeEntry>,
	deadline: number,
): void {
	if (statSync(treePath(root)).size > 1024 * 1024) throw new Error("tree exceeds notice byte budget");
	for (const entry of readTree(root, Math.min(20, remaining(deadline))).entries) {
		if (owners.size >= NOTICE_OWNERS || remaining(deadline) <= 0) return;
		if (entry.identity.parent !== session && entry.sessionDir === dir && live(entry, windows))
			owners.set(entry.identity.parent, entry);
	}
}
function shellArg(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}
function modified(root: string): number {
	try {
		return statSync(treePath(root)).mtimeMs;
	} catch {
		return 0;
	}
}
function live(entry: TreeEntry, windows: TmuxWindow[]): boolean {
	return (
		entry.phase === "started" &&
		!entry.finished &&
		!entry.closed &&
		windows.some((window) => window.id === entry.windowId && window.name === entry.windowName && !window.exited)
	);
}
