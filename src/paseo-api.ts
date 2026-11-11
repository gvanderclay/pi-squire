// Paseo's daemon and CLI as pi-squire needs them. The SDK and the `paseo`
// command load only inside a call, so a tmux coordinator loads neither.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PaseoAgentHandle, PaseoClient, PaseoClientConfig } from "@getpaseo/client";

/** The label pi-squire puts on every agent it starts, so `live` sees its own. */
const LABELS = { "pi-squire": "1" };
/** How long `create` waits for the daemon to report the session id it chose. */
const SESSION_WAIT_MS = 10_000;
const SESSION_POLL_MS = 500;
/** How long one `paseo` CLI call may run. */
const CLI_TIMEOUT_MS = 10_000;

type CreateInput = {
	agentId: string;
	title: string;
	cwd: string;
	model: string;
	thinking: string;
	systemPrompt: string;
	env: Record<string, string>;
};

export type PaseoApi = {
	/** Refusal text when the daemon cannot be used, else undefined. */
	unavailable(): Promise<string | undefined>;
	create(input: CreateInput): Promise<{ sessionId: string }>;
	/** Agent ids that exist and are not archived. */
	live(): Promise<Set<string>>;
	activity(agentId: string): Promise<string>;
	/** Resolves false when the agent did not exist. */
	remove(agentId: string): Promise<boolean>;
};

const pidFile = (home: string): string => join(home, "paseo.pid");

/** The daemon's `listen` address, or undefined when the pid file is missing or names none. */
function daemonAddress(home: string): string | undefined {
	try {
		const pid: unknown = JSON.parse(readFileSync(pidFile(home), "utf8"));
		const listen = (pid as { listen?: unknown }).listen;
		return typeof listen === "string" && listen !== "" ? listen : undefined;
	} catch {
		return undefined;
	}
}

/** Refusal text naming the pid file that would hold the daemon's address. */
const notRunning = (home: string): string =>
	`Paseo is not running: ${pidFile(home)} is missing or has no daemon address`;

/** Connect to the daemon in `home` for one call; the caller closes the client. */
async function connect(home: string): Promise<PaseoClient> {
	const listen = daemonAddress(home);
	if (listen === undefined) throw new Error(notRunning(home));
	const { createPaseoClient } = await import("@getpaseo/client");
	// The daemon's local credential is not in the published config type
	// (0.15.4 dist/index.d.ts), but its transport reads this option.
	const config = {
		url: `ws://${listen}/ws`,
		localCredential: (): string => readFileSync(join(home, "local-credential"), "utf8").trim(),
	} as PaseoClientConfig;
	const client = createPaseoClient(config);
	await client.connect();
	return client;
}

async function withClient<T>(home: string, run: (client: PaseoClient) => Promise<T>): Promise<T> {
	const client = await connect(home);
	try {
		return await run(client);
	} finally {
		await client.close();
	}
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The Pi session id after one refresh, if the daemon has chosen it yet. */
async function refreshedSession(handle: PaseoAgentHandle): Promise<string | undefined> {
	await handle.refresh();
	const sessionId: unknown = handle.runtimeInfo?.sessionId;
	return typeof sessionId === "string" && sessionId !== "" ? sessionId : undefined;
}

/** The Pi session id Paseo chose; pi-squire cannot choose it, so it waits for the daemon. */
async function assignedSession(handle: PaseoAgentHandle): Promise<string> {
	const deadline = Date.now() + SESSION_WAIT_MS;
	let sessionId = await refreshedSession(handle);
	while (sessionId === undefined) {
		if (Date.now() >= deadline) {
			throw new Error(`Paseo did not report a session id for agent ${handle.id}`);
		}
		await wait(SESSION_POLL_MS);
		sessionId = await refreshedSession(handle);
	}
	return sessionId;
}

type CliRun = { stdout: string; stderr: string; failure: string | undefined };

/** Run the `paseo` CLI with no shell; a non-zero exit comes back for the caller to read. */
function runPaseo(args: readonly string[]): Promise<CliRun> {
	return new Promise((resolve) => {
		execFile("paseo", args, { encoding: "utf8", timeout: CLI_TIMEOUT_MS }, (error, stdout, stderr) => {
			resolve(error === null ? { stdout, stderr, failure: undefined } : { stdout, stderr, failure: error.message });
		});
	});
}

/** The Paseo daemon in `home`: `PASEO_HOME` or `~/.paseo` when none is given. */
export function createPaseoApi(home: string = process.env.PASEO_HOME ?? join(homedir(), ".paseo")): PaseoApi {
	return {
		async unavailable(): Promise<string | undefined> {
			return daemonAddress(home) === undefined ? notRunning(home) : undefined;
		},
		async create(input: CreateInput): Promise<{ sessionId: string }> {
			return withClient(home, async (client) => {
				// A plain agents.create registers a new workspace every time, so the
				// agent goes through its folder's existing one.
				const workspace = await client.workspaces.open(input.cwd);
				const handle = await workspace.agents.create({
					agentId: input.agentId,
					title: input.title,
					env: input.env,
					labels: LABELS,
					config: {
						provider: `pi/${input.model}`,
						thinkingOptionId: input.thinking,
						systemPrompt: input.systemPrompt,
					},
				});
				return { sessionId: await assignedSession(handle) };
			});
		},
		async live(): Promise<Set<string>> {
			return withClient(home, async (client) => {
				const { entries } = await client.agents.list({ filter: { labels: LABELS } });
				return new Set(entries.map((entry) => entry.agent.id));
			});
		},
		async activity(agentId: string): Promise<string> {
			const { stdout, stderr, failure } = await runPaseo(["logs", agentId, "--tail", "40"]);
			if (failure !== undefined) throw new Error(`paseo logs ${agentId} failed: ${stderr.trim() || failure}`);
			return stdout;
		},
		async remove(agentId: string): Promise<boolean> {
			const { stdout, stderr, failure } = await runPaseo(["delete", agentId, "--json"]);
			const output = `${stdout}\n${stderr}`;
			if (output.includes("No agent found matching")) return false;
			if (failure !== undefined) throw new Error(output.trim() || failure);
			return true;
		},
	};
}
