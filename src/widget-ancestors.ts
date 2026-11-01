// Read-only exact-session ancestry and live navigation. No adoption or resume.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Identity, readIdentity } from "./identity.ts";
import { locateSession, recordedName } from "./results.ts";
import { matchesSessionOwner, sessionIsOwned } from "./session-owner.ts";
import type { PaneLocator, TmuxClient } from "./tmux.ts";
import { readTree, type TreeEntry } from "./tree-registry.ts";
import { LiveActivityReader, type LiveLocator } from "./widget-live.ts";
import { WidgetTitleMirrors } from "./widget-title.ts";
import { WidgetTitleFiles } from "./widget-title-file.ts";
import { listWindows } from "./windows.ts";

export type AncestorRow = { key: string; sessionId: string; identity: string; parent: boolean; title?: string };
type Ancestor = { sessionId: string; identity?: Identity };

/** Durable parent ids only. A broken/cyclic chain refuses rather than inventing ancestry. */
export function ancestorSessions(ctx: ExtensionContext): Ancestor[] {
	const session: string = ctx.sessionManager.getSessionId();
	const own: Identity | undefined = readIdentity(session);
	if (!own) return [];
	const found: Ancestor[] = [];
	const seen: Set<string> = new Set([session]);
	let child: Identity = own;
	for (let depth: number = own.depth; depth > 0; depth--) {
		const id: string = child.parent;
		if (seen.has(id)) throw new Error("invalid ancestor identity chain");
		seen.add(id);
		if (id === own.root) {
			if (depth !== 1) throw new Error("incomplete ancestor identity chain");
			found.push({ sessionId: id });
			return found.reverse();
		}
		const identity: Identity | undefined = readIdentity(id);
		if (
			!identity ||
			identity.root !== own.root ||
			identity.depth !== depth - 1 ||
			identity.rootPlacement !== own.rootPlacement
		)
			throw new Error("ancestor identity unavailable");
		found.push({ sessionId: id, identity });
		child = identity;
	}
	throw new Error("ancestor identity chain does not reach root");
}

export class AncestorView {
	private readonly titles: WidgetTitleFiles = new WidgetTitleFiles();
	private readonly mirrors: WidgetTitleMirrors = new WidgetTitleMirrors();

	clear(): void {
		this.titles.clear();
		this.mirrors.clear();
	}

	async read(ctx: ExtensionContext, reader: LiveActivityReader): Promise<AncestorRow[]> {
		const ancestors: Ancestor[] = ancestorSessions(ctx);
		let entries: TreeEntry[] = [];
		try {
			if (ancestors.length) entries = readTree(ancestors[0].sessionId, 20).entries;
		} catch {
			/* labels optional */
		}
		return Promise.all(
			ancestors.map(async (ancestor: Ancestor, index: number): Promise<AncestorRow> => {
				const entry: TreeEntry | undefined = entries.findLast((item) => item.sessionId === ancestor.sessionId);
				const live: LiveLocator | undefined = await reader.locator(ancestor.sessionId);
				const path: string | undefined =
					live?.sessionFile ?? (entry?.launch ? locateSession(entry.launch, undefined) : undefined);
				const name: string | undefined =
					this.titles.read(path, ancestor.sessionId)?.name ?? this.mirrors.read(ancestor.sessionId);
				let label = "root";
				if (ancestor.identity) label = entry?.launch ? recordedName(entry.launch) : ancestor.identity.agent;
				return {
					key: `ancestor:${ancestor.sessionId}`,
					sessionId: ancestor.sessionId,
					identity: label,
					parent: index === ancestors.length - 1,
					title: name,
				};
			}),
		);
	}
}

function sameServer(a: PaneLocator, b: PaneLocator): boolean {
	return a.socket === b.socket && a.serverPid === b.serverPid && a.serverStarted === b.serverStarted;
}
function sameTarget(a: LiveLocator, b: LiveLocator): boolean {
	return (
		a.generation === b.generation &&
		a.ownerToken === b.ownerToken &&
		JSON.stringify(a.locator) === JSON.stringify(b.locator)
	);
}

/** Positive own-server + exact target-pane + id/name listing, not a launch snapshot. */
export async function verifyLiveWindow(tmux: TmuxClient, live: LiveLocator): Promise<boolean> {
	const own: PaneLocator | undefined = await tmux.inspectPane?.();
	if (!own || !sameServer(own, live.locator)) return false;
	const pane: PaneLocator | undefined = await tmux.inspectPane?.(live.locator.paneId);
	if (
		!pane ||
		pane.exited ||
		!sameServer(pane, live.locator) ||
		pane.windowId !== live.locator.windowId ||
		pane.windowName !== live.locator.windowName
	)
		return false;
	const windows = await listWindows(tmux);
	return !!windows?.some((window) => window.id === pane.windowId && window.name === pane.windowName);
}

export async function switchAncestor(
	ctx: ExtensionContext,
	sessionId: string,
	tmux: TmuxClient,
	assertActive: () => void,
	reader: LiveActivityReader = new LiveActivityReader(),
): Promise<void> {
	assertActive();
	if (!ancestorSessions(ctx).some((ancestor) => ancestor.sessionId === sessionId))
		throw new Error("target is not a current ancestor");
	const live: LiveLocator | undefined = await reader.locator(sessionId);
	if (!live || !(await verifyLiveWindow(tmux, live))) throw new Error("no verified live window for this ancestor");
	assertActive();
	const own = await tmux.ownSession();
	const client: string | undefined = own ? await tmux.clientFor(own.name) : undefined;
	if (!client) throw new Error("no tmux client attached to this session");
	const current: LiveLocator | undefined = await reader.locator(sessionId);
	assertActive();
	if (!current || !sameTarget(live, current) || !(await verifyLiveWindow(tmux, current)))
		throw new Error("ancestor window changed or is unavailable");
	assertActive();
	if (!ancestorSessions(ctx).some((ancestor) => ancestor.sessionId === sessionId))
		throw new Error("ancestor identity changed");
	if (!matchesSessionOwner(sessionId, current.pid, current.ownerToken) || !sessionIsOwned(sessionId))
		throw new Error("ancestor owner changed or is unavailable");
	await tmux.switchTo(client, current.locator.windowId);
	assertActive();
	ctx.ui.notify(`delegate: switched to ancestor ${sessionId} (${current.locator.windowId})`, "info");
}
