// Native reload is separate from new-agent creation and never falls back to import.
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { PaseoAgent, PaseoClient } from "@getpaseo/client";
import type { ResumeConfiguration } from "./host.ts";
import type { PaseoApi, PaseoResumeInput } from "./paseo-api.ts";
import { sessionHeaderCwd, sessionHeaderId } from "./result-sessions.ts";
import { sessionIsOwned } from "./session-owner.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// @getpaseo/protocol 0.15.4 dist/agent-labels.js; not re-exported by the client.
const PARENT_LABEL = "paseo.parent-agent-id";

/** Reload of a missing Pi path silently starts a NEW session in Paseo 0.15.4.
 * The isolated spike is recorded in .scratch/reports/paseo-resume-spike.md;
 * validate the real header and runtime id, not only the stale persistence handle.
 */
function resumeConfiguration(agent: PaseoAgent | null, input: PaseoResumeInput): ResumeConfiguration {
	if (!UUID.test(input.agentId) || !UUID.test(input.parentAgentId))
		throw new Error("Paseo resume requires exact UUID agent identities");
	if (
		!isAbsolute(input.path) ||
		!isAbsolute(input.cwd) ||
		!statSync(input.path).isFile() ||
		!statSync(input.cwd).isDirectory() ||
		sessionHeaderId(input.path) !== input.sessionId ||
		sessionHeaderCwd(input.path) !== input.cwd
	)
		throw new Error("Paseo resume refused: missing, moved or mismatched Pi session file/header/cwd");
	if (sessionIsOwned(input.sessionId))
		throw new Error("Paseo resume refused: Pi session is already open in another process");
	if (!sameSession(agent, input) || !agent.archivedAt)
		throw new Error("Paseo resume refused: agent must identify this archived Squire Pi session, cwd and parent");
	if (!agent.model || !agent.thinkingOptionId)
		throw new Error("Paseo resume refused: original model/thinking configuration is unavailable");
	return { model: agent.model, thinking: agent.thinkingOptionId };
}

/** Exact daemon identity is checked both before and after reload. */
function sameSession(agent: PaseoAgent | null, input: PaseoResumeInput): agent is PaseoAgent {
	return (
		!!agent &&
		agent.id === input.agentId &&
		agent.provider === "pi" &&
		agent.labels["pi-squire"] === "1" &&
		agent.labels[PARENT_LABEL] === input.parentAgentId &&
		agent.cwd === input.cwd &&
		agent.persistence?.provider === "pi" &&
		agent.persistence.sessionId === input.sessionId &&
		agent.persistence.nativeHandle === input.path &&
		agent.runtimeInfo?.provider === "pi" &&
		agent.runtimeInfo.sessionId === input.sessionId &&
		sessionHeaderId(input.path) === input.sessionId &&
		sessionHeaderCwd(input.path) === input.cwd
	);
}

function canonicalHome(home: string): string {
	try {
		return realpathSync(resolve(home));
	} catch {
		return resolve(home);
	}
}

/** Existing connections close in the outer API; rollback preserves native public children. */
export function nativeResumeApi(
	home: string,
	run: <T>(work: (client: PaseoClient) => Promise<T>) => Promise<T>,
	preserveChildren: (client: PaseoClient, agentId: string) => Promise<boolean>,
): Pick<PaseoApi, "resumeConfiguration" | "resume"> {
	return {
		async resumeConfiguration(input: PaseoResumeInput): Promise<ResumeConfiguration> {
			if (input.home !== undefined && canonicalHome(input.home) !== home)
				throw new Error("Paseo resume refused: daemon home mismatch");
			return run(async (client) => {
				const handle = client.agents.ref(input.agentId);
				await handle.refresh();
				return resumeConfiguration(handle.current(), input);
			});
		},
		async resume(input: PaseoResumeInput): Promise<void> {
			if (input.home !== undefined && canonicalHome(input.home) !== home)
				throw new Error("Paseo resume refused: daemon home mismatch");
			await run(async (client) => {
				const handle = client.agents.ref(input.agentId);
				await handle.refresh();
				resumeConfiguration(handle.current(), input);
				try {
					await handle.reload();
					// The reopened child now owns this session. Check the daemon/file identity
					// without treating that expected owner as a competing pre-existing writer.
					const agent = handle.current();
					if (!sameSession(agent, input) || agent.archivedAt)
						throw new Error("Paseo reopened a mismatched Pi session; no task was mailed");
				} catch (error) {
					// Never hard-delete the original agent on a failed/mismatched reload.
					// Preserve public native children, exactly as normal auto-archive does.
					try {
						if (await preserveChildren(client, input.agentId)) await handle.archive();
					} catch (rollback) {
						throw new Error(
							`${String(error)}; could not re-archive Paseo agent ${input.agentId}: ${String(rollback)}; inspect it in Paseo`,
						);
					}
					throw error;
				}
			});
		},
	};
}
