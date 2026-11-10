// Launch selection: an explicit `multiplexer` setting, else the backend a
// delegate's launcher recorded (`PI_DELEGATE_MULTIPLEXER`), else the
// environment. Ambiguity and absence refuse; a chosen backend that is unusable
// refuses without falling back. Historical records always use the adapter
// their durable locator names, independent of today's choice.
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createHerdrClient } from "./herdr.ts";
import { herdrLocator, herdrPaneLocator } from "./herdr-locator.ts";
import { type Multiplexer, multiplexerSetting, squireSettingsFile as settingsFile } from "./settings.ts";
import { createTmuxClient, type TmuxClient, type WindowRecord, type WindowSpec, type WindowTarget } from "./tmux.ts";
import { validWindowLocator } from "./tmux-locator.ts";
import type { WindowPlacement } from "./window-placement.ts";
import { askToClose, askWindowStates, type ClosableStates, windowStates } from "./window-state.ts";

export { type Multiplexer, multiplexerSetting };
/** The backend that opened this delegate, set by its launcher; a delegate's tree keeps its root's choice. */
export const MULTIPLEXER_ENV = "PI_DELEGATE_MULTIPLEXER";

/**
 * The backend a launch uses now. Explicit setting > the launcher-recorded
 * backend of this delegate > environment detection (tmux only, Herdr only).
 * Both or neither present refuses; nothing falls back.
 */
export function chooseMultiplexer(input: {
	agentDir: string;
	inherited: string | undefined;
	inTmux: boolean;
	inHerdr: boolean;
}): Multiplexer {
	const setting = multiplexerSetting(input.agentDir);
	if (setting) return setting;
	if (input.inherited !== undefined && input.inherited !== "") {
		if (input.inherited === "tmux" || input.inherited === "herdr") return input.inherited;
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

async function observe(client: TmuxClient, strict: boolean): Promise<ClosableStates> {
	try {
		return await (strict ? askToClose(client) : askWindowStates(client));
	} catch (error) {
		// Preserve this backend\'s original close refusal without preventing a
		// different, positively observed backend from closing its own resource.
		return { ...windowStates(undefined), close: () => Promise.reject(error) };
	}
}

type Backends = { tmux: TmuxClient; herdr: TmuxClient; agentDir: () => string; inherited: () => string | undefined };

/** Launch choice and actual host, from environment-only presence checks (never a server call). */
function selection(own: Backends): { choice(): Multiplexer; host(): TmuxClient | undefined } {
	const inTmux = (): boolean => own.tmux.unavailable() === undefined;
	const inHerdr = (): boolean => own.herdr.unavailable() === undefined;
	return {
		choice: () =>
			chooseMultiplexer({ agentDir: own.agentDir(), inherited: own.inherited(), inTmux: inTmux(), inHerdr: inHerdr() }),
		/**
		 * The backend that actually hosts this Pi, for read-only own-pane telemetry.
		 * Not the launch setting: a tmux-hosted Pi with a Herdr setting is still in
		 * tmux. A delegate's launcher-recorded backend is reliable host evidence;
		 * otherwise exactly one present context decides, and both is ambiguous.
		 */
		host: () => {
			const launcher = own.inherited();
			if (launcher === "tmux") return inTmux() ? own.tmux : undefined;
			if (launcher === "herdr") return inHerdr() ? own.herdr : undefined;
			const t = inTmux();
			if (t === inHerdr()) return undefined;
			return t ? own.tmux : own.herdr;
		},
	};
}

export function createMultiplexer(
	tmux = createTmuxClient() as TmuxClient,
	herdr = createHerdrClient(),
	agentDir = getAgentDir,
	inherited: () => string | undefined = () => process.env[MULTIPLEXER_ENV],
): TmuxClient {
	const { choice, host } = selection({ tmux, herdr, agentDir, inherited });
	const selected = (): TmuxClient => (choice() === "herdr" ? herdr : tmux);
	const navigation = (target: WindowTarget): TmuxClient => {
		if (herdrLocator(target.locator) || herdrPaneLocator(target.locator)) return herdr;
		if ((target.locator && !validWindowLocator(target.locator)) || !/^@[0-9]+$/.test(target.windowId))
			throw new Error("no verified delegate navigation locator; target changed or unavailable");
		return tmux;
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
		openWindow: (spec: WindowSpec, placement: WindowPlacement, companion: string) =>
			tmux.openWindow(spec, placement, companion),
		listWindows: () => tmux.listWindows(),
		listPanes: () => tmux.listPanes(),
		inspectPane: (pane?: string) => tmux.inspectPane?.(pane) ?? Promise.resolve(undefined),
		observeLivePane: () => {
			const own = host();
			return own?.observeLivePane?.() ?? own?.inspectPane?.() ?? Promise.resolve(undefined);
		},
		verifyLivePane: (locator: object) => herdr.verifyLivePane?.(locator) ?? Promise.resolve(undefined),
		kill: (id: string) => tmux.kill(id),
		get windowListRefusal(): string {
			try {
				return selected().windowListRefusal;
			} catch {
				return tmux.windowListRefusal;
			}
		},
		show: (target: WindowTarget, verify: () => Promise<boolean>) => navigation(target).show(target, verify),
		peek: (target: WindowTarget) => navigation(target).peek(target),
		forLaunch: selected,
		unavailable,
		async states(strict = false): Promise<ClosableStates> {
			// Each backend fails independently: an unavailable Herdr cannot fabricate
			// disappearance of a tmux record, or vice versa.
			const [t, h] = await Promise.all([observe(tmux, strict), observe(herdr, strict)]);
			const forRecord = (record: WindowRecord) =>
				herdrLocator(record.locator) || herdrPaneLocator(record.locator) ? h : t;
			return {
				answered: t.answered || h.answered,
				look: (record: WindowRecord) => forRecord(record).look(record),
				state: (record: WindowRecord) => forRecord(record).state(record),
				listed: (record: WindowRecord) => forRecord(record).listed(record),
				close: (record: WindowRecord) => forRecord(record).close(record),
			};
		},
		async guardSession(record: WindowRecord, session: { path: string; id: string }, launch: TmuxClient): Promise<void> {
			// tmux-only resumes keep their behaviour; any Herdr involvement needs
			// positive Herdr evidence that no tab already runs this session.
			if (!herdrLocator(record.locator) && launch !== herdr) return;
			if (!herdr.guardSession) throw new Error("this Herdr adapter cannot check restored tabs; resume refused");
			await herdr.guardSession(record, session, launch);
		},
		// Herdr startup must never recover an ambiguous tab by name or pane id.
		// Successful opens publish their terminal-fenced locator in the parent.
		currentWindow: () =>
			host() === herdr ? Promise.resolve(undefined) : (tmux.currentWindow?.() ?? Promise.resolve(undefined)),
	};
}
