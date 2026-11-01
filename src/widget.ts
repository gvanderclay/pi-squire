import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Results } from "./results.ts";
import type { TmuxClient } from "./tmux.ts";
import { joinActivities } from "./widget-activity-join.ts";
import { type DelegateRow, DirectDelegateView } from "./widget-data.ts";
import { renderDelegateWidget } from "./widget-render.ts";
import { DEFAULT_WIDGET_SETTINGS, type WidgetSettings, widgetSettings } from "./widget-settings.ts";
import { titlePublisher } from "./widget-title.ts";
import { listWindows } from "./windows.ts";

export const DELEGATE_WIDGET_KEY = "squire-delegates";
export const WIDGET_REFRESH_MS = 1000;

/** Owns only observation/UI resources; no editor, footer, keys or task state. */
class Overview {
	private readonly results: Results;
	private readonly tmux: TmuxClient;
	private readonly view = new DirectDelegateView();
	private readonly ctx: ExtensionContext;
	private timer: ReturnType<typeof setInterval> | undefined;
	private immediate: ReturnType<typeof setImmediate> | undefined;
	private unsubscribe: (() => void) | undefined;
	private stopped = false;
	private reading = false;
	private again = false;
	private factsRevision = 0;
	private signature = "";
	private warning = "";
	private countVisible: boolean | undefined;

	constructor(results: Results, tmux: TmuxClient, ctx: ExtensionContext) {
		this.results = results;
		this.tmux = tmux;
		this.ctx = ctx;
	}

	start(): void {
		this.unsubscribe = this.results.subscribe(() => {
			this.factsRevision++;
			this.queue();
		});
		this.configureCount(this.settings().maxEntries === 0);
		this.queue();
		this.timer = setInterval(() => this.queue(), WIDGET_REFRESH_MS);
		this.timer.unref();
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		if (this.immediate) clearImmediate(this.immediate);
		this.unsubscribe?.();
		this.view.clear();
		this.ctx.ui.setWidget(DELEGATE_WIDGET_KEY, undefined);
		// Do not write the old session's status after replacement.
	}

	private configureCount(visible: boolean): void {
		if (this.countVisible === visible) return;
		this.countVisible = visible;
		this.results.setCountVisible(visible);
	}

	private settings(): WidgetSettings {
		try {
			const settings: WidgetSettings = widgetSettings();
			this.warning = "";
			return settings;
		} catch (error) {
			const warning: string = String(error);
			if (warning !== this.warning) this.ctx.ui.notify(`delegate: ${warning}; using widget defaults.`, "warning");
			this.warning = warning;
			return { ...DEFAULT_WIDGET_SETTINGS };
		}
	}

	private queue(): void {
		if (this.stopped) return;
		if (this.reading) {
			this.again = true;
			return;
		}
		if (this.immediate) return;
		this.immediate = setImmediate(() => {
			this.immediate = undefined;
			void this.refresh();
		});
	}

	private async refresh(): Promise<void> {
		this.reading = true;
		try {
			const settings: WidgetSettings = this.settings();
			this.configureCount(settings.maxEntries === 0);
			const revision: number = this.factsRevision;
			const windows =
				settings.maxEntries > 0 && this.view.needsWindows(this.results) ? await listWindows(this.tmux) : [];
			if (this.stopped) return;
			const rows: DelegateRow[] = this.view.read(this.results, windows, this.ctx.sessionManager.getSessionDir(), {
				offset: 0,
				limit: settings.maxEntries,
			});
			await joinActivities(rows, { offset: 0, limit: settings.maxEntries }, this.results);
			if (this.stopped) return;
			// Results notifications arriving during I/O need a fresh eligibility/state snapshot.
			if (revision !== this.factsRevision) return;
			this.show(rows, settings);
		} catch {
			// Optional metadata/UI failures cannot interrupt the poll, launch or result processing.
		} finally {
			this.reading = false;
			if (this.again) {
				this.again = false;
				this.queue();
			}
		}
	}

	private show(rows: DelegateRow[], settings: WidgetSettings): void {
		const signature: string = JSON.stringify([rows, settings, Math.floor(Date.now() / 60_000)]);
		if (signature === this.signature) return;
		this.signature = signature;
		if (!rows.length || !settings.maxEntries) {
			this.ctx.ui.setWidget(DELEGATE_WIDGET_KEY, undefined);
			return;
		}
		// Re-register on changed snapshots through ctx.ui (the CURRENT renderer).
		// Never retain factory tui: regular/fullscreen migration does not renew it.
		this.ctx.ui.setWidget(
			DELEGATE_WIDGET_KEY,
			() => ({
				render: (width: number) => renderDelegateWidget(rows, settings.maxEntries, width, this.ctx.ui.theme),
				invalidate: () => {},
			}),
			{ placement: settings.placement },
		);
	}
}

/** Minimal index seam. Register after direct restore without altering startup/settle ordering. */
export function registerDelegateWidget(pi: ExtensionAPI, results: Results, tmux: TmuxClient): void {
	let overview: Overview | undefined;
	let publisher: ReturnType<typeof titlePublisher> | undefined;
	const stop = (): void => {
		overview?.stop();
		overview = undefined;
		publisher?.stop();
		publisher = undefined;
	};
	pi.on("session_start", (_event, ctx) => {
		stop();
		publisher = titlePublisher(ctx.sessionManager.getSessionId());
		publisher.publish(pi.getSessionName());
		if (ctx.hasUI && ctx.mode === "tui") {
			overview = new Overview(results, tmux, ctx);
			overview.start();
		}
	});
	pi.on("session_info_changed", (event) => publisher?.publish(event.name));
	pi.on("session_shutdown", stop);
}
