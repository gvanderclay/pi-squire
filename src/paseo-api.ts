// Paseo's daemon and CLI as pi-squire needs them. The SDK and the `paseo`
// command load only inside a call, so a tmux coordinator loads neither.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PaseoAgentHandle, PaseoClient, PaseoClientConfig, PaseoWorkspaceHandle } from "@getpaseo/client";
import { inspectGit } from "./git.ts";

/** The label pi-squire puts on every agent it starts, so `live` sees its own. */
const LABELS = { "pi-squire": "1" };
/** How long one call waits for the daemon to accept the connection. */
const CONNECT_TIMEOUT_MS = 10_000;
/** How long `create` waits for the daemon to report the session id it chose. */
const SESSION_WAIT_MS = 10_000;
const SESSION_POLL_MS = 500;
/** How long one `paseo` CLI call may run. */
const CLI_TIMEOUT_MS = 10_000;
/** The daemon's own default page size for `agents.list`. */
const AGENT_PAGE_SIZE = 200;
/** The most workspaces the daemon returns in one `workspaces.list` page. */
const WORKSPACE_PAGE_SIZE = 200;

type CreateInput = {
	agentId: string;
	parentAgentId: string;
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

/** A client for the daemon in `home`, not yet connected; the caller connects and closes it. */
async function clientFor(home: string): Promise<PaseoClient> {
	const listen = daemonAddress(home);
	if (listen === undefined) throw new Error(notRunning(home));
	const { createPaseoClient } = await import("@getpaseo/client");
	const config = {
		url: `ws://${listen}/ws`,
		connectTimeoutMs: CONNECT_TIMEOUT_MS,
		// One call owns one connection, so a daemon that drops must fail the call:
		// reconnect would leave `connect` waiting on a daemon that is gone.
		reconnect: { enabled: false },
		// The daemon's local credential is not in the published config type
		// (0.15.4 dist/index.d.ts), but its transport reads this option.
		localCredential: (): string => readFileSync(join(home, "local-credential"), "utf8").trim(),
	} as PaseoClientConfig;
	return createPaseoClient(config);
}

async function withClient<T>(home: string, run: (client: PaseoClient) => Promise<T>): Promise<T> {
	const client = await clientFor(home);
	try {
		await client.connect();
		return await run(client);
	} finally {
		await client.close();
	}
}

/** Every labelled agent id, one page at a time over `client`. */
async function listLive(client: PaseoClient): Promise<Set<string>> {
	const live = new Set<string>();
	const seen = new Set<string>();
	let cursor: string | undefined;
	for (;;) {
		const { entries, pageInfo } = await client.agents.list({
			filter: { labels: LABELS },
			page: { limit: AGENT_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) },
		});
		for (const entry of entries) live.add(entry.agent.id);
		if (!pageInfo.hasMore) return live;
		const next = pageInfo.nextCursor ?? "";
		// A cursor already read cannot advance the listing, so waiting for it to
		// end would hang. A short set of agents reads as agents that are gone.
		if (next === "" || seen.has(next)) {
			throw new Error("Paseo reported more agents without a new cursor to read them");
		}
		seen.add(next);
		cursor = next;
	}
}

/** `path` with symlinks resolved, or as given when it cannot be read. */
function realPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** Each open workspace's folder and project, one page at a time over `client`. */
async function openWorkspaces(client: PaseoClient): Promise<{ id: string; directory: string; projectId: string }[]> {
	const found: { id: string; directory: string; projectId: string }[] = [];
	const seen = new Set<string>();
	let cursor: string | undefined;
	for (;;) {
		const { entries, pageInfo } = await client.workspaces.list({
			page: { limit: WORKSPACE_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) },
		});
		for (const entry of entries) {
			found.push({ id: entry.id, directory: realPath(entry.workspaceDirectory), projectId: entry.projectId });
		}
		if (!pageInfo.hasMore) return found;
		const next = pageInfo.nextCursor ?? "";
		if (next === "" || seen.has(next)) {
			throw new Error("Paseo reported more workspaces without a new cursor to read them");
		}
		seen.add(next);
		cursor = next;
	}
}

