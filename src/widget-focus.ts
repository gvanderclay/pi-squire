// Pi 1.4.0 compatibility adapter: replace this module when Pi exposes prompt-scoped input.
// No editor/footer replacement, private focusedComponent access or fail-open shape guesses.
import { CustomEditor, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import type { WidgetSelection } from "./widget-selection.ts";

type PromptUI = Pick<ExtensionUIContext, "getEditorText" | "getEditorComponent">;
type PromptState = "empty" | "text" | "other";
type FocusGetter = { getFocusedComponent(): unknown };

/** Exact class identity was checked through the installed 1.4.0 bundled CLI/jiti loader. */
export function promptState(tui: unknown, ui: PromptUI): PromptState {
	try {
		if (!tui || typeof (tui as Partial<FocusGetter>).getFocusedComponent !== "function") return "other";
		const focused: unknown = (tui as FocusGetter).getFocusedComponent();
		if (!focused || Object.getPrototypeOf(focused) !== CustomEditor.prototype) return "other";
		if (ui.getEditorComponent() !== undefined) return "other";
		const editor: CustomEditor = focused as CustomEditor;
		if (typeof editor.isShowingAutocomplete !== "function" || editor.isShowingAutocomplete() !== false) return "other";
		return ui.getEditorText() === "" ? "empty" : "text";
	} catch {
		return "other";
	}
}

type InputUI = Pick<ExtensionUIContext, "onTerminalInput" | "getEditorText" | "getEditorComponent">;
type FocusOptions = {
	ui: InputUI;
	selection: WidgetSelection;
	changed(): void;
	open(key: string): Promise<void>;
	error(error: unknown): void;
};

/** Pseudo-focus: real Pi focus stays with the prompt until Pi mounts a dashboard/dialog. */
export class WidgetFocus {
	private readonly options: FocusOptions;
	private tui: unknown;
	private unsubscribe: (() => void) | undefined;
	private busy = false;
	private suspended = false;
	private stopped = false;

	constructor(options: FocusOptions) {
		this.options = options;
	}

	start(): void {
		if (this.stopped || this.unsubscribe) return;
		this.unsubscribe = this.options.ui.onTerminalInput((data) => this.input(data));
	}

	attach(tui: unknown): void {
		// InteractiveMode injects a stable proxy which follows regular/fullscreen replacement.
		this.tui = tui;
	}

	get focused(): boolean {
		return (
			!this.stopped &&
			!this.busy &&
			!this.suspended &&
			this.options.selection.active &&
			promptState(this.tui, this.options.ui) === "empty"
		);
	}

	suspend(suspended: boolean): void {
		if (this.stopped) return;
		this.suspended = suspended;
		// Our own dashboard keeps selection; unrelated prompts relinquish pseudo-focus.
		if (suspended && !this.busy) this.options.selection.leave();
		this.options.changed();
	}

	stop(): void {
		this.stopped = true;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.tui = undefined;
	}

	private leave(): void {
		if (!this.options.selection.active) return;
		this.options.selection.leave();
		this.options.changed();
	}

	private input(data: string): { consume: true } | undefined {
		if (this.stopped || isKeyRelease(data)) return;
		// Async listing/action loops temporarily return focus to the prompt. Do not
		// let dashboard Escape abort a run or action letters leak into that editor.
		if (this.busy) return this.pendingInput();
		if (this.suspended || promptState(this.tui, this.options.ui) !== "empty") {
			this.leave();
			return;
		}
		const selection: WidgetSelection = this.options.selection;
		if (!selection.active) {
			if (!matchesKey(data, "down") || !selection.enter()) return;
		} else if (matchesKey(data, "down")) selection.move(1);
		else if (matchesKey(data, "up")) selection.move(-1);
		else if (matchesKey(data, "escape")) selection.leave();
		else if (matchesKey(data, "enter")) this.open();
		else {
			this.leave();
			return;
		}
		this.options.changed();
		return { consume: true };
	}

	private pendingInput(): { consume: true } | undefined {
		return promptState(this.tui, this.options.ui) === "empty" ? { consume: true } : undefined;
	}

	private open(): void {
		const key: string | undefined = this.options.selection.selectedKey;
		if (key === undefined) return;
		this.busy = true; // Set before invoking async custom UI; repeated Enter cannot reenter.
		void Promise.resolve()
			.then(() => {
				if (!this.stopped) return this.options.open(key);
			})
			.catch((error: unknown) => {
				if (!this.stopped) this.options.error(error);
			})
			.finally(() => {
				this.busy = false;
				if (!this.stopped) this.options.changed();
			});
	}
}
