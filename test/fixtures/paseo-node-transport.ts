// Run in a fresh process: no preloaded SDK, test mocks or module hooks.
// The optional API path also exercises the unpacked bundle in a flat npm install.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { createConnection, createServer } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { createPaseoApi as CreateApi } from "../../src/paseo-api.ts";

mkdirSync(".scratch/tmp", { recursive: true });
const home = mkdtempSync(join(process.cwd(), ".scratch/tmp/paseo-node-"));
const bound = join(process.cwd(), ".scratch", `b-${randomUUID().slice(0, 8)}`);
const stale = join(process.cwd(), ".scratch", `s-${randomUUID().slice(0, 8)}`);
const live = join(process.cwd(), ".scratch", `l-${randomUUID().slice(0, 8)}`);
const apiUrl = process.argv[2]
	? pathToFileURL(resolve(process.argv[2]))
	: new URL("../../src/paseo-api.ts", import.meta.url);
const { createPaseoApi } = (await import(apiUrl.href)) as { createPaseoApi: typeof CreateApi };
const requireSdk = createRequire(realpathSync(createRequire(apiUrl).resolve("@getpaseo/client")));
const { WebSocketServer } = requireSdk("ws");
const http = createHttpServer();
const ws = new WebSocketServer({ server: http });
let hellos = 0;
ws.on("connection", (socket: { once(event: string, callback: () => void): void; send(data: string): void }) => {
	socket.once("message", () => {
		hellos++;
		socket.send(
			JSON.stringify({
				type: "session",
				message: { type: "status", payload: { status: "server_info", serverId: "fresh-unix-daemon" } },
			}),
		);
	});
});
try {
	const server = createServer();
	await new Promise<void>((done) => server.listen(bound, done));
	renameSync(bound, stale);
	await new Promise<void>((done) => server.close(() => done()));
	const refusal = await new Promise<NodeJS.ErrnoException>((done) => createConnection(stale).once("error", done));
	assert.equal(refusal.code, "ECONNREFUSED");
	rmSync(stale);
	// On 22.19 this ordinary fs sequence makes the next SDK resolve preserve
	// the pnpm symlink. Without canonicalization, the first import cannot find ws.
	await new Promise<void>((done) => http.listen(live, done));
	writeFileSync(join(home, "paseo.pid"), JSON.stringify({ pid: process.pid, listen: live }));
	writeFileSync(join(home, "local-credential"), "test");
	assert.deepEqual(await createPaseoApi(home).availability(), { state: "available" });
	assert.equal(hellos, 1);
	console.log(`fresh Node transport authenticated on ${process.version}`);
} finally {
	await new Promise<void>((done) => ws.close(done));
	await new Promise<void>((done) => http.close(() => done()));
	rmSync(home, { recursive: true, force: true });
	rmSync(stale, { force: true });
}
