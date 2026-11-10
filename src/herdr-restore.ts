// Resume guard against two live Pis writing one session file. A Herdr restart
// restores panes under their old pane/tab ids with a new terminal_id and
// relaunches Pi there with `--session <file>` (verified on Herdr 0.9.5,
// docs/research/herdr-pi-integrations.md, ticket 01 section 7). pi-squire
// never adopts or closes such tabs; it only refuses to start a second writer.
import { realpathSync } from "node:fs";
import { type HerdrLocator, herdrLocator } from "./herdr-locator.ts";
import type { WindowRecord } from "./tmux-locator.ts";

export type HostPane = {
	pane_id: string;
	tab_id: string;
	workspace_id: string;
	terminal_id: string;
	agent?: string | null;
	agent_session?: { value?: string } | null;
};
export type HostTab = { tab_id: string; label?: string };
type Context = { session: string; socket: string };
export type HostEvidence = {
	own: Context | undefined;
	inventory(): Promise<{ panes: HostPane[]; tabs: HostTab[] }>;
	/** Resolves true only when Herdr proves the pane's foreground is just its shell. */
	shellOnly(pane: string): Promise<boolean>;
	same(locator: HerdrLocator, pane: HostPane): boolean;
};

/** Tabs from a snapshot, tolerating fields this adapter does not need. */
export function snapshotTabs(value: unknown): HostTab[] {
	return (Array.isArray(value) ? value : []).flatMap((item): HostTab[] => {
		const tab = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
		if (typeof tab.tab_id !== "string") return [];
		return [{ tab_id: tab.tab_id, ...(typeof tab.label === "string" ? { label: tab.label } : {}) }];
	});
}

/** Whether Herdr's reported agent session names this session file or id. */
function hostsSession(reported: string, session: { path: string; id: string }): boolean {
	if (reported === session.path || reported === session.id) return true;
	try {
		return realpathSync(reported) === realpathSync(session.path);
	} catch {
		return false;
	}
}

async function observed(evidence: HostEvidence, what: string): Promise<{ panes: HostPane[]; tabs: HostTab[] }> {
	try {
		return await evidence.inventory();
	} catch (error) {
		throw new Error(
			`could not ask Herdr whether a tab already runs ${what} (${String(error)}); resume refused so two Pis cannot write one session`,
		);
	}
}

/**
 * Refuse when a Herdr tab already runs the session, or when the restored
 * incarnation of the record's own pane may run it but Herdr cannot say.
 * Unknown evidence refuses; nothing is closed or adopted.
 */
export async function assertSessionFree(
	evidence: HostEvidence,
	record: WindowRecord,
	session: { path: string; id: string },
): Promise<void> {
	const what = `delegation session ${session.path}`;
	const own = evidence.own;
	if (!own)
		throw new Error(
			`could not ask Herdr whether a tab already runs ${what}: this Pi is not inside a Herdr pane; resume it from Pi in that Herdr session`,
		);
	const recorded = herdrLocator(record.locator);
	if (recorded && (recorded.session !== own.session || recorded.socket !== own.socket))
		throw new Error(
			`this delegation ran in Herdr session ${recorded.session}, not ${own.session}; resume it from Pi inside that Herdr session`,
		);
	const found = await observed(evidence, what);
	const tabName = (p: HostPane): string => {
		const label = found.tabs.find((tab) => tab.tab_id === p.tab_id)?.label;
		return label ? `${label} (${p.tab_id})` : p.tab_id;
	};
	// The record's own terminal is the ordinary running/exited case the window check decides.
	const others = found.panes.filter((p) => !recorded || !evidence.same(recorded, p));
	const host = others.find(
		(p) => typeof p.agent_session?.value === "string" && hostsSession(p.agent_session.value, session),
	);
	if (host)
		throw new Error(
			`Herdr tab ${tabName(host)} already runs ${what}; Herdr may have restored it after a restart. Switch to that tab, or quit its Pi or close the tab yourself, then resume again. pi-squire does not adopt or close tabs it did not open`,
		);
	const restored = recorded && others.find((p) => p.pane_id === recorded.pane);
	if (!restored || typeof restored.agent_session?.value === "string") return;
	// A restored pane that reports no session must prove it holds only its shell.
	const proven = !restored.agent && (await evidence.shellOnly(restored.pane_id).catch(() => false));
	if (!proven)
		throw new Error(
			`Herdr tab ${tabName(restored)} was restored after a restart and may still run ${what}, but Herdr does not report its session; quit its Pi or close the tab yourself, then resume again`,
		);
}
