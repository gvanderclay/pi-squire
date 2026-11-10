// Read-only exact-session ancestry and live navigation. No adoption or resume.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sameLiveTarget, verifyLiveWindow } from "./current-window.ts";
import type { DelegateHost } from "./host.ts";
import { type Identity, readIdentity } from "./identity.ts";
import { sameVerifiedWindow, windowFacts, windowPresentation } from "./locators.ts";
import { locateSession, recordedName } from "./results.ts";
import { matchesSessionOwner, sessionIsOwned } from "./session-owner.ts";
import { readTreeDisplay, type TreeEntry } from "./tree-registry.ts";
import { LiveActivityReader, type LiveLocator } from "./widget-live.ts";
import { WidgetTitleMirrors } from "./widget-title.ts";
import { WidgetTitleFiles } from "./widget-title-file.ts";

export type WidgetIdentity = { identity: string; agent?: string };
export type Breadcrumb = {
	key: string;
	parentSessionId: string;
	crumbs: WidgetIdentity[];
	self: WidgetIdentity;
	parentTitle?: string;
};
type Ancestor = { sessionId: string; identity?: Identity };

/** Durable parent ids only. A broken/cyclic chain refuses rather than inventing ancestry. */
export function ancestorSessions(ctx: ExtensionContext): Ancestor[] {
	const session: string = ctx.sessionManager.getSessionId();
	const own: Identity | undefined = readIdentity(session);
	return own ? ancestorChain(session, own) : [];
}

function ancestorChain(session: string, own: Identity): Ancestor[] {
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

export class BreadcrumbView {
	private readonly titles: WidgetTitleFiles = new WidgetTitleFiles();
	private readonly mirrors: WidgetTitleMirrors = new WidgetTitleMirrors();

	clear(): void {
		this.titles.clear();
		this.mirrors.clear();
	}

	async read(ctx: ExtensionContext, reader: LiveActivityReader): Promise<Breadcrumb | undefined> {
		const session = ctx.sessionManager.getSessionId();
		const own = readIdentity(session);
		if (!own) return;
		const ancestors = ancestorChain(session, own);
		let entries: TreeEntry[] = [];
		try {
			entries = readTreeDisplay(ancestors[0].sessionId).entries;
		} catch {
			/* labels optional */
		}
		const crumbs = ancestors.map((ancestor): WidgetIdentity => {
			const entry = entries.findLast((item) => item.sessionId === ancestor.sessionId);
			const label = entry?.launch ? recordedName(entry.launch) : ancestor.identity?.agent;
			return {
				identity: ancestor.identity ? (label ?? ancestor.identity.agent) : "root",
				agent: ancestor.identity?.agent,
			};
		});
		const parent = ancestors[ancestors.length - 1];
		const entry = entries.findLast((item) => item.sessionId === parent.sessionId);
		const live = await reader.locator(parent.sessionId);
		const path = live?.sessionFile ?? (entry?.launch ? locateSession(entry.launch, undefined) : undefined);
		const self = entries.findLast((item) => item.sessionId === session);
		return {
			key: `ancestor:${parent.sessionId}`,
			parentSessionId: parent.sessionId,
			crumbs,
			self: {
				identity: self?.launch ? recordedName(self.launch) : own.agent,
				agent: own.agent,
			},
			parentTitle: this.titles.read(path, parent.sessionId)?.name ?? this.mirrors.read(parent.sessionId),
		};
	}
}

export async function switchAncestor(
	ctx: ExtensionContext,
	sessionId: string,
	tmux: DelegateHost,
	assertActive: () => void,
	reader: LiveActivityReader = new LiveActivityReader(),
): Promise<void> {
	assertActive();
	if (!ancestorSessions(ctx).some((ancestor) => ancestor.sessionId === sessionId))
		throw new Error("target is not a current ancestor");
	const live: LiveLocator | undefined = await reader.locator(sessionId);
	const pane = live ? await verifyLiveWindow(tmux, live) : undefined;
	if (!live || !pane) throw new Error("no verified live window for this ancestor");
	assertActive();
	const shown = await tmux.show({ windowId: windowPresentation(pane).windowId, locator: pane.locator }, async () => {
		const current: LiveLocator | undefined = await reader.locator(sessionId);
		assertActive();
		const verified = current ? await verifyLiveWindow(tmux, current) : undefined;
		if (!current || !sameLiveTarget(live, current) || !verified || !sameVerifiedWindow(pane, verified))
			throw new Error("ancestor window changed or is unavailable");
		assertActive();
		if (!ancestorSessions(ctx).some((ancestor) => ancestor.sessionId === sessionId))
			throw new Error("ancestor identity changed");
		if (!matchesSessionOwner(sessionId, current.pid, current.ownerToken) || !sessionIsOwned(sessionId))
			throw new Error("ancestor owner changed or is unavailable");
		return true;
	});
	if ("text" in shown) throw shown.cause ?? new Error(shown.brief);
	assertActive();
	if (!shown.shown) return;
	const hint = windowFacts(pane).ancestorReturnHint ? ` · ${shown.returnHint}` : "";
	ctx.ui.notify(`delegate: switched to ancestor ${sessionId} (${windowPresentation(pane).windowId})${hint}`, "info");
}
