// An in-memory DelegateHost for conformance and feature tests: no tmux
// sessions, commands, placement or argv parsing. It records what it was asked
// to start, so feature tests can assert the start spec without a tmux model.
//
// Two variants: `terminal` has a viewer and a screen, and mails like tmux
// (resume after open, launch and fork before). `pane-free` has no viewer and
// no pane, mails every start after open and configures each start through
// `configureStart`, the shape an API host such as Paseo takes. Its `peek`
// answers with the worker's recent activity text, not a terminal screen.
//
// Identity reuses the released tmux window codec (`{ adapter: "tmux", ... }`).
// The durable codec table in src/locators.ts is closed on purpose: records,
// the tree registry and the start journal refuse an unregistered tag, so a
// test host cannot mint its own. A production host registers its own codec
// there (the Paseo host ticket); its contract cases are the same.

import type {
	DelegateHost,
	OpenedWindow,
	ShowResult,
	StartConfiguration,
	WindowSpec,
	WindowTarget,
} from "../src/host.ts";
import { WindowOpenError } from "../src/host.ts";
import { recordLocator, type WindowRecord, windowPresentation } from "../src/locators.ts";
import { tmuxLocator, tmuxWindowLocator } from "../src/tmux-locator.ts";
import type { WindowPlacement } from "../src/window-placement.ts";
import { type ClosableStates, type WindowLook, windowStates } from "../src/window-state.ts";

export type MemoryVariant = "terminal" | "pane-free";
type Terminal = { name: string; running: boolean; screen: string };
export type MemoryStart = WindowSpec & {
	id: string;
	locator: object;
	placement: WindowPlacement;
	companion: string;
};

const NO_VIEWER = "the memory host has no terminal viewer; its delegates run without a pane";

export class MemoryHost implements DelegateHost {
	readonly id = "memory";
	readonly usesWindowPlacement = false;
	readonly requiresSessionGuard = false;
	readonly windowListRefusal = "could not ask the memory host for its delegates";
	readonly variant: MemoryVariant;
	/** Every start the host was asked for, in order: the spec it received and the identity it returned. */
	readonly started: MemoryStart[] = [];
	/** Every configuration a pane-free host applied, in order. */
	readonly configurations: StartConfiguration[] = [];
	/** Terminals by window id; a missing id was closed or exited. */
	readonly terminals = new Map<string, Terminal>();
	/** Window ids closed through states().close or closeTaskless, in order. */
	readonly closed: string[] = [];
	/** When set, observation fails: every record is unknown and close refuses. */
	failAsk = false;
	/** When set, closing refuses after a successful observation. */
	failClose = false;
	/** When set, openWindow refuses with this certainty; `unknown` leaves the terminal running. */
	failOpen: { message: string; certainty: "not-opened" | "unknown" } | undefined;
	/** When set, configureStart rejects with this message. */
	failConfigure: string | undefined;
	/** When set, unavailable() refuses with this text. */
	refusal: string | undefined;
	/** When set, openWindow reports this Pi session id instead of the requested one. */
	assignSessionId: string | undefined;
	/** When true, delegates never auto-exit on this host. */
	keepsDelegatesOpen: boolean | undefined;
	/** Whether a viewer is attached; always false for the pane-free variant. */
	viewer: boolean;
	/** The window id the viewer shows, if any. */
	shown: string | undefined;
	/** The window id of the last open that failed with `unknown` certainty. */
	unconfirmed: string | undefined;
	configureStart?: (opened: OpenedWindow, configuration: StartConfiguration) => Promise<void>;
	private next = 0;

	constructor(variant: MemoryVariant = "terminal") {
		this.variant = variant;
		this.viewer = variant === "terminal";
		if (variant === "pane-free")
			this.configureStart = async (_opened, configuration) => {
				if (this.failConfigure !== undefined) throw new Error(this.failConfigure);
				this.configurations.push(configuration);
			};
	}

	taskMailTiming(kind: import("../src/host.ts").StartKind): "before-open" | "after-open" {
		if (this.variant === "pane-free") return "after-open";
		return kind === "resume" ? "after-open" : "before-open";
	}

