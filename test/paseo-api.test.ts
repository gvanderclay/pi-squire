import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";
import { after, type TestContext, test } from "node:test";
import { DaemonClient, type FetchAgentsOptions } from "@getpaseo/client/internal/daemon-client";
import { createPaseoApi } from "../src/paseo-api.ts";

/** Throwaway homes under .scratch/tmp, removed when this file finishes. */
const DIRS: string[] = [];

after(() => {
	for (const dir of DIRS) rmSync(dir, { recursive: true, force: true });
});

/** An empty Paseo home: no pid file, so no daemon either. */
function emptyHome(): string {
	mkdirSync(".scratch/tmp", { recursive: true });
	const dir = mkdtempSync(join(process.cwd(), ".scratch/tmp/paseo-api-"));
	DIRS.push(dir);
	return dir;
}

/** A home whose pid file names a daemon at `listen`, with the credential the SDK transport reads. */
function daemonHome(listen = "127.0.0.1:1"): string {
	const home = emptyHome();
	writeFileSync(join(home, "paseo.pid"), JSON.stringify({ listen }));
	writeFileSync(join(home, "local-credential"), "test-credential");
	return home;
}

/** A loopback port nothing listens on, so connecting to it is refused at once. */
async function closedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

/** The reply type the SDK keeps for itself, read off the method that returns it. */
type AgentList = Awaited<ReturnType<DaemonClient["fetchAgents"]>>;
type AgentPage = { ids: string[]; hasMore: boolean; nextCursor?: string | null };

/** One `agents.list` reply with only the fields `live` reads. */
function agentPage({ ids, hasMore, nextCursor = null }: AgentPage): AgentList {
	return {
		entries: ids.map((id) => ({ agent: { id } })),
		pageInfo: { nextCursor, prevCursor: null, hasMore },
	} as unknown as AgentList;
}

test("a home with no daemon is refused by the pid file's name, without contacting anything", async () => {
	const home = emptyHome();
	const refusal = await createPaseoApi(home).unavailable();
	assert.ok(refusal !== undefined);
	assert.ok(refusal.includes(join(home, "paseo.pid")), refusal);
	assert.match(refusal, /Paseo is not running/);
});

test("live reads every page of labelled agents on one connection", async (t) => {
	const home = daemonHome();
	const requests: (FetchAgentsOptions | undefined)[] = [];
	let connects = 0;
	let closes = 0;
	t.mock.method(DaemonClient.prototype, "connect", async () => {
		connects++;
	});
	t.mock.method(DaemonClient.prototype, "close", async () => {
		closes++;
	});
	t.mock.method(DaemonClient.prototype, "fetchAgents", async (options?: FetchAgentsOptions) => {
		requests.push(options);
		return requests.length === 1
			? agentPage({ ids: ["agent-1", "agent-2"], hasMore: true, nextCursor: "page-2" })
			: agentPage({ ids: ["agent-3"], hasMore: false });
	});
	const live = await createPaseoApi(home).live();
	assert.deepEqual([...live].sort(), ["agent-1", "agent-2", "agent-3"], "an agent on the second page is live");
	assert.deepEqual(requests, [
		{ filter: { labels: { "pi-squire": "1" } }, page: { limit: 200 } },
		{ filter: { labels: { "pi-squire": "1" } }, page: { limit: 200, cursor: "page-2" } },
	]);
	assert.equal(connects, 1, "every page comes over one connection");
	assert.equal(closes, 1, "the connection closes after the listing");
});

test("live rejects rather than report a short set when a later page fails", async (t) => {
	const home = daemonHome();
	let pages = 0;
	let closes = 0;
	t.mock.method(DaemonClient.prototype, "connect", async () => {});
	t.mock.method(DaemonClient.prototype, "close", async () => {
		closes++;
	});
	t.mock.method(DaemonClient.prototype, "fetchAgents", async () => {
		pages++;
		if (pages === 1) return agentPage({ ids: ["agent-1"], hasMore: true, nextCursor: "page-2" });
		throw new Error("page two failed");
	});
	await assert.rejects(createPaseoApi(home).live(), /page two failed/);
	assert.equal(pages, 2);
	assert.equal(closes, 1, "the connection still closes");
});

test("live rejects when the daemon claims more agents and offers no cursor", async (t) => {
	const home = daemonHome();
	t.mock.method(DaemonClient.prototype, "connect", async () => {});
	t.mock.method(DaemonClient.prototype, "close", async () => {});
	t.mock.method(DaemonClient.prototype, "fetchAgents", async () => agentPage({ ids: ["agent-1"], hasMore: true }));
	await assert.rejects(createPaseoApi(home).live(), /more agents without a new cursor/);
});

test("live rejects a cursor it has already read instead of looping", async (t) => {
	const home = daemonHome();
	const cursors = ["page-2", "page-3", "page-2"];
	let reads = 0;
	t.mock.method(DaemonClient.prototype, "connect", async () => {});
	t.mock.method(DaemonClient.prototype, "close", async () => {});
	t.mock.method(DaemonClient.prototype, "fetchAgents", async () => {
		reads++;
		return agentPage({ ids: [`agent-${reads}`], hasMore: true, nextCursor: cursors[reads - 1] });
	});
	await assert.rejects(createPaseoApi(home).live(), /more agents without a new cursor/);
	assert.equal(reads, 3, "the cycle ends on the cursor it already read");
});

