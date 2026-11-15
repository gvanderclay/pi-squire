import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPaseoApi } from "../src/paseo-api.ts";

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
		assert.equal(closes, 5, "failed connections are also closed");
	} finally {
		await server.close();
	}
	assert.equal((await api.availability()).state, "absent", "success must not cache availability");
});
test("real SDK hello accepts an available fake daemon and preserves authentication rejection as ambiguous", async () => {
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
	const api = createPaseoApi(home({ pid: process.pid, listen: `127.0.0.1:${server.address().port}` }));
	try {
		assert.deepEqual(await api.availability(), { state: "available" });
		rejectAuth = true;
		const state = await api.availability();
		assert.equal(state.state, "ambiguous");
		assert.ok("reason" in state && /incorrect password/i.test(state.reason), JSON.stringify(state));
		rejectAuth = false;
		assert.deepEqual(await api.availability(), { state: "available" }, "retry after authentication repair");
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
