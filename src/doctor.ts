import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EventBus, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { globalAgentsDir, projectAgentsDir, type Roster } from "./agents.ts";
import type { DelegateHost } from "./host.ts";
import { hostAction } from "./host-admission.ts";
import { probeMail } from "./mail-preflight.ts";
import { MULTIPLEXER_ENV } from "./multiplexer.ts";
import { multiplexerSetting, squireSettingsFile } from "./settings.ts";

/** Parsing only: do not imply that every setting's value passed admission. */
function settingsStatus(path: string, bom = false): string {
	try {
		const text = readFileSync(path, "utf8");
		const value: unknown = JSON.parse(bom ? text.replace(/^\uFEFF/, "") : text);
		return value !== null && typeof value === "object" && !Array.isArray(value)
			? `${path}: parsed JSON object (values not validated)`
			: `${path}: invalid; expected a JSON object. Fix this file, then retry`;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? `${path}: absent (defaults)`
			: `${path}: parse/read error: ${(error as Error).message}. Fix this file, then retry`;
	}
}

function selectionReason(agentDir: string, env: NodeJS.ProcessEnv): string {
	if (env.PASEO_AGENT_ID) return "PASEO_AGENT_ID (Paseo hosting takes precedence over settings)";
	const explicit = multiplexerSetting(agentDir);
	if (explicit) return `multiplexer=${explicit} in ${squireSettingsFile(agentDir)}`;
	if (env[MULTIPLEXER_ENV]) return `${MULTIPLEXER_ENV}=${env[MULTIPLEXER_ENV]} from the launcher`;
	return "environment detection (TMUX / HERDR_ENV and Herdr pane identity)";
}

/** Read-only preflight: no launch, scan, mail delivery, settings repair, or trust change. */
export async function doctor(
	ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted"> & {
		sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionDir">;
	},
	deps: { agentDir: string; host: DelegateHost; roster(): Roster; events: EventBus; env?: NodeJS.ProcessEnv },
): Promise<string> {
	const { agentDir, host } = deps;
	const env = deps.env ?? process.env;
	const lines = ["delegate-doctor (read-only; availability is not a successful task)"];
	try {
		const selected = host.forLaunch?.() ?? host;
		lines.push(`Selected host: ${selected.id}; why: ${selectionReason(agentDir, env)}`);
		const unavailable = await selected.unavailable(true);
		lines.push(
			`Host availability: ${unavailable ?? "launch preflight passed; connectivity and task success not proven"}`,
		);
		if (unavailable) lines.push(hostAction(unavailable));
	} catch (error) {
		const cause = (error as Error).message;
		lines.push(`Host selection/availability refused: ${cause}`, hostAction(cause));
	}
	const trusted = ctx.isProjectTrusted();
	lines.push(
		`Agent directory (user): ${globalAgentsDir(agentDir)}`,
		`Agent directory (project): ${projectAgentsDir(ctx.cwd)} — ${trusted ? "trusted; read; replaces same-name user agents" : "untrusted; not read"}`,
	);
	try {
		const roster = deps.roster();
		lines.push(`Roster: ${roster.agents.length} usable agent(s)`);
		for (const agent of roster.agents) lines.push(`  ${agent.name}: ${agent.path}`);
		for (const warning of roster.warnings) lines.push(`Agent warning: ${warning}`);
		if (roster.agents.length === 0)
			lines.push(
				"Roster prerequisite: run /delegate in interactive Pi to create a starter, or add <name>.md in the user agent directory above; retry /delegate (no reload needed)",
			);
	} catch (error) {
		lines.push(`Roster read error: ${String(error)}`);
	}
	lines.push(
		`Squire settings: ${settingsStatus(squireSettingsFile(agentDir))}`,
		`Pi user settings: ${settingsStatus(join(agentDir, "settings.json"), true)}`,
		trusted
			? `Pi project settings: ${settingsStatus(join(ctx.cwd, ".pi", "settings.json"), true)}`
			: "Pi project settings: not read (untrusted)",
		`Session directory: ${ctx.sessionManager.getSessionDir()} (reported by Pi; writability not tested)`,
		`message:send: ${probeMail(deps.events, "message:send")}`,
		`message:reply: ${probeMail(deps.events, "message:reply")}`,
		"message:scan / inbound delivery: not probed (scan can claim mail); Pi cannot list event handlers",
	);
	return lines.join("\n");
}