test("a connection the daemon never accepts is bounded, closed, and reported", async (t) => {
	const home = daemonHome();
	type Bounds = { connectTimeoutMs?: number; reconnect?: { enabled?: boolean } };
	let bounds: Bounds | undefined;
	let closes = 0;
	t.mock.method(DaemonClient.prototype, "connect", async function (this: DaemonClient) {
		// The SDK keeps its config private; this cast reads the wrapper's bound from it.
		bounds = (this as unknown as { config: Bounds }).config;
		throw new Error("daemon refused the connection");
	});
	t.mock.method(DaemonClient.prototype, "close", async () => {
		closes++;
	});
	await assert.rejects(createPaseoApi(home).live(), /daemon refused the connection/);
	assert.equal(closes, 1, "a client whose connect failed is still closed");
	assert.equal(bounds?.connectTimeoutMs, 10_000);
	assert.equal(bounds?.reconnect?.enabled, false, "a one-shot call must not wait on a reconnecting client");
});

test("a daemon that refuses the connection fails the call at once and is closed", async (t) => {
	const home = daemonHome(`127.0.0.1:${await closedPort()}`);
	let closes = 0;
	t.mock.method(DaemonClient.prototype, "close", async () => {
		closes++;
	});
	const started = Date.now();
	// Node's transport wording varies; prompt rejection and cleanup are the contract.
	await assert.rejects(createPaseoApi(home).live(), Error);
	assert.ok(Date.now() - started < 5_000, "a refused connection must not wait on a retry");
	assert.equal(closes, 1, "the client is closed after the connection fails");
});

/** Run Git in `cwd` with an identity of its own, so no user configuration is read. */
function git(cwd: string, ...args: string[]): void {
	childProcess.execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], {
		cwd,
		stdio: "ignore",
	});
}

/** A repository with one commit and a linked worktree beside it, as real paths. */
function repositoryWithWorktree(): { main: string; worktree: string } {
	const dir = realpathSync(emptyHome());
	const main = join(dir, "main");
	const worktree = join(dir, "linked");
	mkdirSync(main);
	git(main, "init", "-q", "-b", "main");
	git(main, "commit", "-q", "--allow-empty", "-m", "init");
	git(main, "worktree", "add", "-q", "-b", "linked", worktree);
	return { main, worktree };
}

type WorkspaceList = Awaited<ReturnType<DaemonClient["fetchWorkspaces"]>>;
type Placement = { opened: string[]; created: unknown[]; agents: unknown[] };
type OpenWorkspace = { id: string; workspaceDirectory: string; projectId: string };

/**
 * Create one agent in `cwd` against a daemon whose open workspaces are
 * `open` (folder to project id), and report how its workspace was reached.
 * The agent request itself fails, which ends the call once the workspace is chosen.
 */
async function placement(
	t: TestContext,
	cwd: string,
	open: Record<string, string> | OpenWorkspace[],
	concurrent = 1,
	archivedReceipt = false,
): Promise<Placement> {
	const seen: Placement = { opened: [], created: [], agents: [] };
	const workspace = { id: "wks_0000000000000000", workspaceDirectory: cwd };
	let registered = false;
	let listings = 0;
	const entries = Array.isArray(open)
		? open
		: Object.entries(open).map(([workspaceDirectory, projectId], index) => ({
				id: `workspace-${index}`,
				workspaceDirectory,
				projectId,
			}));
	t.mock.method(DaemonClient.prototype, "connect", async () => {});
	t.mock.method(DaemonClient.prototype, "close", async () => {});
	t.mock.method(
		DaemonClient.prototype,
		"fetchWorkspaces",
		async () =>
			({
				entries: [
					...(listings++ % 2 === 0 ? entries : [...entries].reverse()),
					...(registered ? [{ ...workspace, projectId: "prj_main" }] : []),
				],
				pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
			}) as unknown as WorkspaceList,
	);
	t.mock.method(DaemonClient.prototype, "openProject", async (path: string) => {
		seen.opened.push(path);
		return { workspace, error: null } as unknown as Awaited<ReturnType<DaemonClient["openProject"]>>;
	});
	t.mock.method(DaemonClient.prototype, "createWorkspace", async (options: unknown) => {
		seen.created.push(options);
		if (archivedReceipt && seen.created.length === 1) {
			return { workspace: { ...workspace, id: "wks_archived" }, error: null } as unknown as Awaited<
				ReturnType<DaemonClient["createWorkspace"]>
			>;
		}
		registered = true;
		return { workspace, error: null } as unknown as Awaited<ReturnType<DaemonClient["createWorkspace"]>>;
	});
	t.mock.method(DaemonClient.prototype, "createAgent", async (options: unknown) => {
		seen.agents.push(options);
		throw new Error("no agent in this test");
	});
	const input = {
		agentId: "agent-1",
		parentAgentId: "paseo-parent-agent",
		title: "t",
		cwd,
		model: "p/m",
		thinking: "off",
		systemPrompt: "",
		env: {},
	};
	await Promise.all(
		Array.from({ length: concurrent }, () =>
			assert.rejects(createPaseoApi(daemonHome()).create(input), /no agent in this test/),
		),
	);
	return seen;
}

