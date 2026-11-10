import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isStarted, type Recorded, type Results, type StartedRecorded } from "./results.ts";
import type { DelegateHost } from "./tmux.ts";
import { readTreeDisplay } from "./tree-registry.ts";
import { visibleRecordFacts } from "./tree-view.ts";
import { joinActivities } from "./widget-activity-join.ts";
import { type Breadcrumb, BreadcrumbView, switchAncestor } from "./widget-ancestors.ts";
import { currentChildWindows } from "./widget-current.ts";
import { type DelegateRow, DirectDelegateView, delegateTree } from "./widget-data.ts";
import { WidgetFocus } from "./widget-focus.ts";
import { LiveActivityReader } from "./widget-live.ts";
import { renderDelegateWidget } from "./widget-render.ts";
import { WidgetSelection } from "./widget-selection.ts";
import { DEFAULT_WIDGET_SETTINGS, type WidgetSettings, widgetSettings } from "./widget-settings.ts";
import { titlePublisher } from "./widget-title.ts";
import { askPaneStates, type PaneStates, UNASKED } from "./window-state.ts";

export const DELEGATE_WIDGET_KEY = "squire-delegates";
export const WIDGET_REFRESH_MS = 1000;
type OpenDelegate = (ctx: ExtensionContext, id: string) => Promise<void>;

/** Observation and UI only; direct Results/task authority and the configured editor/footer stay untouched. */
class Overview {
	private readonly results: Results;
	private readonly tmux: DelegateHost;
	private readonly view = new DirectDelegateView();
	private readonly breadcrumbView = new BreadcrumbView();
	private readonly live = new LiveActivityReader();
	private breadcrumb: Breadcrumb | undefined;
	private ancestryError = "";
	private breadcrumbRevision = -1;
	private breadcrumbReadAt = 0;
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
	private allRows: DelegateRow[] = [];
	private configuration: WidgetSettings = { ...DEFAULT_WIDGET_SETTINGS };

