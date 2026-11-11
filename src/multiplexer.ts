// Launch selection: a Paseo-hosted Pi is its own terminal, so Paseo wins; else
// an explicit `multiplexer` setting, else the backend a delegate's launcher
// recorded (`PI_DELEGATE_MULTIPLEXER`), else the environment. Ambiguity and
// absence refuse; a chosen backend that is unusable refuses without falling
// back. Historical records always use the adapter their durable locator names,
// independent of today's choice.
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createHerdrClient } from "./herdr.ts";
import type { DelegateHost, OpenedWindow, WindowSpec, WindowTarget } from "./host.ts";
import { recordLocator, type WindowRecord } from "./locators.ts";
import { createPaseoHost } from "./paseo.ts";
import { type Multiplexer, multiplexerSetting, squireSettingsFile as settingsFile } from "./settings.ts";
import { createTmuxClient } from "./tmux.ts";
import type { WindowPlacement } from "./window-placement.ts";
import { type ClosableStates, windowStates } from "./window-state.ts";

export { type Multiplexer, multiplexerSetting };
/** The backend that opened this delegate, set by its launcher; a delegate's tree keeps its root's choice. */
export const MULTIPLEXER_ENV = "PI_DELEGATE_MULTIPLEXER";

/**
 * The backend a launch uses now. Paseo hosting this Pi > explicit setting > the
 * launcher-recorded backend of this delegate > environment detection (tmux
 * only, Herdr only). Both or neither present refuses; nothing falls back.
 */
export function chooseMultiplexer(input: {
	agentDir: string;
	inherited: string | undefined;
	inTmux: boolean;
	inHerdr: boolean;
	/** Whether Paseo hosts this Pi; a setting cannot move a delegate off its host. */
	inPaseo: boolean;
}): Multiplexer | "paseo" {
	if (input.inPaseo) return "paseo";
	const setting = multiplexerSetting(input.agentDir);
	if (setting) return setting;
	if (input.inherited !== undefined && input.inherited !== "") {
		// A Paseo delegate's launcher records "paseo"; it has no terminal to fall back to.
		if (input.inherited === "tmux" || input.inherited === "herdr" || input.inherited === "paseo")
			return input.inherited;
		throw new Error(
			`invalid ${MULTIPLEXER_ENV} ${JSON.stringify(input.inherited)} from this delegate's launcher; set "multiplexer": "tmux" or "herdr" in ${settingsFile(input.agentDir)}`,
		);
	}
	if (input.inTmux && input.inHerdr)
		throw new Error(
			`this session is inside both tmux and Herdr, so pi-squire will not guess where to open delegates; set "multiplexer": "tmux" or "herdr" in ${settingsFile(input.agentDir)}`,
		);
	if (input.inTmux) return "tmux";
	if (input.inHerdr) return "herdr";
	throw new Error(
		`this session is inside neither tmux nor Herdr; start Pi in a tmux pane or a Herdr pane to open a delegate (or set "multiplexer" in ${settingsFile(input.agentDir)})`,
	);
}

async function observe(client: DelegateHost, strict: boolean): Promise<ClosableStates> {
	try {
		return await client.states(strict);
	} catch (error) {
		return { ...windowStates(undefined), close: () => Promise.reject(error) };
	}
}

function tag(value: object | undefined): string | undefined {
	return value && "adapter" in value && typeof value.adapter === "string" ? value.adapter : undefined;
}

/** N-host routing. A locator can only reach its registered owner; unknown tags never fall back. */
export function createHostRouter(
	adapters: readonly DelegateHost[],
	choice: () => string,
	host: () => DelegateHost | undefined,
	unselectedRefusal: string,
): DelegateHost {
	const byId = new Map(adapters.map((adapter) => [adapter.id, adapter]));
	if (byId.size !== adapters.length) throw new Error("duplicate delegate host id");
	const selected = (): DelegateHost => {
		const found = byId.get(choice());
		if (!found) throw new Error("unsupported delegate host");
		return found;
	};
	const owner = (locator: object | undefined): DelegateHost | undefined => {
		const adapter = byId.get(tag(locator) ?? "");
		return adapter?.ownsLocator(locator) ? adapter : undefined;
	};
	const navigation = (target: WindowTarget): DelegateHost => {
		// Released navigation callers can still supply only a tmux window id.
		const locator = target.locator ?? recordLocator({ windowId: target.windowId, windowName: "" });
		const found = owner(locator);
		if (!found?.ownsLocator(locator, target))
			throw new Error("no verified delegate navigation locator; target changed or unavailable");
		return found;
	};
	function unavailable(): string | undefined;
	function unavailable(check: true): Promise<string | undefined>;
	function unavailable(check?: true): string | undefined | Promise<string | undefined> {
		try {
			return check ? selected().unavailable(true) : selected().unavailable();
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			return check ? Promise.resolve(text) : text;
		}
	}
	return {
		get id(): string {
			return selected().id;
		},
		get windowNoun(): string | undefined {
			return selected().windowNoun;
		},
		get usesWindowPlacement(): boolean {
			return selected().usesWindowPlacement;
		},
		get requiresSessionGuard(): boolean {
			return selected().requiresSessionGuard;
		},
		ownsLocator: (value: unknown, target?: WindowTarget) =>
			!!value && typeof value === "object" && owner(value)?.ownsLocator(value, target) === true,
		forLaunch: selected,
		taskMailTiming: (kind: import("./host.ts").StartKind) => selected().taskMailTiming(kind),
		unavailable,
		openWindow: (spec: WindowSpec, placement: WindowPlacement, companion: string) =>
			selected().openWindow(spec, placement, companion),
		closeTaskless: (opened: OpenedWindow) =>
			navigation({ windowId: opened.id, locator: opened.locator }).closeTaskless(opened),
		observeLivePane: () => host()?.observeLivePane?.() ?? Promise.resolve(undefined),
		verifyLivePane: (value: object) => owner(value)?.verifyLivePane?.(value) ?? Promise.resolve(undefined),
		paneStates: () => navigationStates(adapters, owner),
		get windowListRefusal(): string {
			try {
				return selected().windowListRefusal;
			} catch {
				return unselectedRefusal;
			}
		},
		show: (target: WindowTarget, verify: () => Promise<boolean>) => navigation(target).show(target, verify),
		peek: (target: WindowTarget) => navigation(target).peek(target),
		states: (strict?: boolean) => observeHosts(adapters, owner, strict),
		guardSession: (record: WindowRecord, session: { path: string; id: string }, launch: DelegateHost) =>
			guardHosts(owner, record, session, launch),
		currentWindow: () => recoverWindow(adapters, host()),
	};
}

