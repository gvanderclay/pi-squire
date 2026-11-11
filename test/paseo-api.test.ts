import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
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
	// The wording is the transport's; the timing is the wrapper's claim.
	await assert.rejects(createPaseoApi(home).live(), /Transport closed|refused/i);
	assert.ok(Date.now() - started < 5_000, "a refused connection must not wait on a retry");
	assert.equal(closes, 1, "the client is closed after the connection fails");
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