	constructor(
		results: Results,
		tmux: DelegateHost,
		ctx: ExtensionContext,
		open: OpenDelegate,
		close: OpenDelegate,
		assertActive: () => void,
	) {
		this.results = results;
		this.tmux = tmux;
		this.ctx = ctx;
		this.focus = new WidgetFocus({
			ui: ctx.ui,
			selection: this.selection,
			changed: (): void => this.changed(),
			open: async (key: string): Promise<void> => {
				assertActive();
				if (this.breadcrumb?.key === key)
					return switchAncestor(ctx, this.breadcrumb.parentSessionId, tmux, assertActive, this.live);
				const row = this.rows.find((row) => row.key === key);
				if (!row) throw new Error("delegate is no longer visible");
				await open(ctx, row.launchId);
			},
			close: async (key: string): Promise<void> => {
				assertActive();
				if (this.breadcrumb?.key === key) return ctx.ui.notify("delegate: cannot close an ancestor", "warning");
				const row = this.rows.find((row) => row.key === key);
				if (!row) throw new Error("delegate is no longer visible");
				await close(ctx, row.launchId);
			},
			horizontal: (direction: -1 | 1): void => {
				const row = this.rows.find((candidate) => candidate.key === this.selection.selectedKey);
				if (!row) return;
				const expanded = this.selection.expanded;
				if (direction === -1) {
					if (!expanded.delete(row.key) && row.parentKey) this.selection.select(row.parentKey);
					return;
				}
				if (!row.descendantCount) return;
				if (!expanded.has(row.key)) return void expanded.add(row.key);
				const child = this.rows.find((candidate) => candidate.parentKey === row.key);
				if (child) this.selection.select(child.key);
			},
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
		this.breadcrumbView.clear();
		this.ctx.ui.setWidget(DELEGATE_WIDGET_KEY, undefined);
	}

	private changed(): void {
		if (this.stopped) return;
		this.layoutRevision++;
		const rows = this.treeRows(this.allRows);
		this.updateSelection(rows, this.configuration);
		this.show(rows, this.configuration);
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

	private async readBreadcrumb(): Promise<void> {
		if (this.breadcrumbRevision === this.factsRevision && Date.now() - this.breadcrumbReadAt < 30_000) return;
		this.breadcrumbRevision = this.factsRevision;
		this.breadcrumbReadAt = Date.now();
		try {
			this.breadcrumb = await this.breadcrumbView.read(this.ctx, this.live);
			this.ancestryError = "";
		} catch {
			this.breadcrumb = undefined;
			this.ancestryError = "Ancestor information unavailable";
		}
	}

	private treeRows(rows: DelegateRow[]): DelegateRow[] {
		return delegateTree(rows, this.ctx.sessionManager.getSessionId(), this.selection.expanded);
	}

	private updateSelection(rows: DelegateRow[], settings: WidgetSettings): void {
		this.selection.update(
			rows.map((row) => row.key),
			settings.maxEntries,
			this.breadcrumb?.key,
		);
	}

	private async refresh(): Promise<void> {
		this.reading = true;
		const revision: number = this.factsRevision;
		try {
			const settings: WidgetSettings = this.settings();
			this.configureCount(settings.maxEntries === 0);
			let observed: Results = this.results;
			if (settings.maxEntries > 0) {
				try {
					const records = visibleRecordFacts(this.results, this.ctx, 20, false, readTreeDisplay).records;
					observed = {
						...this.results,
						list: (): Recorded[] => records,
						running: (): StartedRecorded[] =>
							records
								.filter(isStarted)
								.filter((record) => !record.closed && !record.result && !record.gone && !record.accountingOnly),
					};
				} catch {}
			}
			const windows: PaneStates =
				settings.maxEntries > 0 && this.view.needsWindows(observed) ? await askPaneStates(this.tmux) : UNASKED;
			if (this.stopped || revision !== this.factsRevision) return;
			const sessionDir: string = this.ctx.sessionManager.getSessionDir();
			const current = await currentChildWindows(observed, windows.listing, this.live);
			await this.readBreadcrumb();
			if (this.stopped || revision !== this.factsRevision) return;
			const eligible: DelegateRow[] = this.view.read(observed, windows, sessionDir, { offset: 0, limit: 0 }, current);
			const projected = this.treeRows(eligible);
			this.updateSelection(projected, settings);
			const viewport = { offset: this.selection.offset, limit: settings.maxEntries };
			const layout: number = this.layoutRevision;
			const visibleKeys = new Set(
				projected.slice(viewport.offset, viewport.offset + viewport.limit).map((row) => row.key),
			);
			const allRows = this.view.read(observed, windows, sessionDir, viewport, current, visibleKeys);
			const rows = this.treeRows(allRows);
			await joinActivities(rows, viewport, observed);
			// Only Results notifications change factsRevision; timer ticks must not
			// starve a read, and selection changes must discard/requeue its old viewport.
			if (this.stopped || revision !== this.factsRevision || layout !== this.layoutRevision) return;
			this.allRows = allRows;
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
			breadcrumb: this.breadcrumb,
			ancestryError: this.ancestryError,
		};
		const signature: string = JSON.stringify([rows, settings, options, Math.floor(Date.now() / 60_000)]);
		if (signature === this.signature) return;
		this.signature = signature;
		if (!this.breadcrumb && !this.ancestryError && (!rows.length || !settings.maxEntries)) {
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
	tmux: DelegateHost,
	open: OpenDelegate,
	close: OpenDelegate,
	assertActive: () => void,
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
			overview = new Overview(results, tmux, ctx, open, close, assertActive);
			overview.start();
		}
	});
	pi.on("ui_prompt_start", () => overview?.suspend(true));
	pi.on("ui_prompt_end", () => overview?.suspend(false));
	pi.on("session_info_changed", (event) => publisher?.publish(event.name));
	pi.on("session_shutdown", stop);
}
