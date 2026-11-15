// Native reload is separate from new-agent creation and never falls back to import.
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { PaseoAgent, PaseoAgentHandle, PaseoClient } from "@getpaseo/client";
import { type NativeResumeRollback, type ResumeConfiguration, WindowOpenError } from "./host.ts";
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

type PreserveChildren = (client: PaseoClient, agentId: string) => Promise<boolean>;

/** Refund only a definitive reload answer followed by confirmed closed rollback. */
async function rollbackReload(
	client: PaseoClient,
	handle: PaseoAgentHandle,
	input: PaseoResumeInput,
	preserveChildren: PreserveChildren,
	error: unknown,
	answered: boolean,
): Promise<never> {
	const message = `${error instanceof Error ? error.message : String(error)}${
		answered ? "" : "; Paseo reload outcome is unknown; its reservation slot stays held"
	}`;
	try {
		if (!(await preserveChildren(client, input.agentId))) throw new Error("archive was canceled");
		await handle.archive();
		await handle.refresh();
		const agent = handle.current();
		if (!agent || agent.id !== input.agentId || !agent.archivedAt || agent.status !== "closed")
			throw new Error("archive readback did not confirm the original agent is inactive");
	} catch (rollback) {
		throw new WindowOpenError(
			`${message}; could not re-archive Paseo agent ${input.agentId}: ${String(rollback)}; inspect it in Paseo`,
			"unknown",
		);
	}
	if (!answered) throw new WindowOpenError(`${message}; inspect it in Paseo`, "unknown");
	throw new WindowOpenError(message, "not-opened", {
		kind: "native-resume-closed",
		sessionId: input.sessionId,
		agentId: input.agentId,
	});
}

async function reloadChecked(
	client: PaseoClient,
	handle: PaseoAgentHandle,
	input: PaseoResumeInput,
	preserveChildren: PreserveChildren,
): Promise<void> {
	let answered = false;
	try {
		await handle.reload();
		answered = true;
		// This expected child now owns the session; only pre-existing owners conflict.
		const agent = handle.current();
		if (!sameSession(agent, input) || agent.archivedAt)
			throw new Error("Paseo reopened a mismatched Pi session; no task was mailed");
	} catch (error) {
		// @getpaseo/client 0.15.4 dist/daemon-client.js:141-156,1207-1246:
		// the unexported DaemonRpcError identifies a server rpc_error response.
		// Other rejections (including timeouts) may still finish reload after rollback.
		answered ||= error instanceof Error && error.name === "DaemonRpcError";
		await rollbackReload(client, handle, input, preserveChildren, error, answered);
	}
}

/** Existing connections close in the outer API; rollback preserves native public children. */
export function nativeResumeApi(
	home: string,
	run: <T>(work: (client: PaseoClient) => Promise<T>) => Promise<T>,
	preserveChildren: PreserveChildren,
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
			let reloading = false;
			let rollback: NativeResumeRollback | undefined;
			try {
				if (input.home !== undefined && canonicalHome(input.home) !== home)
					throw new Error("Paseo resume refused: daemon home mismatch");
				await run(async (client) => {
					const handle = client.agents.ref(input.agentId);
					await handle.refresh();
					resumeConfiguration(handle.current(), input);
					reloading = true;
					try {
						await reloadChecked(client, handle, input, preserveChildren);
					} catch (error) {
						// A connection-close failure cannot undo confirmed inactive state.
						if (error instanceof WindowOpenError && error.certainty === "not-opened") {
							reloading = false;
							rollback = error.nativeResumeRollback;
						}
						throw error;
					}
				});
			} catch (error) {
				if (error instanceof WindowOpenError) throw error;
				throw new WindowOpenError(
					error instanceof Error ? error.message : String(error),
					reloading ? "unknown" : "not-opened",
					rollback,
				);
			}
		},
	};
}