/** Keep the released tmux navigation snapshot available even when this Pi is on another host. */
async function navigationStates(
	adapters: readonly DelegateHost[],
	owner: (locator: object | undefined) => DelegateHost | undefined,
): Promise<import("./window-state.ts").PaneStates> {
	const snapshots = await Promise.all(adapters.map((adapter) => adapter.paneStates?.()));
	const states = await observeHosts(adapters, owner);
	return { ...states, livePanes: snapshots.find((snapshot) => snapshot?.livePanes !== undefined)?.livePanes };
}

/** Startup recovery is a positive observation, not a launch fallback. */
async function recoverWindow(
	adapters: readonly DelegateHost[],
	host: DelegateHost | undefined,
): Promise<{ id: string; name: string } | undefined> {
	if (host) return host.currentWindow?.();
	// Released roots without unambiguous host evidence still asked the sole
	// recovery-capable adapter. Do not adopt when several adapters can recover.
	const capable = adapters.filter((adapter) => adapter.currentWindow !== undefined);
	return capable.length === 1 ? capable[0].currentWindow?.() : undefined;
}

async function guardHosts(
	owner: (locator: object | undefined) => DelegateHost | undefined,
	record: WindowRecord,
	session: { path: string; id: string },
	launch: DelegateHost,
): Promise<void> {
	const involved = new Set([owner(recordLocator(record)), launch]);
	for (const adapter of involved) {
		if (!adapter?.requiresSessionGuard) continue;
		if (!adapter.guardSession) throw new Error("this delegate host cannot check restored sessions; resume refused");
		await adapter.guardSession(record, session, launch);
	}
}

async function observeHosts(
	adapters: readonly DelegateHost[],
	owner: (locator: object | undefined) => DelegateHost | undefined,
	strict = false,
): Promise<ClosableStates> {
	const observations = new Map(
		await Promise.all(adapters.map(async (adapter) => [adapter, await observe(adapter, strict)] as const)),
	);
	const unknown = {
		...windowStates(undefined),
		close: (): Promise<never> =>
			Promise.reject(new Error("invalid or unsupported delegate window locator; close refused")),
	};
	const forRecord = (record: WindowRecord): ClosableStates => {
		const adapter = owner(record.locator ?? recordLocator(record));
		return (adapter && observations.get(adapter)) || unknown;
	};
	return {
		answered: [...observations.values()].some((state) => state.answered),
		look: (record: WindowRecord) => forRecord(record).look(record),
		state: (record: WindowRecord) => forRecord(record).state(record),
		listed: (record: WindowRecord) => forRecord(record).listed(record),
		close: (record: WindowRecord) => forRecord(record).close(record),
	};
}

/** Environment evidence for the actual host is independent of the call-time launch setting. */
export function createMultiplexer(
	tmux = createTmuxClient(),
	herdr: DelegateHost = createHerdrClient(),
	agentDir = getAgentDir,
	inherited: () => string | undefined = () => process.env[MULTIPLEXER_ENV],
	paseo: DelegateHost = createPaseoHost(),
): DelegateHost {
	const adapters = [tmux, herdr, paseo];
	const hosted = (): boolean => paseo.unavailable() === undefined;
	const present = (): DelegateHost[] => adapters.filter((adapter) => adapter.unavailable() === undefined);
	const host = (): DelegateHost | undefined => {
		// Paseo is the host this Pi runs in, not a terminal it can move between, so
		// startup recovery must never mint a terminal locator for it. A launcher
		// that recorded Paseo leaves no terminal to fall back to either.
		if (hosted()) return paseo;
		const launcher = inherited();
		const found = present();
		if (adapters.some((adapter) => adapter.id === launcher)) return found.find((adapter) => adapter.id === launcher);
		return found.length === 1 ? found[0] : undefined;
	};
	return createHostRouter(
		adapters,
		() =>
			chooseMultiplexer({
				agentDir: agentDir(),
				inherited: inherited(),
				inTmux: tmux.unavailable() === undefined,
				inHerdr: herdr.unavailable() === undefined,
				inPaseo: hosted(),
			}),
		host,
		tmux.windowListRefusal,
	);
}
