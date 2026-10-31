import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Local presentation signals only; neither observers nor count visibility own task state. */
export class ResultsPresentation {
	private readonly listeners = new Set<() => void>();
	private readonly icon: string = Math.random() < 0.5 ? "👨" : "👩";
	private visible = true;
	private shown = false;
	private ctx: ExtensionContext | undefined;
	private count = 0;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	setCountVisible = (visible: boolean): void => {
		this.visible = visible;
		this.footer();
	};

	update(ctx: ExtensionContext | undefined, count: number): void {
		this.ctx = ctx;
		this.count = count;
		this.footer();
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				/* An optional view cannot interrupt task/result processing. */
			}
		}
	}

	private footer(): void {
		if (this.ctx?.hasUI !== true) return;
		const visible: boolean = this.visible && this.count > 0;
		if (!visible && !this.shown) return;
		this.shown = visible;
		this.ctx.ui.setStatus(
			"delegate",
			visible ? `${this.icon} ${this.count} delegate${this.count === 1 ? "" : "s"} running` : undefined,
		);
	}
}
