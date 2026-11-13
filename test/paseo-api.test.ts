import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
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

const ARCHIVE_AGENT = "f3a5d640-238e-4ba5-9730-cf15599c7704";
const CHILD_AGENT = "ea354d94-760b-4ef4-a93f-b33f64248688";
const OTHER_CHILD = "d303b3ac-dd20-4847-b96d-586a6b64cc40";
// Resolve the SDK's own protocol dependency, independently of Squire's literal.
const protocolLabels = await import(
	createRequire(import.meta.resolve("@getpaseo/client")).resolve("@getpaseo/protocol/agent-labels")
);
const PARENT_LABEL: string = protocolLabels.PARENT_AGENT_ID_LABEL;

/** Real SDK handles over a fake transport; no CLI or daemon is reached. */
function archiveWire(t: TestContext) {
	const calls: string[] = [];
	const agents = new Map<string, { id: string; labels: Record<string, string>; runtimeInfo: { sessionId: string } }>([
		[ARCHIVE_AGENT, { id: ARCHIVE_AGENT, labels: { "pi-squire": "1" }, runtimeInfo: { sessionId: "own-session" } }],
		[
			CHILD_AGENT,
			{ id: CHILD_AGENT, labels: { [PARENT_LABEL]: ARCHIVE_AGENT }, runtimeInfo: { sessionId: "kept-child" } },
		],
		[
			OTHER_CHILD,
			{ id: OTHER_CHILD, labels: { [PARENT_LABEL]: ARCHIVE_AGENT }, runtimeInfo: { sessionId: "other-child" } },
		],
	]);
	t.mock.method(DaemonClient.prototype, "connect", async () => {
		calls.push("connect");
	});
	t.mock.method(DaemonClient.prototype, "close", async () => {
		calls.push("close");
	});
	t.mock.method(DaemonClient.prototype, "fetchAgent", async (input: { agentId: string }) => {
		calls.push(`refresh:${input.agentId}`);
		const agent = agents.get(input.agentId);
		return agent ? { agent } : null;
	});
	t.mock.method(DaemonClient.prototype, "detachAgent", async (id: string) => {
		calls.push(`detach:${id}`);
		const agent = agents.get(id);
		if (agent) agent.labels = {};
	});
	t.mock.method(DaemonClient.prototype, "archiveAgent", async (id: string) => {
		calls.push(`archive:${id}`);
		// Model the native cascade: any still-linked child would be lost.
		for (const [key, agent] of agents) if (agent.labels[PARENT_LABEL] === id) agents.delete(key);
		return { archivedAt: "2026-01-01T00:00:00Z" };
	});
	return { calls, agents, api: createPaseoApi(daemonHome()) };
}

test("archive protects all direct children across pages, including unlabelled background agents", async (t) => {
	const wire = archiveWire(t);
	const requests: (FetchAgentsOptions | undefined)[] = [];
	t.mock.method(DaemonClient.prototype, "fetchAgents", async (options?: FetchAgentsOptions) => {
		requests.push(options);
		// The native directory returns no children for a misspelled parent-label key.
		if (options?.filter?.labels?.[PARENT_LABEL] !== ARCHIVE_AGENT) return agentPage({ ids: [], hasMore: false });
		const ids = requests.length === 1 ? [CHILD_AGENT] : [OTHER_CHILD];
		const page = agentPage({ ids, hasMore: requests.length === 1, nextCursor: "page-2" });
		page.entries = ids.map((id) => ({ agent: wire.agents.get(id) })) as unknown as AgentList["entries"];
		return page;
	});
	assert.equal(await wire.api.archive(ARCHIVE_AGENT, "own-session", () => true), true);
	assert.deepEqual(requests, [
		{ filter: { labels: { [PARENT_LABEL]: ARCHIVE_AGENT }, includeBackground: true }, page: { limit: 200 } },
		{
			filter: { labels: { [PARENT_LABEL]: ARCHIVE_AGENT }, includeBackground: true },
			page: { limit: 200, cursor: "page-2" },
		},
	]);
	assert.deepEqual(
		wire.calls.filter((call) => call.startsWith("detach:")),
		[`detach:${CHILD_AGENT}`, `detach:${OTHER_CHILD}`],
	);
	assert.ok(wire.calls.indexOf(`detach:${OTHER_CHILD}`) < wire.calls.indexOf(`archive:${ARCHIVE_AGENT}`));
	assert.equal(wire.calls.at(-1), "close");
	assert.equal(wire.agents.get(CHILD_AGENT)?.runtimeInfo.sessionId, "kept-child");
	assert.equal(wire.agents.get(OTHER_CHILD)?.runtimeInfo.sessionId, "other-child");
});

