// Paseo's daemon and CLI as pi-squire needs them. The SDK and the `paseo`
// command load only inside a call, so a tmux coordinator loads neither.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type {
	PaseoAgentHandle,
	PaseoClient,
	PaseoClientConfig,
	PaseoWorkspace,
	PaseoWorkspaceHandle,
} from "@getpaseo/client";
import { inspectGit } from "./git.ts";
import {
	daemonAvailability,
	descriptor,
	type PaseoAvailability,
	probeDaemonAvailability,
} from "./paseo-availability.ts";

import { PASEO_TURN_COMMAND } from "./paseo-child.ts";
import type { PaseoReceipt } from "./worktree.ts";

export type { PaseoAvailability } from "./paseo-availability.ts";

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
	/** Positive absence is safe to skip only when there is no recorded workspace receipt. */
	availability(): Promise<PaseoAvailability>;
	/** SDK-free launch admission: refuse positive absence, leave other failures to create. */
	unavailable(): Promise<string | undefined>;
	create(input: CreateInput): Promise<{ sessionId: string; paseo: PaseoReceipt }>;
	workspace(id: string): Promise<PaseoWorkspace | null>;
	workspaceAt(dir: string): Promise<PaseoWorkspace[]>;
	agentsUsing(id: string, dir: string): Promise<string[]>;
	terminalsUsing(id: string, dir: string): Promise<string[]>;
	archiveWorkspace(id: string): Promise<void>;
	/** Agent ids that exist and are not archived. */
	live(): Promise<Set<string>>;
	activity(agentId: string): Promise<string>;
	/** Archive this exact Pi session, preserving public native children; false when completion was canceled. */
	archive(agentId: string, sessionId: string, eligible: () => boolean): Promise<boolean>;
	/** Resolves false when the agent did not exist. */
	remove(agentId: string): Promise<boolean>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// @getpaseo/protocol 0.15.4 dist/agent-labels.js: PARENT_AGENT_ID_LABEL.
// The declared client dependency does not re-export this protocol constant.
const PARENT_LABEL = "paseo.parent-agent-id";

