// Opt-in launch selection. Historical records always use their owning adapter,
// independent of today's setting; there is deliberately no auto-detection yet.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createHerdrClient } from "./herdr.ts";
import { herdrLocator, herdrPaneLocator } from "./herdr-locator.ts";
import { createTmuxClient, type TmuxClient, type WindowRecord, type WindowSpec, type WindowTarget } from "./tmux.ts";
import { validWindowLocator } from "./tmux-locator.ts";
import type { WindowPlacement } from "./window-placement.ts";
import { askToClose, askWindowStates, type ClosableStates, windowStates } from "./window-state.ts";

export function multiplexerSetting(agentDir: string): "tmux" | "herdr" {
	const file = join(agentDir, "squire", "settings.json");
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "tmux";
		throw new Error(`could not read multiplexer settings ${file}: ${String(error)}`);
	}
	const value =
		parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>).multiplexer
			: undefined;
	if (value === undefined) return "tmux";
	if (value === "tmux" || value === "herdr") return value;
	throw new Error(
		`invalid multiplexer settings ${file}: multiplexer must be "tmux" or "herdr", not ${JSON.stringify(value)}`,
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

export function createMultiplexer(
	tmux = createTmuxClient() as TmuxClient,
	herdr = createHerdrClient(),
	agentDir = getAgentDir,
): TmuxClient {
	const selected = (): TmuxClient => (multiplexerSetting(agentDir()) === "herdr" ? herdr : tmux);
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
			return check ? Promise.resolve(String(error)) : String(error);
		}
	}
	return {
		openWindow: (spec: WindowSpec, placement: WindowPlacement, companion: string) =>
			tmux.openWindow(spec, placement, companion),
		listWindows: () => tmux.listWindows(),
		listPanes: () => tmux.listPanes(),
		inspectPane: (pane?: string) => tmux.inspectPane?.(pane) ?? Promise.resolve(undefined),
		observeLivePane: () => selected().observeLivePane?.() ?? selected().inspectPane?.() ?? Promise.resolve(undefined),
		verifyLivePane: (locator: object) => herdr.verifyLivePane?.(locator) ?? Promise.resolve(undefined),
		kill: (id: string) => tmux.kill(id),
		get windowListRefusal(): string {
			return selected().windowListRefusal;
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
		// Herdr startup must never recover an ambiguous tab by name or pane id.
		// Successful opens publish their terminal-fenced locator in the parent.
		currentWindow: () =>
			multiplexerSetting(agentDir()) === "herdr"
				? Promise.resolve(undefined)
				: (tmux.currentWindow?.() ?? Promise.resolve(undefined)),
	};
}