	ownsLocator(value: unknown, target?: WindowTarget): boolean {
		if (!tmuxLocator(value)) return false;
		return !target || target.windowId === windowPresentation({ locator: value }).windowId;
	}

	unavailable(): string | undefined;
	unavailable(checkVersion: true): Promise<string | undefined>;
	unavailable(checkVersion?: true): string | undefined | Promise<string | undefined> {
		return checkVersion ? Promise.resolve(this.refusal) : this.refusal;
	}

	async openWindow(spec: WindowSpec, placement: WindowPlacement, companion: string): Promise<OpenedWindow> {
		if (this.refusal !== undefined) throw new WindowOpenError(this.refusal, "not-opened");
		const failure = this.failOpen;
		if (failure?.certainty === "not-opened") throw new WindowOpenError(failure.message, "not-opened");
		const id = `@${++this.next}`;
		this.terminals.set(id, { name: spec.name, running: true, screen: "SQUIRE-ADAPTER-SCREEN" });
		if (failure) {
			this.failOpen = undefined;
			this.unconfirmed = id;
			throw new WindowOpenError(failure.message, "unknown");
		}
		const locator = tmuxWindowLocator({ id, name: spec.name });
		this.started.push({ ...spec, argv: [...spec.argv], env: { ...spec.env }, id, locator, placement, companion });
		return {
			id,
			session: undefined,
			...(this.assignSessionId === undefined ? {} : { sessionId: this.assignSessionId }),
			locator,
		};
	}

	private own(record: WindowRecord): { id: string; name: string } | undefined {
		const locator = recordLocator(record);
		if (!this.ownsLocator(locator)) return undefined;
		const { windowId, windowName } = windowPresentation({ locator });
		return { id: windowId, name: windowName };
	}

	private find(record: WindowRecord): Terminal | undefined {
		const own = this.own(record);
		const terminal = own && this.terminals.get(own.id);
		return terminal && terminal.name === own.name ? terminal : undefined;
	}

	async states(strict = false): Promise<ClosableStates> {
		if (this.failAsk) {
			if (strict) throw new Error("could not ask the memory host which delegates are open");
			return {
				...windowStates(undefined),
				close: () => Promise.reject(new Error("could not ask the memory host which delegates are open; none closed")),
			};
		}
		const look = (record: WindowRecord): WindowLook => {
			if (!this.own(record)) return { state: "unknown" };
			const terminal = this.find(record);
			return { state: terminal?.running ? "running" : "gone" };
		};
		return {
			answered: true,
			look,
			state: (record) => look(record).state,
			listed: (record) => this.find(record) !== undefined,
			close: async (record) => {
				const own = this.own(record);
				if (!own) throw new Error("invalid or unsupported delegate window locator; close refused");
				if (!this.find(record)) return false;
				if (this.failClose) throw new Error("the memory host refused to close the delegate");
				this.terminals.delete(own.id);
				this.closed.push(own.id);
				return true;
			},
		};
	}

	async closeTaskless(opened: OpenedWindow): Promise<void> {
		try {
			await (await this.states(true)).close({ locator: opened.locator });
		} catch (error) {
			throw new Error(
				`the delegate's memory window ${opened.id} could not be closed and may still run Pi with no task (${(error as Error).message}); close it yourself`,
			);
		}
	}

	async show(target: WindowTarget, verify: () => Promise<boolean>): Promise<ShowResult> {
		if (!this.viewer) return { text: NO_VIEWER, brief: "no viewer" };
		if (!(await verify())) return { shown: false };
		const terminal = this.find({ locator: target.locator });
		if (!terminal?.running) throw new Error("no verified open window for this delegation");
		this.shown = target.windowId;
		return { shown: true, returnHint: "return to the parent terminal" };
	}

	async peek(target: WindowTarget): Promise<string> {
		const terminal = this.find({ locator: target.locator });
		if (!terminal?.running) throw new Error("no verified open window for this delegation");
		return terminal.screen;
	}

	/** The record's window, for feature tests. */
	record(start: MemoryStart): WindowRecord {
		return { locator: start.locator };
	}

	/** The delegate's program ended; the memory host does not keep exited windows listed. */
	exit(record: WindowRecord): void {
		const own = this.own(record);
		if (own) this.terminals.delete(own.id);
	}
}
