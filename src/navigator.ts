import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, isKeyRelease, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { locationTerms, noVerifiedOpen } from "./location.ts";
import { NavigatorView, type OpenDelegate } from "./navigator-view.ts";
import { isStarted, type Results, recordedName } from "./results.ts";
import { livePaneTarget, type TmuxClient, windowLocator } from "./tmux.ts";
import type { Tracking } from "./tracking.ts";

/** What `/delegate-open` does with a verified window. */
export type OpenMode = "switch" | "peek";

export const OPEN_USAGE = "/delegate-open <id> [--switch|--peek]";
const OPEN_FLAGS = ["--switch", "--peek"] as const;

/** What the peek hands back: switch to the delegate, or nothing. */
type PeekResult = { action: "switch" } | undefined;

const PEEK_HINT = "r refresh · enter switch · esc back";

/** A peek overlays the editor without replacing it. */
const PEEK_OPTIONS = { overlay: true, overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center" } } as const;

type PanelTheme = { fg(color: string, text: string): string; bold(text: string): string };

type Capture = { text: string; error: string | undefined; loading: boolean };

/** The lines a peek shows: the captured pane's last rows, or why there is none. */
function peekBody(peek: Capture, rows: number): string[] {
	if (peek.loading) return ["Capturing…"];
	if (peek.error !== undefined) return [`Could not capture the pane: ${peek.error}`];
	return peek.text
		.replace(/\s+$/, "")
		.split("\n")
		.slice(-Math.max(5, rows - 8));
}

/** A snapshot of one delegate's pane, shown as an overlay: `r` refreshes, enter switches, esc returns. */
class PeekView implements Component {
	private capture: Capture = { text: "", error: undefined, loading: true };
	private readonly item: OpenDelegate;
	private readonly theme: PanelTheme;
	private readonly read: (windowId: string) => Promise<string>;
	private readonly done: (result: PeekResult) => void;
	private readonly redraw: () => void;
	private readonly rows: () => number;

	constructor(parts: {
		item: OpenDelegate;
		theme: PanelTheme;
		read: (windowId: string) => Promise<string>;
		done: (result: PeekResult) => void;
		redraw: () => void;
		rows: () => number;
	}) {
		this.item = parts.item;
		this.theme = parts.theme;
		this.read = parts.read;
		this.done = parts.done;
		this.redraw = parts.redraw;
		this.rows = parts.rows;
		this.refresh();
	}

	invalidate(): void {}

	private refresh(): void {
		this.capture = { text: "", error: undefined, loading: true };
		void this.read(this.item.window.id).then(
			(text) => {
				this.capture = { text, error: undefined, loading: false };
				this.redraw();
			},
			(err: unknown) => {
				this.capture = { text: "", error: (err as Error).message, loading: false };
				this.redraw();
			},
		);
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		if (matchesKey(data, "escape")) this.done(undefined);
		else if (matchesKey(data, "r")) this.refresh();
		else if (matchesKey(data, "enter")) this.done({ action: "switch" });
		this.redraw();
	}

	render(width: number): string[] {
		const fit = (text: string): string => truncateToWidth(text, Math.max(1, width));
		const head = this.theme.bold(`Peek: ${this.item.name} (${this.item.window.id})`);
		const body = peekBody(this.capture, this.rows());
		return [head, "", ...body, "", this.theme.fg("dim", PEEK_HINT)].map(fit);
	}
}

/** What `src/index.ts` needs from the navigator. */
export type Navigator = {
	/** One action on one open delegation, for `/delegate-open`. */
	openDelegate(ctx: ExtensionContext, id: string, mode: OpenMode): Promise<void>;
	closeDelegate(ctx: ExtensionContext, id: string): Promise<void>;
	/** Ids of the delegations whose window is open, for completions. */
	openIds(): Promise<string[]>;
};

/** `/delegate-open`'s arguments: an id and at most one mode flag. */
export function parseOpen(text: string): { id: string; mode: OpenMode } | { error: string } {
	const words = text.trim() === "" ? [] : text.trim().split(/\s+/);
	const flags = words.filter((word) => word.startsWith("-"));
	const ids = words.filter((word) => !word.startsWith("-"));
	const unknown = flags.find((flag) => !(OPEN_FLAGS as readonly string[]).includes(flag));
	if (unknown !== undefined) return { error: `unknown flag ${unknown}; ${OPEN_USAGE}` };
	if (flags.length > 1) return { error: `give at most one of --switch and --peek; ${OPEN_USAGE}` };
	if (ids.length !== 1) return { error: `give one delegation id; ${OPEN_USAGE}` };
	const flag = flags[0];
	return { id: ids[0], mode: flag === undefined ? "switch" : (flag.slice(2) as OpenMode) };
}

/** Completions for `/delegate-open`: ids first, then the mode flags not yet given. */
export function openCompletions(prefix: string, ids: readonly string[]): { value: string; label: string }[] | null {
	const partial = /(?:^|\s)(\S*)$/.exec(prefix)?.[1] ?? "";
	const head = prefix.slice(0, prefix.length - partial.length);
	const given = head.trim() === "" ? [] : head.trim().split(/\s+/);
	const values: string[] = [];
	if (!given.some((word) => !word.startsWith("-"))) values.push(...ids);
	if (!given.some((word) => word.startsWith("-"))) values.push(...OPEN_FLAGS);
	const hits = values.filter((value) => value.startsWith(partial));
	return hits.length > 0 ? hits.map((value) => ({ value: head + value, label: value })) : null;
}

/** Context-bearing action seam; presentation never owns close scope or result wording. */
export type NavigatorActions = {
	assertActive(): void;
	close(
		id: string,
		ctx: ExtensionContext,
	): Promise<{ text: string; isError?: boolean; details?: { complete: boolean } }>;
};
type Env = {
	results: Results;
	tmux: TmuxClient;
	tracking: Pick<Tracking, "close">;
	actions: Partial<NavigatorActions>;
	view: NavigatorView;
};

async function verifiedWindow(env: Env, item: OpenDelegate): Promise<boolean> {
	env.actions.assertActive?.();
	const verified: boolean = await env.view.verified(item);
	env.actions.assertActive?.();
	return verified;
}

async function switchTo(env: Env, ctx: ExtensionContext, item: OpenDelegate): Promise<void> {
	env.actions.assertActive?.();
	let returnHint: string;
	try {
		const found = await env.tmux.show({ windowId: item.window.id, locator: windowLocator(item.window) }, async () => {
			env.actions.assertActive?.();
			if (await verifiedWindow(env, item)) return true;
			ctx.ui.notify(`delegate: ${noVerifiedOpen(locationTerms(item.record).noun)}`, "error");
			return false;
		});
		if ("text" in found) return ctx.ui.notify(`delegate: cannot switch: ${found.text}`, "warning");
		if (!found.shown) return;
		returnHint = found.returnHint;
	} catch (err) {
		return ctx.ui.notify(`delegate: could not switch: ${(err as Error).message}`, "error");
	}
	try {
		env.actions.assertActive?.();
	} catch (err) {
		return ctx.ui.notify(
			`delegate: switched to ${item.name} (${item.window.id}); session ownership lost: ${(err as Error).message}`,
			"warning",
		);
	}
	ctx.ui.notify(`delegate: switched to ${item.name} (${item.window.id}) · ${returnHint}`, "info");
}

async function close(env: Env, ctx: ExtensionContext, id: string): Promise<void> {
	env.actions.assertActive?.();
	const record = env.results.find(id);
	if (!record || !isStarted(record))
		return ctx.ui.notify("delegate: selected delegate is no longer available", "warning");
	const name = recordedName(record);
	const running = record.result || record.closed || record.gone ? "" : `${name} is still running. `;
	if (
		!(await ctx.ui.confirm("Close delegate", `${running}Close ${name} and its delegates? Worktrees and branches stay.`))
	)
		return;
	try {
		env.actions.assertActive?.();
		const result = await (env.actions.close?.(id, ctx) ?? env.tracking.close(id, ctx));
		env.actions.assertActive?.();
		ctx.ui.notify(
			`delegate: ${result.text}`,
			("isError" in result && result.isError) || result.details?.complete === false ? "error" : "info",
		);
	} catch (err) {
		ctx.ui.notify(`delegate: ${(err as Error).message}`, "error");
	}
}

/** Peek at a delegate's pane in an overlay; true when the user chose to switch to it. */
async function peek(env: Env, ctx: ExtensionContext, item: OpenDelegate): Promise<boolean> {
	const result = await ctx.ui.custom<PeekResult>(
		(tui, theme, _keybindings, done): PeekView =>
			new PeekView({
				item,
				theme: theme as unknown as PanelTheme,
				read: async (windowId: string): Promise<string> => {
					if (!(await verifiedWindow(env, item)))
						throw new Error(noVerifiedOpen(locationTerms(item.record).noun, { changed: false }));
					return env.tmux.peek({
						windowId,
						locator: windowLocator(item.window),
						paneId: item.live ? livePaneTarget(item.live.locator) : undefined,
					});
				},
				done,
				redraw: (): void => tui.requestRender(),
				rows: (): number => tui.terminal.rows,
			}),
		PEEK_OPTIONS,
	);
	return result?.action === "switch";
}

const noUi = (ctx: ExtensionContext): void => ctx.ui.notify("delegate: this needs an interactive session", "error");
const noWindows = (env: Env, ctx: ExtensionContext): void =>
	ctx.ui.notify(`delegate: ${env.tmux.windowListRefusal}`, "error");

/** One action on one open delegate, as `/delegate-open` runs it. */
async function openOne(env: Env, ctx: ExtensionContext, id: string, mode: OpenMode): Promise<void> {
	const items = await env.view.items();
	env.actions.assertActive?.();
	if (items === undefined) return noWindows(env, ctx);
	const item = items.find((candidate) => candidate.id === id);
	if (item === undefined) {
		const record = env.results.find(id);
		if (record) {
			const noun = isStarted(record) ? locationTerms(record).noun : "window";
			return ctx.ui.notify(`delegate: ${noVerifiedOpen(noun)}`, "error");
		}
		const known = items.map((candidate) => candidate.id).join(", ") || "none";
		return ctx.ui.notify(`delegate: no open delegate ${JSON.stringify(id)}; open: ${known}`, "error");
	}
	if (mode === "switch") return switchTo(env, ctx, item);
	if (ctx.mode !== "tui") return noUi(ctx);
	if (await peek(env, ctx, item)) await switchTo(env, ctx, item);
}

/** The command and compact-widget actions over the same verified navigation view. */
export function createNavigator(
	results: Results,
	tmux: TmuxClient,
	tracking: Pick<Tracking, "close">,
	actions: Partial<NavigatorActions> = {},
): Navigator {
	const env: Env = { results, tmux, tracking, actions, view: new NavigatorView(results, tmux) };
	return {
		openDelegate: (ctx: ExtensionContext, id: string, mode: OpenMode): Promise<void> => openOne(env, ctx, id, mode),
		closeDelegate: (ctx: ExtensionContext, id: string): Promise<void> => close(env, ctx, id),
		async openIds(): Promise<string[]> {
			actions.assertActive?.();
			return ((await env.view.items()) ?? []).map((item) => item.id);
		},
	};
}