for (const failure of ["list", "detach", "archive", "cursor", "connect"] as const) {
	test(`archive closes its connection and fails closed on ${failure} failure`, async (t) => {
		const wire = archiveWire(t);
		t.mock.method(DaemonClient.prototype, "fetchAgents", async () => {
			if (failure === "list") throw new Error("list failed");
			return {
				...agentPage({ ids: [], hasMore: failure === "cursor" }),
				entries: [{ agent: wire.agents.get(CHILD_AGENT) }],
			} as unknown as AgentList;
		});
		if (failure === "connect")
			t.mock.method(DaemonClient.prototype, "connect", async () => {
				throw new Error("connect failed");
			});
		if (failure === "detach")
			t.mock.method(DaemonClient.prototype, "detachAgent", async () => {
				throw new Error("detach failed");
			});
		if (failure === "archive")
			t.mock.method(DaemonClient.prototype, "archiveAgent", async () => {
				throw new Error("archive failed");
			});
		await assert.rejects(
			wire.api.archive(ARCHIVE_AGENT, "own-session", () => true),
			failure === "cursor" ? /without a new cursor/ : new RegExp(`${failure} failed`),
		);
		assert.equal(wire.calls.at(-1), "close");
		assert.ok(!wire.calls.includes(`archive:${ARCHIVE_AGENT}`));
		assert.ok(wire.agents.has(CHILD_AGENT));
	});
}

test("archive validates the UUID, exact Pi session and Squire label before any mutation", async (t) => {
	const wire = archiveWire(t);
	await assert.rejects(
		wire.api.archive("inherited", "own-session", () => true),
		/agent id/,
	);
	assert.equal(wire.calls.length, 0);
	await assert.rejects(
		wire.api.archive(ARCHIVE_AGENT, "different-session", () => true),
		/session/,
	);
	assert.ok(!wire.calls.some((call) => call.startsWith("archive:")));
	const target = wire.agents.get(ARCHIVE_AGENT);
	assert.ok(target);
	target.labels = {};
	await assert.rejects(
		wire.api.archive(ARCHIVE_AGENT, "own-session", () => true),
		/session/,
	);
	wire.agents.delete(ARCHIVE_AGENT);
	await assert.rejects(
		wire.api.archive(ARCHIVE_AGENT, "own-session", () => true),
		/session/,
	);
});

test("archive discovers every page before any detach and rejects a failed later page or cursor cycle", async (t) => {
	const wire = archiveWire(t);
	for (const cycle of [false, true]) {
		let pages = 0;
		t.mock.method(DaemonClient.prototype, "fetchAgents", async () => {
			if (++pages > 1 && !cycle) throw new Error("later page failed");
			return {
				...agentPage({ ids: [], hasMore: true, nextCursor: "repeated-page" }),
				entries: [{ agent: wire.agents.get(CHILD_AGENT) }],
			} as unknown as AgentList;
		});
		await assert.rejects(
			wire.api.archive(ARCHIVE_AGENT, "own-session", () => true),
			cycle ? /without a new cursor/ : /later page failed/,
		);
		assert.equal(pages, 2);
		assert.ok(!wire.calls.some((call) => call.startsWith("detach:") || call.startsWith("archive:")));
	}
});

test("archive leaves a child that was reparented during discovery alone", async (t) => {
	const wire = archiveWire(t);
	t.mock.method(DaemonClient.prototype, "fetchAgents", async () => {
		const child = wire.agents.get(CHILD_AGENT);
		assert.ok(child);
		child.labels[PARENT_LABEL] = "another-parent";
		return {
			...agentPage({ ids: [], hasMore: false }),
			entries: [{ agent: child }],
		} as unknown as AgentList;
	});
	assert.equal(await wire.api.archive(ARCHIVE_AGENT, "own-session", () => true), true);
	assert.ok(!wire.calls.includes(`detach:${CHILD_AGENT}`));
	assert.ok(wire.agents.has(CHILD_AGENT));
});

for (const phase of ["connect", "list", "detach"] as const) {
	test(`archive revalidates completion after asynchronous ${phase}`, async (t) => {
		const wire = archiveWire(t);
		let eligible = true;
		t.mock.method(DaemonClient.prototype, "fetchAgents", async () => {
			if (phase === "list") eligible = false;
			return {
				...agentPage({ ids: [], hasMore: false }),
				entries: [{ agent: wire.agents.get(CHILD_AGENT) }],
			} as unknown as AgentList;
		});
		if (phase === "connect")
			t.mock.method(DaemonClient.prototype, "connect", async () => {
				eligible = false;
			});
		if (phase === "detach")
			t.mock.method(DaemonClient.prototype, "detachAgent", async () => {
				eligible = false;
			});
		assert.equal(await wire.api.archive(ARCHIVE_AGENT, "own-session", () => eligible), false);
		assert.ok(!wire.calls.includes(`archive:${ARCHIVE_AGENT}`));
		assert.equal(wire.calls.at(-1), "close");
	});
}

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