/**
 * The workspace a delegate in `cwd` belongs to. Opening a folder Paseo has
 * not seen registers it as a project of its own, so a linked worktree would
 * sit apart from its repository. When Paseo has the main checkout open, a new
 * worktree joins that project.
 */
async function workspaceFor(client: PaseoClient, cwd: string): Promise<PaseoWorkspaceHandle> {
	const git = inspectGit(cwd);
	if (git.kind !== "git") return client.workspaces.open(cwd);
	const { mainRoot, checkoutRoot } = git.identity;
	if (checkoutRoot === mainRoot || realPath(cwd) !== checkoutRoot) return client.workspaces.open(cwd);
	const open = await openWorkspaces(client);
	// `open` reuses a folder's workspace; `create` never does (0.15.4
	// protocol messages.js, WorkspaceCreateRequestSchema).
	if (open.some((workspace) => workspace.directory === checkoutRoot)) return client.workspaces.open(cwd);
	// Several workspaces can back the same folder, and activity reorders the
	// listing. All launchers must choose the same anchor for their shared key.
	const main = open.filter((workspace) => workspace.directory === mainRoot).sort((a, b) => a.id.localeCompare(b.id))[0];
	if (main === undefined) return client.workspaces.open(cwd);
	// A shared daemon key arbitrates concurrent first launches; create alone
	// never deduplicates directories (0.15.4 CreationService, handleWorkspaceCreation).
	const key = createHash("sha256")
		.update(JSON.stringify([main.projectId, main.id, checkoutRoot]))
		.digest("hex");
	const deadline = Date.now() + CONNECT_TIMEOUT_MS;
	for (let generation = 0; ; generation++) {
		const workspace = await client.workspaces.create({
			idempotencyKey: `pi-squire-worktree:${key}:${generation}`,
			source: { kind: "directory", path: checkoutRoot, projectId: main.projectId },
		});
		// CreationService replays completed receipts without reviving archived
		// workspaces (0.15.4). A new generation is a new placement operation;
		// concurrent callers still share its daemon-owned idempotency key.
		if ((await openWorkspaces(client)).some((entry) => entry.id === workspace.id)) return workspace;
		if (Date.now() >= deadline) throw new Error("Paseo did not provide an active worktree workspace");
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

/** Run the `paseo` CLI against the daemon in `home`; a non-zero exit comes back for the caller to read. */
function runPaseo(home: string, args: readonly string[]): Promise<CliRun> {
	return new Promise((resolve) => {
		execFile(
			"paseo",
			["--home", home, ...args],
			{ encoding: "utf8", timeout: CLI_TIMEOUT_MS },
			(error, stdout, stderr) => {
				resolve(error === null ? { stdout, stderr, failure: undefined } : { stdout, stderr, failure: error.message });
			},
		);
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
				// agent goes through its folder's own.
				const workspace = await workspaceFor(client, input.cwd);
				const handle = await workspace.agents.create({
					agentId: input.agentId,
					parent: input.parentAgentId,
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
			return withClient(home, listLive);
		},
		async activity(agentId: string): Promise<string> {
			const { stdout, stderr, failure } = await runPaseo(home, ["logs", agentId, "--tail", "40"]);
			if (failure !== undefined) throw new Error(`paseo logs ${agentId} failed: ${stderr.trim() || failure}`);
			return stdout;
		},
		async remove(agentId: string): Promise<boolean> {
			const { stdout, stderr, failure } = await runPaseo(home, ["delete", agentId, "--json"]);
			const output = `${stdout}\n${stderr}`;
			if (output.includes("No agent found matching")) return false;
			if (failure !== undefined) throw new Error(output.trim() || failure);
			return true;
		},
	};
}
