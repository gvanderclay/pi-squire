import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Results } from "./results.ts";
import type { TmuxClient } from "./tmux.ts";
import { joinActivities } from "./widget-activity-join.ts";
import { type DelegateRow, DirectDelegateView } from "./widget-data.ts";
import { WidgetFocus } from "./widget-focus.ts";
import { renderDelegateWidget } from "./widget-render.ts";
import { WidgetSelection } from "./widget-selection.ts";
import { DEFAULT_WIDGET_SETTINGS, type WidgetSettings, widgetSettings } from "./widget-settings.ts";
import { titlePublisher } from "./widget-title.ts";
import { listWindows } from "./windows.ts";

export const DELEGATE_WIDGET_KEY = "squire-delegates";
export const WIDGET_REFRESH_MS = 1000;
type OpenDashboard = (ctx: ExtensionContext, sessionId: string) => Promise<void>;

/** Observation and UI only; direct Results/task authority and the configured editor/footer stay untouched. */
class Overview {
	private readonly results: Results;
	private readonly tmux: TmuxClient;
	private readonly view = new DirectDelegateView();
	private readonly ctx: ExtensionContext;
	private readonly selection = new WidgetSelection();
	private readonly focus: WidgetFocus;
	private timer: ReturnType<typeof setInterval> | undefined;
	private immediate: ReturnType<typeof setImmediate> | undefined;
	private unsubscribe: (() => void) | undefined;
	private stopped = false;
	private reading = false;
	private again = false;
	private signature = "";
	private warning = "";
	private countVisible: boolean | undefined;
	private factsRevision = 0;
	private layoutRevision = 0;
	private rows: DelegateRow[] = [];
	private configuration: WidgetSettings = { ...DEFAULT_WIDGET_SETTINGS };

	constructor(results: Results, tmux: TmuxClient, ctx: ExtensionContext, open: OpenDashboard) {
		this.results = results;
		this.tmux = tmux;
		this.ctx = ctx;
		this.focus = new WidgetFocus({
			ui: ctx.ui,
			selection: this.selection,
			changed: (): void => this.changed(),
			open: (key: string): Promise<void> => open(ctx, key),
			error: (error: unknown): void =>
				ctx.ui.notify(`delegate: ${error instanceof Error ? error.message : String(error)}`, "error"),
		});
	}

	start(): void {
		this.unsubscribe = this.results.subscribe(() => {
			this.factsRevision++;
			this.queue();
		});
		this.focus.start();
		this.configureCount(this.settings().maxEntries === 0);
		this.queue();
		this.timer = setInterval(() => this.queue(), WIDGET_REFRESH_MS);
		this.timer.unref();
	}

	suspend(suspended: boolean): void {
		this.focus.suspend(suspended);
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		if (this.immediate) clearImmediate(this.immediate);
		this.unsubscribe?.();
		this.focus.stop();
		this.view.clear();
		this.ctx.ui.setWidget(DELEGATE_WIDGET_KEY, undefined);
	}

	private changed(): void {
		if (this.stopped) return;
		this.layoutRevision++;
		this.show(this.rows, this.configuration);
		this.queue();
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
		const revision: number = this.factsRevision;
		try {
			const settings: WidgetSettings = this.settings();
			this.configureCount(settings.maxEntries === 0);
			const windows =
				settings.maxEntries > 0 && this.view.needsWindows(this.results) ? await listWindows(this.tmux) : [];
			if (this.stopped || revision !== this.factsRevision) return;
			const sessionDir: string = this.ctx.sessionManager.getSessionDir();
			const eligible: DelegateRow[] = this.view.read(this.results, windows, sessionDir, { offset: 0, limit: 0 });
			this.selection.update(
				eligible.map((row) => row.key),
				settings.maxEntries,
			);
			const viewport = { offset: this.selection.offset, limit: settings.maxEntries };
			const layout: number = this.layoutRevision;
			const rows: DelegateRow[] = this.view.read(this.results, windows, sessionDir, viewport);
			await joinActivities(rows, viewport, this.results);
			// Only Results notifications change factsRevision; timer ticks must not
			// starve a read, and selection changes must discard/requeue its old viewport.
			if (this.stopped || revision !== this.factsRevision || layout !== this.layoutRevision) return;
			this.show(rows, settings);
		} catch {
			// Optional metadata/UI failures cannot interrupt launch, poll or result processing.
		} finally {
			this.reading = false;
			if (this.again) {
				this.again = false;
				this.queue();
			}
		}
	}

	private show(rows: DelegateRow[], settings: WidgetSettings): void {
		this.rows = rows;
		this.configuration = settings;
		const options = {
			offset: this.selection.offset,
			selectedKey: this.selection.selectedKey,
			focused: this.focus.focused,
		};
		const signature: string = JSON.stringify([rows, settings, options, Math.floor(Date.now() / 60_000)]);
		if (signature === this.signature) return;
		this.signature = signature;
		if (!rows.length || !settings.maxEntries) {
			this.ctx.ui.setWidget(DELEGATE_WIDGET_KEY, undefined);
			return;
		}
		this.ctx.ui.setWidget(
			DELEGATE_WIDGET_KEY,
			(tui) => {
				this.focus.attach(tui); // Pi 1.4.0 stable proxy follows renderer replacement.
				return {
					render: (width: number) =>
						renderDelegateWidget(rows, settings.maxEntries, width, this.ctx.ui.theme, Date.now(), {
							...options,
							focused: this.focus.focused,
						}),
					invalidate: () => {},
				};
			},
			{ placement: settings.placement },
		);
	}
}

/** Register after direct restore, preserving ownership/answer/settlement ordering. */
export function registerDelegateWidget(
	pi: ExtensionAPI,
	results: Results,
	tmux: TmuxClient,
	open: OpenDashboard,
): void {
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
			overview = new Overview(results, tmux, ctx, open);
			overview.start();
		}
	});
	pi.on("ui_prompt_start", () => overview?.suspend(true));
	pi.on("ui_prompt_end", () => overview?.suspend(false));
	pi.on("session_info_changed", (event) => publisher?.publish(event.name));
	pi.on("session_shutdown", stop);
}