test("a new worktree joins the project of its open main checkout", async (t) => {
	const { main, worktree } = repositoryWithWorktree();
	const seen = await placement(t, worktree, { [main]: "prj_main" });
	const { idempotencyKey, ...request } = seen.created[0] as Record<string, unknown>;
	assert.equal(typeof idempotencyKey, "string");
	assert.deepEqual(request, { source: { kind: "directory", path: worktree, projectId: "prj_main" } });
	assert.deepEqual(seen.opened, [], "a grouped create must not open a second project by directory");
});

test("concurrent first worktree launches use the same daemon idempotency key", async (t) => {
	const { main, worktree } = repositoryWithWorktree();
	const seen = await placement(t, worktree, { [main]: "prj_main" }, 2);
	assert.equal(seen.created.length, 2, "both launchers selected before either workspace was listed");
	const first = seen.created[0] as { idempotencyKey: string };
	assert.ok(first.idempotencyKey.length > 0);
	assert.deepEqual(seen.created[0], seen.created[1], "daemon admission receives the same key and intent");
});

test("concurrent selectors use one anchor when main-folder workspaces arrive in opposite activity order", async (t) => {
	const { main, worktree } = repositoryWithWorktree();
	const seen = await placement(
		t,
		worktree,
		[
			{ id: "wks_b", workspaceDirectory: main, projectId: "prj_main" },
			{ id: "wks_a", workspaceDirectory: main, projectId: "prj_main" },
		],
		2,
	);
	assert.equal(seen.created.length, 2);
	assert.deepEqual(seen.created[0], seen.created[1], "activity order cannot change the shared creation key");
});

test("an archived creation receipt gets a new shared operation without opening a separate project", async (t) => {
	const { main, worktree } = repositoryWithWorktree();
	const seen = await placement(t, worktree, { [main]: "prj_main" }, 1, true);
	assert.equal(seen.created.length, 2);
	const [first, second] = seen.created as { idempotencyKey: string; source: unknown }[];
	assert.notEqual(first.idempotencyKey, second.idempotencyKey);
	assert.deepEqual(first.source, second.source, "the new operation keeps the requested project and folder");
	assert.deepEqual(seen.opened, [], "directory-only open would register the worktree as a separate project");
});

test("a worktree Paseo already has a workspace for reuses it", async (t) => {
	const { main, worktree } = repositoryWithWorktree();
	const seen = await placement(t, worktree, { [main]: "prj_main", [worktree]: "prj_main" });
	assert.deepEqual(seen.opened, [worktree]);
	assert.deepEqual(seen.created, [], "create never reuses a workspace, so a second one would appear");
});

test("a worktree whose main checkout Paseo has not opened is opened by its folder", async (t) => {
	const { worktree } = repositoryWithWorktree();
	const seen = await placement(t, worktree, {});
	assert.deepEqual(seen.opened, [worktree]);
	assert.deepEqual(seen.created, []);
});

test("a main checkout and a folder outside Git are opened by their folder", async (t) => {
	const { main } = repositoryWithWorktree();
	const outside = realpathSync(emptyHome());
	assert.deepEqual((await placement(t, main, { [main]: "prj_main" })).opened, [main]);
	t.mock.restoreAll();
	const seen = await placement(t, outside, { [main]: "prj_main" });
	assert.deepEqual(seen.opened, [outside]);
	assert.deepEqual(seen.created, []);
});

test("a parent link is sent with explicit workspace and cwd, never implicit parent placement", async (t) => {
	const { main, worktree } = repositoryWithWorktree();
	const seen = await placement(t, worktree, { [main]: "prj_main" });
	assert.deepEqual(seen.agents, [
		{
			agentId: "agent-1",
			env: {},
			labels: { "pi-squire": "1" },
			callerAgentId: "paseo-parent-agent",
			workspaceId: "wks_0000000000000000",
			config: {
				provider: "pi",
				model: "p/m",
				thinkingOptionId: "off",
				systemPrompt: "",
				cwd: worktree,
				title: "t",
			},
		},
	]);
});

test("activity and remove ask the CLI for the same home the daemon was read from", async (t) => {
	const home = emptyHome();
	const calls: (readonly string[])[] = [];
	t.mock.method(
		childProcess,
		"execFile",
		(
			_file: string,
			args: readonly string[],
			_options: unknown,
			callback: (error: Error | null, stdout: string, stderr: string) => void,
		): void => {
			calls.push(args);
			callback(null, "", "");
		},
	);
	syncBuiltinESMExports();
	try {
		const api = createPaseoApi(home);
		await api.activity("agent-1");
		assert.equal(await api.remove("agent-1"), true);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	}
	assert.deepEqual(calls, [
		["--home", home, "logs", "agent-1", "--tail", "40"],
		["--home", home, "delete", "agent-1", "--json"],
	]);
});