/** A client for the daemon in `home`, not yet connected; the caller connects and closes it. */
async function clientFor(home: string): Promise<PaseoClient> {
	const address = descriptor(home);
	if ("state" in address) throw new Error(address.reason);
	const { listen } = address;
	const { createPaseoClient } = await import("@getpaseo/client");
	// The default browser transport cannot open Unix sockets. The installed
	// 0.15.4 node export supports them via createHostTransportFactory.
	const transportFactory =
		"path" in address ? (await import("@getpaseo/client/node")).createHostTransportFactory(address.path) : undefined;
	const config = {
		url: "path" in address ? "ws://host-connector/ws" : `ws://${listen}/ws`,
		...(transportFactory ? { transportFactory } : {}),
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

/**
 * Discover before detaching: detachment changes the directory and its cursors.
 * Paseo 0.15.4 agent-manager.js cascadeArchiveChildren archives same-workspace
 * native children, so Squire must detach them even when their tasks are done.
 * Private internal helpers are excluded by the daemon's public directory.
 */
async function nativeChildren(
	client: PaseoClient,
	agentId: string,
	eligible: () => boolean,
): Promise<Set<string> | undefined> {
	const children = new Set<string>();
	const seen = new Set<string>();
	let cursor: string | undefined;
	for (;;) {
		if (!eligible()) return undefined;
		const { entries, pageInfo } = await client.agents.list({
			filter: { labels: { [PARENT_LABEL]: agentId }, includeBackground: true },
			page: { limit: AGENT_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) },
		});
		for (const { agent } of entries) children.add(agent.id);
		if (!pageInfo.hasMore) break;
		const next = pageInfo.nextCursor ?? "";
		if (next === "" || seen.has(next))
			throw new Error("Paseo reported more children without a new cursor to read them");
		seen.add(next);
		cursor = next;
	}
	return children;
}

async function archiveChildren(client: PaseoClient, agentId: string, eligible: () => boolean): Promise<boolean> {
	const children = await nativeChildren(client, agentId, eligible);
	if (!children) return false;
	for (const id of children) {
		if (!eligible()) return false;
		if (!UUID.test(id) || id === agentId) throw new Error("Paseo reported an invalid child agent id");
		const child = client.agents.ref(id);
		await child.refresh();
		if (!eligible()) return false;
		const current = child.current();
		if (!current) throw new Error(`Paseo child ${id} could not be checked before archive`);
		if (!current.archivedAt && current.labels[PARENT_LABEL] === agentId) await child.detach();
	}
	return eligible();
}

async function archiveOnClient(
	client: PaseoClient,
	agentId: string,
	sessionId: string,
	eligible: () => boolean,
): Promise<boolean> {
	if (!eligible()) return false;
	const target = client.agents.ref(agentId);
	await target.refresh();
	if (!eligible()) return false;
	if (target.runtimeInfo?.sessionId !== sessionId || target.current()?.labels["pi-squire"] !== "1")
		throw new Error("Paseo archive refused: agent does not identify this Squire session");
	if (target.archivedAt) return true;
	if (!(await archiveChildren(client, agentId, eligible))) return false;
	if (!eligible()) return false;
	await target.archive();
	return true;
}

/** `path` with symlinks resolved, or as given when it cannot be read. */
function realPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function usesDirectory(entry: { workspaceId?: string | null; cwd: string }, id: string, dir: string): boolean {
	const path = realPath(entry.cwd);
	const root = realPath(dir);
	return entry.workspaceId === id || path === root || path.startsWith(`${root}${sep}`);
}

/** Open workspaces, with hidden entries only for cleanup or provenance, never placement. */
async function openWorkspaces(client: PaseoClient, includeHidden = false): Promise<PaseoWorkspace[]> {
	const found: PaseoWorkspace[] = [];
	const seen = new Set<string>();
	let cursor: string | undefined;
	for (;;) {
		const { entries, pageInfo } = await client.workspaces.list({
			...(includeHidden ? { filter: { includeInternal: true, includeBackground: true } } : {}),
			page: { limit: WORKSPACE_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) },
		});
		found.push(...entries);
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
async function workspaceFor(
	client: PaseoClient,
	cwd: string,
): Promise<{
	handle: PaseoWorkspaceHandle;
	provenance: PaseoReceipt["provenance"];
}> {
	// Provenance observes hidden workspaces too, but a failed observation must not
	// change placement or fail an otherwise supported launch. Never infer creation from it.
	const snapshot = (): Promise<PaseoWorkspace[] | undefined> => openWorkspaces(client, true).catch(() => undefined);
	const opened = async (): Promise<{ handle: PaseoWorkspaceHandle; provenance: PaseoReceipt["provenance"] }> => {
		const before = await snapshot();
		const handle = await client.workspaces.open(cwd);
		return {
			handle,
			provenance: before?.some((entry) => entry.id === handle.id) ? "reused" : "opened",
		};
	};
	const git = inspectGit(cwd);
	if (git.kind !== "git") return opened();
	const { mainRoot, checkoutRoot } = git.identity;
	if (checkoutRoot === mainRoot || realPath(cwd) !== checkoutRoot) return opened();
	const open = await openWorkspaces(client);
	// `open` reuses a folder's workspace; `create` never does (0.15.4
	// protocol messages.js, WorkspaceCreateRequestSchema).
	if (open.some((workspace) => workspace.workspaceDirectory && realPath(workspace.workspaceDirectory) === checkoutRoot))
		return opened();
	// Several workspaces can back the same folder, and activity reorders the
	// listing. All launchers must choose the same anchor for their shared key.
	const main = open
		.filter((workspace) => workspace.workspaceDirectory && realPath(workspace.workspaceDirectory) === mainRoot)
		.sort((a, b) => a.id.localeCompare(b.id))[0];
	if (main === undefined) return opened();
	// A shared daemon key arbitrates concurrent first launches; create alone
	// never deduplicates directories (0.15.4 CreationService, handleWorkspaceCreation).
	const key = createHash("sha256")
		.update(JSON.stringify([main.projectId, main.id, checkoutRoot]))
		.digest("hex");
	const before = await snapshot();
	const deadline = Date.now() + CONNECT_TIMEOUT_MS;
	for (let generation = 0; ; generation++) {
		const workspace = await client.workspaces.create({
			idempotencyKey: `pi-squire-worktree:${key}:${generation}`,
			source: { kind: "directory", path: checkoutRoot, projectId: main.projectId },
		});
		// CreationService replays completed receipts without reviving archived
		// workspaces (0.15.4). A new generation is a new placement operation;
		// concurrent callers still share its daemon-owned idempotency key.
		if ((await openWorkspaces(client)).some((entry) => entry.id === workspace.id))
			return {
				handle: workspace,
				provenance: before && !before.some((entry) => entry.id === workspace.id) ? "created" : "reused",
			};
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

async function createAgent(client: PaseoClient, home: string, input: CreateInput): ReturnType<PaseoApi["create"]> {
	// A plain agents.create registers a new workspace every time, so the
	// agent goes through its folder's own.
	const { handle: workspace, provenance } = await workspaceFor(client, input.cwd);
	if (!workspace.directory || !workspace.projectId) throw new Error("Paseo workspace placement is incomplete");
	const paseo: PaseoReceipt = {
		home,
		workspaceId: workspace.id,
		directory: realPath(workspace.directory),
		projectId: workspace.projectId,
		provenance,
	};
	const handle = await workspace.agents.create({
		agentId: input.agentId,
		title: input.title,
		env: input.env,
		// Keep the native parent link without callerAgentId: Paseo 0.15.4
		// otherwise wraps the initial slash command as an agent-message,
		// bypassing Pi command dispatch and sending it to the model.
		// resolveCreateAgentIntent retains explicit parent labels.
		labels: { ...LABELS, [PARENT_LABEL]: input.parentAgentId },
		prompt: `/${PASEO_TURN_COMMAND}`,
		config: {
			provider: `pi/${input.model}`,
			thinkingOptionId: input.thinking,
			systemPrompt: input.systemPrompt,
		},
	});
	return { sessionId: await assignedSession(handle), paseo };
}

async function agentsUsing(client: PaseoClient, id: string, dir: string): Promise<string[]> {
	const users: string[] = [];
	const seen = new Set<string>();
	let cursor: string | undefined;
	for (;;) {
		const { entries, pageInfo } = await client.agents.list({
			filter: { includeInternal: true, includeBackground: true, includeArchived: false },
			page: { limit: AGENT_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) },
		});
		for (const { agent } of entries) if (usesDirectory(agent, id, dir)) users.push(agent.id);
		if (!pageInfo.hasMore) return users;
		const next = pageInfo.nextCursor ?? "";
		if (!next || seen.has(next)) throw new Error("Paseo reported more agents without a new cursor");
		seen.add(next);
		cursor = next;
	}
}

/** The Paseo daemon in `home`: `PASEO_HOME` or `~/.paseo` when none is given. */
export function createPaseoApi(homeInput: string = process.env.PASEO_HOME ?? join(homedir(), ".paseo")): PaseoApi {
	// A receipt must keep addressing this daemon when restored from another cwd.
	const home = realPath(resolve(homeInput));
	return {
		availability: () => daemonAvailability(home, () => withClient(home, async () => {})),
		async unavailable(): Promise<string | undefined> {
			const result = await probeDaemonAvailability(home, false);
			return result.state === "absent" ? result.reason : undefined;
		},
		async create(input: CreateInput): ReturnType<PaseoApi["create"]> {
			return withClient(home, (client) => createAgent(client, home, input));
		},
		async workspace(id: string): Promise<PaseoWorkspace | null> {
			return withClient(
				home,
				async (client) => (await openWorkspaces(client, true)).find((entry) => entry.id === id) ?? null,
			);
		},
		async workspaceAt(dir: string): Promise<PaseoWorkspace[]> {
			return withClient(home, async (client) =>
				(await openWorkspaces(client, true)).filter(
					(entry) => entry.workspaceDirectory !== undefined && realPath(entry.workspaceDirectory) === realPath(dir),
				),
			);
		},
		async agentsUsing(id: string, dir: string): Promise<string[]> {
			return withClient(home, (client) => agentsUsing(client, id, dir));
		},
		async terminalsUsing(id: string, dir: string): Promise<string[]> {
			return withClient(home, async (client) =>
				(await client.terminals.list()).entries
					.filter((entry) => usesDirectory(entry, id, dir))
					.map((entry) => entry.id),
			);
		},
		async archiveWorkspace(id: string): Promise<void> {
			await withClient(home, async (client) => {
				const result = await client.workspaces.archive(id);
				if (result.error) throw new Error(result.error);
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
		async archive(agentId: string, sessionId: string, eligible: () => boolean): Promise<boolean> {
			if (!UUID.test(agentId)) throw new Error("Paseo archive requires a UUID agent id");
			if (!eligible()) return false;
			return withClient(home, (client) => archiveOnClient(client, agentId, sessionId, eligible));
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
