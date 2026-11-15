import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createRequire, registerHooks, syncBuiltinESMExports } from "node:module";
import { createServer, type Socket } from "node:net";
import { hostname } from "node:os";
import { join } from "node:path";
import { after, type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createHostAdmission } from "../src/host-admission.ts";
import { createPaseoHost } from "../src/paseo.ts";
import { createPaseoApi } from "../src/paseo-api.ts";
import { daemonAvailability } from "../src/paseo-availability.ts";

const dirs: string[] = [];
function home(value?: unknown): string {
	mkdirSync(".scratch/tmp", { recursive: true });
	const dir = mkdtempSync(join(process.cwd(), ".scratch/tmp/paseo-availability-"));
	dirs.push(dir);
	if (value !== undefined) writeFileSync(join(dir, "paseo.pid"), JSON.stringify(value));
	writeFileSync(join(dir, "local-credential"), "test");
	return dir;
}
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
async function listening() {
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	return {
		listen: `127.0.0.1:${address.port}`,
		close: async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

test("missing and dead-pid descriptors are positively absent without importing the SDK", async () => {
	const homes = [home(), home({ pid: 2147483647, listen: "127.0.0.1:1" }), home({ pid: 2147483647, listen: null })];
	const hooks = registerHooks({
		resolve(specifier, context, next) {
			if (specifier.startsWith("@getpaseo/client")) throw new Error("SDK imported on absent fast path");
			return next(specifier, context);
		},
	});
	try {
		for (const dir of homes) {
			const state = await createPaseoApi(dir).availability();
			assert.equal(state.state, "absent");
			assert.match((await createPaseoApi(dir).unavailable()) ?? "", /Paseo is not running/);
		}
	} finally {
		hooks.deregister();
	}
});
test("malformed or unreadable descriptors are ambiguous, not proof of absence", async () => {
	for (const value of [null, [], {}, { listen: "" }, { listen: "nonsense" }, { pid: -1, listen: "127.0.0.1:1" }]) {
		const state = await createPaseoApi(home(value)).availability();
		assert.equal(state.state, "ambiguous", JSON.stringify(value));
	}
	const dir = home();
	writeFileSync(join(dir, "paseo.pid"), "{");
	assert.equal((await createPaseoApi(dir).availability()).state, "ambiguous");
	rmSync(join(dir, "paseo.pid"));
	mkdirSync(join(dir, "paseo.pid"));
	const state = await createPaseoApi(dir).availability();
	assert.equal(state.state, "ambiguous");
	assert.ok("reason" in state && state.reason.includes("unreadable"));
});
test("an unpublished address with a live pid remains ambiguous, including EPERM", async (t) => {
	const dir = home({ pid: process.pid, listen: null });
	for (const permission of ["allowed", "EPERM"]) {
		if (permission === "EPERM")
			t.mock.method(process, "kill", () => {
				throw Object.assign(new Error("not permitted"), { code: "EPERM" });
			});
		const state = await createPaseoApi(dir).availability();
		assert.equal(state.state, "ambiguous");
		assert.ok("reason" in state && state.reason.includes("no published address"));
	}
	assert.equal((await createPaseoApi(home({ pid: -1, listen: null })).availability()).state, "ambiguous");
});
test("refused port is absent even with a live or missing pid, without importing the SDK", async () => {
	const server = await listening();
	await server.close();
	const hooks = registerHooks({
		resolve(specifier, context, next) {
			if (specifier.startsWith("@getpaseo/client")) throw new Error("SDK imported on refused port");
			return next(specifier, context);
		},
	});
	try {
		for (const pid of [process.pid, undefined]) {
			const state = await createPaseoApi(home({ listen: server.listen, pid })).availability();
			assert.equal(state.state, "absent");
			assert.ok("reason" in state && state.reason.includes("refused"));
		}
	} finally {
		hooks.deregister();
	}
});
test("live socket still requires authenticated SDK connection, and every retry re-probes", async (t) => {
	const server = await listening();
	const api = createPaseoApi(home({ pid: process.pid, listen: server.listen }));
	let failure: string | undefined;
	let closes = 0;
	t.mock.method(DaemonClient.prototype, "connect", async () => {
		if (failure) throw new Error(failure);
	});
	t.mock.method(DaemonClient.prototype, "close", async () => {
		closes++;
	});
	try {
		assert.deepEqual(await api.availability(), { state: "available" });
		assert.equal(await api.unavailable(), undefined);
		for (const reason of ["Authentication failed: invalid local credential", "Connection timed out"]) {
			failure = reason;
			const state = await api.availability();
			assert.equal(state.state, "ambiguous");
			assert.ok("reason" in state && state.reason.includes(reason));
		}
		failure = undefined;
		assert.deepEqual(await api.availability(), { state: "available" });
		assert.equal(closes, 4, "failed connections are also closed; admission makes no SDK connection");
	} finally {
		await server.close();
	}
	assert.equal((await api.availability()).state, "absent", "success must not cache availability");
});
test("real SDK hello accepts an available fake daemon and preserves authentication rejection as ambiguous", async (t) => {
	// Use the SDK's installed ws dependency; Squire does not add a test/runtime dependency.
	const { WebSocketServer } = createRequire(import.meta.resolve("@getpaseo/client"))("ws");
	const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
	await new Promise<void>((resolve) => server.once("listening", resolve));
	let rejectAuth = false;
	type Peer = {
		once(event: "message", listener: () => void): void;
		send(data: string): void;
		close(code: number, reason: string): void;
	};
	server.on("connection", (socket: Peer) => {
		socket.once("message", () => {
			if (rejectAuth) {
				socket.send(JSON.stringify({ type: "hello.rejected", reason: "incorrect_password", accepts: ["password"] }));
				socket.close(1008, "Incorrect password");
			} else {
				socket.send(
					JSON.stringify({
						type: "session",
						message: { type: "status", payload: { status: "server_info", serverId: "fake-daemon" } },
					}),
				);
			}
		});
	});
	const dirForApi = home({ pid: process.pid, listen: `127.0.0.1:${server.address().port}` });
	const api = createPaseoApi(dirForApi);
	try {
		assert.deepEqual(await api.availability(), { state: "available" });
		rejectAuth = true;
		const state = await api.availability();
		assert.equal(state.state, "ambiguous");
		assert.ok("reason" in state && /incorrect password/i.test(state.reason), JSON.stringify(state));
		rejectAuth = false;
		assert.deepEqual(await api.availability(), { state: "available" }, "retry after authentication repair");
		await unverifiedConnections(t, api, dirForApi, `127.0.0.1:${server.address().port}`);
	} finally {
		await new Promise<void>((resolve) => server.close(resolve));
	}
});
test("a live pid with EPERM still requires a socket probe", async (t) => {
	t.mock.method(process, "kill", () => {
		throw Object.assign(new Error("not permitted"), { code: "EPERM" });
	});
	const server = await listening();
	await server.close();
	const state = await createPaseoApi(home({ pid: process.pid, listen: server.listen })).availability();
	assert.equal(state.state, "absent");
	assert.ok("reason" in state && state.reason.includes("refused"));
});
test("launch admission never imports or connects the SDK for absent or accepting daemons", async (t) => {
	const server = await listening();
	let connects = 0;
	let imports = 0;
	t.mock.method(DaemonClient.prototype, "connect", async () => {
		connects++;
	});
	const hooks = registerHooks({
		resolve(specifier, context, next) {
			if (specifier.startsWith("@getpaseo/client")) {
				imports++;
				throw new Error("SDK imported during admission");
			}
			return next(specifier, context);
		},
	});
	try {
		for (const value of [
			undefined,
			{ pid: 2147483647, listen: server.listen },
			{ pid: process.pid, listen: server.listen },
		]) {
			const host = createPaseoHost(createPaseoApi(home(value)), { PASEO_AGENT_ID: "parent" });
			const admission = createHostAdmission(host, () => {
				throw new Error("terminal setting read");
			});
			if (!value || value.pid !== process.pid) await assert.rejects(admission.admit(), /Paseo is not running/);
			else assert.equal((await admission.admit()).client, host);
			assert.equal(connects, 0);
			assert.equal(imports, 0, "even a caught import failure violates cheap admission");
		}
		await server.close();
		const refused = createPaseoHost(createPaseoApi(home({ pid: process.pid, listen: server.listen })), {
			PASEO_AGENT_ID: "parent",
		});
		await assert.rejects(
			createHostAdmission(refused, () => {
				throw new Error("terminal setting read");
			}).admit(),
			/connection refused/,
		);
		assert.equal(connects, 0);
		assert.equal(imports, 0);
	} finally {
		hooks.deregister();
		if (server) await server.close();
	}
});

test("ambiguous launch descriptors proceed without SDK or host-identity subprocesses", async (t) => {
	const run = t.mock.method(childProcess, "execFileSync", () => {
		throw new Error("subprocess in admission");
	});
	syncBuiltinESMExports();
	try {
		for (const value of [{ pid: 2147483647, hostname: "other-machine", listen: null }, { listen: "malformed" }]) {
			assert.equal(await createPaseoApi(home(value)).unavailable(), undefined);
		}
		assert.equal(run.mock.callCount(), 0);
	} finally {
		run.mock.restore();
		syncBuiltinESMExports();
	}
});

async function unverifiedConnections(
	t: TestContext,
	api: ReturnType<typeof createPaseoApi>,
	dir: string,
	listen: string,
) {
	writeFileSync(join(dir, "paseo.pid"), JSON.stringify({ pid: 2147483647, hostname: "other-machine", listen }));
	assert.equal((await api.availability()).state, "ambiguous", "cleanup must still fail closed");
	t.mock.method(DaemonClient.prototype, "fetchWorkspaces", async () => {
		throw new Error("listing reached after authentication with unverified pid");
	});
	t.mock.method(DaemonClient.prototype, "openProject", async () => {
		throw new Error("creation reached after authentication with unverified pid");
	});
	await assert.rejects(api.workspaceAt(dir), /listing reached after authentication with unverified pid/);
	await assert.rejects(
		api.create({
			agentId: "test",
			parentAgentId: "parent",
			title: "test",
			cwd: dir,
			model: "test/model",
			thinking: "low",
			systemPrompt: "",
			env: {},
		}),
		/creation reached after authentication with unverified pid/,
	);
}

test("dead-pid admission probes named-host descriptors without SDK or identity subprocesses", async (t) => {
	const server = await listening();
	let imports = 0;
	const run = t.mock.method(childProcess, "execFileSync", () => {
		throw new Error("identity subprocess in admission");
	});
	syncBuiltinESMExports();
	const hooks = registerHooks({
		resolve(specifier, context, next) {
			if (specifier.startsWith("@getpaseo/client")) {
				imports++;
				throw new Error("SDK imported during admission");
			}
			return next(specifier, context);
		},
	});
	try {
		const api = createPaseoApi(home({ pid: 2147483647, hostname: "other-machine", listen: server.listen }));
		assert.equal(await api.unavailable(), undefined, "accepting daemon gets to authenticate at creation");
		await server.close();
		assert.match((await api.unavailable()) ?? "", /connection refused/, "refusal proves absence without pid identity");
		assert.equal(run.mock.callCount(), 0);
		assert.equal(imports, 0, "even a caught SDK failure violates cheap admission");
	} finally {
		hooks.deregister();
		run.mock.restore();
		syncBuiltinESMExports();
		await server.close();
	}
});

test("fresh SDK Node transport resolves dependencies after stale socket removal without module hooks", () => {
	childProcess.execFileSync(
		process.execPath,
		[fileURLToPath(new URL("./fixtures/paseo-node-transport.ts", import.meta.url))],
		{
			encoding: "utf8",
			timeout: 20_000,
		},
	);
});

function socketPath(): string {
	// macOS Unix paths are limited to 104 bytes, so do not put these inside a home.
	const path = join(process.cwd(), ".scratch", `s-${randomUUID().slice(0, 8)}`);
	dirs.push(path);
	return path;
}

test("Unix listen checks dead pids before parsing and probes live refused/missing sockets SDK-free", async () => {
	const bound = socketPath();
	const path = socketPath();
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(bound, resolve));
	// Keep a real stale socket inode: close unlinks the original name, not the
	// renamed one. A regular file gives ENOTSOCK on macOS, not ECONNREFUSED.
	renameSync(bound, path);
	await new Promise<void>((resolve) => server.close(() => resolve()));
	const hooks = registerHooks({
		resolve(specifier, context, next) {
			if (specifier.startsWith("@getpaseo/client")) throw new Error("SDK imported for absent/unverified Unix socket");
			return next(specifier, context);
		},
	});
	try {
		for (const listen of [path, "not-an-address", null]) {
			assert.equal((await createPaseoApi(home({ pid: 2147483647, listen })).availability()).state, "absent");
		}
		const api = createPaseoApi(home({ pid: process.pid, listen: path }));
		const refused = await api.availability();
		assert.equal(refused.state, "absent");
		assert.ok("reason" in refused && refused.reason.includes("refused"));
		assert.match((await api.unavailable()) ?? "", /connection refused/);
		rmSync(path);
		const missing = await api.availability();
		assert.equal(missing.state, "ambiguous");
		assert.ok("reason" in missing && missing.reason.includes("ENOENT"));
	} finally {
		hooks.deregister();
	}
});

test("accepting Unix socket requires authentication exactly as TCP does", async () => {
	const path = socketPath();
	const server = createServer();
	const sockets = new Set<Socket>();
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => server.listen(path, resolve));
	let authenticates = 0;
	try {
		const dir = home({ pid: process.pid, listen: path });
		assert.deepEqual(
			await daemonAvailability(dir, async () => {
				authenticates++;
			}),
			{ state: "available" },
		);
		assert.equal(authenticates, 1);
		const rejected = await daemonAvailability(dir, async () => {
			throw new Error("authentication rejected");
		});
		assert.equal(rejected.state, "ambiguous");
		assert.ok("reason" in rejected && rejected.reason.includes("authentication rejected"));
	} finally {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("dead-pid host/boot mismatch or unverifiable identity stays ambiguous", async (t) => {
	let local = "test-computer-name";
	const run = t.mock.method(childProcess, "execFileSync", () => {
		if (!local) throw new Error("host identity unavailable");
		return local;
	});
	syncBuiltinESMExports();
	try {
		const localName = process.platform === "darwin" ? local : hostname();
		const matched = await createPaseoApi(home({ pid: 2147483647, hostname: localName, listen: null })).availability();
		assert.equal(matched.state, "absent");
		for (const identity of [{ hostname: "different-host" }, { hostname: localName, bootId: "another-boot" }]) {
			const state = await createPaseoApi(home({ ...identity, pid: 2147483647, listen: "127.0.0.1:1" })).availability();
			assert.equal(state.state, "ambiguous");
			assert.ok("reason" in state && /host\/boot identity/.test(state.reason));
		}
		if (process.platform === "darwin") {
			assert.equal(run.mock.callCount(), 3, "one hostname read per check");
			local = "";
			assert.equal(
				(await createPaseoApi(home({ pid: 2147483647, hostname: localName, listen: null })).availability()).state,
				"ambiguous",
			);
			const options = run.mock.calls[0].arguments[2] as { timeout?: number };
			assert.equal(options.timeout, 1_000, "bounded hostname lookup");
		}
	} finally {
		run.mock.restore();
		syncBuiltinESMExports();
	}
});

test("real SDK uses Unix transport for cleanup hello and agent creation, preserving auth failure", async (t) => {
	const path = socketPath();
	const http = createHttpServer();
	const { WebSocketServer } = createRequire(import.meta.resolve("@getpaseo/client"))("ws");
	const ws = new WebSocketServer({ server: http });
	let rejectAuth = false;
	let hellos = 0;
	type Peer = {
		once(event: "message", listener: () => void): void;
		send(data: string): void;
		close(code: number, reason: string): void;
	};
	ws.on("connection", (socket: Peer) => {
		socket.once("message", () => {
			hellos++;
			if (rejectAuth) {
				socket.send(JSON.stringify({ type: "hello.rejected", reason: "incorrect_password", accepts: ["password"] }));
				socket.close(1008, "Incorrect password");
			} else
				socket.send(
					JSON.stringify({
						type: "session",
						message: { type: "status", payload: { status: "server_info", serverId: "fake-unix-daemon" } },
					}),
				);
		});
	});
	await new Promise<void>((resolve) => http.listen(path, resolve));
	const dir = home({ pid: process.pid, listen: path });
	const api = createPaseoApi(dir);
	try {
		assert.deepEqual(await api.availability(), { state: "available" });
		rejectAuth = true;
		const state = await api.availability();
		assert.equal(state.state, "ambiguous");
		assert.ok("reason" in state && /incorrect password/i.test(state.reason));
		rejectAuth = false;
		// Leave connect real. The create path tolerates snapshot listing failure,
		// then reaches openProject; stop there after real Unix authentication.
		t.mock.method(DaemonClient.prototype, "fetchWorkspaces", async () => {
			throw new Error("listing reached after Unix authentication");
		});
		t.mock.method(DaemonClient.prototype, "openProject", async () => {
			throw new Error("create reached openProject after Unix authentication");
		});
		await assert.rejects(
			api.create({
				agentId: "test-agent",
				parentAgentId: "parent",
				title: "test",
				cwd: dir,
				model: "test/model",
				thinking: "low",
				systemPrompt: "",
				env: {},
			}),
			/create reached openProject after Unix authentication/,
		);
		assert.equal(hellos, 3);
		await assert.rejects(api.workspaceAt(dir), /listing reached after Unix authentication/);
		assert.equal(hellos, 4);
		await unverifiedConnections(t, api, dir, path);
		assert.equal(hellos, 6, "create and workspaceAt authenticate despite unverified pid identity");
	} finally {
		await new Promise<void>((resolve) => ws.close(resolve));
		await new Promise<void>((resolve) => http.close(() => resolve()));
	}
});

test("a socket accepting TCP but never completing hello times out ambiguously", async () => {
	const server = await listening();
	try {
		const state = await createPaseoApi(home({ pid: process.pid, listen: server.listen })).availability();
		assert.equal(state.state, "ambiguous");
		assert.ok("reason" in state && /timed out/i.test(state.reason), JSON.stringify(state));
	} finally {
		await server.close();
	}
});
