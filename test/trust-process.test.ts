import assert from "node:assert/strict";
import { type ChildProcess, fork, type Serializable } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { type TrustEndpoint, trustEndpointPath, trustProof } from "../src/trust-wire.ts";
import { agentDir, cleanup, root } from "./harness.ts";

type Notice = { type: string; title?: string; error?: string; trusted?: boolean; timeout?: number };
class Peer {
	readonly child: ChildProcess;
	private messages: Notice[] = [];
	private listeners: (() => void)[] = [];
	constructor() {
		this.child = fork(fileURLToPath(new URL("./trust-process.ts", import.meta.url)), [], {
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		this.child.on("message", (value: Notice) => {
			this.messages.push(value);
			this.listeners.splice(0).forEach((notify) => {
				notify();
			});
		});
	}
	send(message: Serializable): void {
		this.child.send(message);
	}
	async next(type: string, milliseconds = 5000): Promise<Notice> {
		const deadline = Date.now() + milliseconds;
		while (true) {
			const index = this.messages.findIndex((message) => message.type === type || message.type === "fatal");
			if (index >= 0) {
				const message = this.messages.splice(index, 1)[0];
				assert.notEqual(message.type, "fatal", message.error ?? "fixture failed");
				return message;
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new Error(`no ${type} from fixture; messages ${JSON.stringify(this.messages)}`);
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, Math.min(remaining, 25));
				this.listeners.push(() => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
	}
	async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
		if (this.child.exitCode !== null || this.child.signalCode !== null) return;
		await new Promise<void>((resolve) => {
			this.child.once("exit", () => resolve());
			this.child.kill(signal);
		});
	}
}
const peers: Peer[] = [];
afterEach(async () => {
	await Promise.all(peers.splice(0).map((peer) => peer.stop()));
});
after(() => cleanup());

async function peer(role: string, rootId: string, requester: string): Promise<Peer> {
	const result = new Peer();
	peers.push(result);
	result.send({ type: "init", role, root: rootId, requester });
	await result.next("ready");
	return result;
}
function directory(): string {
	const path = join(root, randomUUID());
	mkdirSync(join(path, ".pi"), { recursive: true });
	writeFileSync(join(path, ".pi", "settings.json"), "{}");
	return path;
}
async function fixture(): Promise<{ parent: Peer; child: Peer; rootId: string; requester: string }> {
	const rootId = randomUUID();
	const requester = randomUUID();
	const parent = await peer("root", rootId, requester);
	const child = await peer("client", rootId, requester);
	return { parent, child, rootId, requester };
}

test("separate-process root SIGKILL fails pending launch immediately; stale endpoint cannot approve", async () => {
	const { parent, child } = await fixture();
	const cwd = directory();
	child.send({ type: "launch", directory: cwd });
	await parent.next("prompt");
	await parent.stop("SIGKILL");
	assert.match((await child.next("failed", 2000)).error!, /disappeared/);
	assert.equal(new ProjectTrustStore(agentDir).get(cwd), null);
	child.send({ type: "launch", directory: cwd });
	assert.match((await child.next("failed", 2000)).error!, /not running.*trust service/);
});

test("a reused stale-root port cannot impersonate root or obtain the endpoint secret", async () => {
	const { parent, child, rootId } = await fixture();
	const endpoint: TrustEndpoint = JSON.parse(readFileSync(trustEndpointPath(agentDir, rootId), "utf8"));
	await parent.stop("SIGKILL");
	let received = "";
	const rogue = createServer((socket) => {
		socket.on("data", (data) => {
			received += data.toString();
			socket.write(`${JSON.stringify({ answer: { label: "Trust" } })}\n`);
		});
	});
	await new Promise<void>((resolve) => {
		rogue.listen(endpoint.port, "127.0.0.1", resolve);
	});
	const cwd = directory();
	try {
		child.send({ type: "launch", directory: cwd });
		assert.match((await child.next("failed")).error!, /failed authentication/);
		assert.ok(JSON.parse(received).nonce);
		assert.equal(received.includes(endpoint.token), false);
		assert.equal(received.includes(cwd), false);
		assert.equal(new ProjectTrustStore(agentDir).get(cwd), null);
	} finally {
		await new Promise<void>((resolve) => {
			rogue.close(() => resolve());
		});
	}
});

test("separate-process cancellation followed by root restart and late UI approval cannot revive launch", async () => {
	const { parent, child } = await fixture();
	const cwd = directory();
	child.send({ type: "launch", directory: cwd });
	await parent.next("prompt");
	child.send({ type: "cancel" });
	assert.match((await child.next("failed")).error!, /aborted/);
	await parent.next("dismissed");
	parent.send({ type: "restart" });
	await parent.next("ready");
	parent.send({ type: "answer", label: "Trust" });
	assert.equal(new ProjectTrustStore(agentDir).get(cwd), null);
	child.send({ type: "launch", directory: cwd });
	await parent.next("prompt");
	parent.send({ type: "answer", label: "Do not trust (this session only)" });
	assert.equal((await child.next("result")).trusted, false);
	assert.equal(new ProjectTrustStore(agentDir).get(cwd), null);
});

test("separate-process expiry dismisses active prompt; late Trust and restart cannot save it", async () => {
	const { parent, child } = await fixture();
	const cwd = directory();
	child.send({ type: "launch", directory: cwd, expiresAt: Date.now() + 1500 });
	const prompt = await parent.next("prompt");
	assert.ok(prompt.timeout! <= 1500);
	assert.match((await child.next("failed")).error!, /expired/);
	await parent.next("dismissed");
	parent.send({ type: "answer", label: "Trust" });
	parent.send({ type: "restart" });
	await parent.next("ready");
	assert.equal(new ProjectTrustStore(agentDir).get(cwd), null);
});

test("separate-process queued expiry never prompts and does not block the next live launch", async () => {
	const { parent, child, rootId } = await fixture();
	const second = await peer("client", rootId, randomUUID());
	const firstCwd = directory();
	const secondCwd = directory();
	child.send({ type: "launch", directory: firstCwd });
	await parent.next("prompt");
	second.send({ type: "launch", directory: secondCwd, expiresAt: Date.now() + 800 });
	assert.match((await second.next("failed")).error!, /expired/);
	parent.send({ type: "answer", label: "Do not trust (this session only)" });
	await child.next("result");
	second.send({ type: "launch", directory: secondCwd });
	const prompt = await parent.next("prompt");
	assert.ok(prompt.title!.includes(secondCwd));
	parent.send({ type: "answer", label: "Trust" });
	assert.equal((await second.next("result")).trusted, true);
});

test("separate-process requester disappearance dismisses prompt without persisting its late choice", async () => {
	const { parent, child } = await fixture();
	const cwd = directory();
	child.send({ type: "launch", directory: cwd });
	await parent.next("prompt");
	await child.stop("SIGKILL");
	await parent.next("dismissed");
	parent.send({ type: "answer", label: "Trust" });
	parent.send({ type: "restart" });
	await parent.next("ready");
	assert.equal(new ProjectTrustStore(agentDir).get(cwd), null);
});

test("delayed expired frame and old-root token are rejected before UI after restart", async () => {
	const { parent, rootId, requester } = await fixture();
	const old: TrustEndpoint = JSON.parse(readFileSync(trustEndpointPath(agentDir, rootId), "utf8"));
	parent.send({ type: "restart" });
	await parent.next("ready");
	const current: TrustEndpoint = JSON.parse(readFileSync(trustEndpointPath(agentDir, rootId), "utf8"));
	assert.notEqual(old.token, current.token);
	for (const request of [
		{ token: old.token, expiresAt: Date.now() + 10000 },
		{ token: current.token, expiresAt: Date.now() - 1 },
	]) {
		const frame = {
			...request,
			root: rootId,
			requester,
			chain: ["coordinator", "worker"],
			id: randomUUID(),
			directory: directory(),
			key: directory(),
		};
		const reply = await new Promise<string>((resolve, reject) => {
			const socket = connect({ host: "127.0.0.1", port: current.port });
			socket.on("error", reject);
			const nonce = randomUUID();
			let authenticated = false;
			socket.on("connect", () => {
				socket.write(`${JSON.stringify({ nonce })}\n`);
			});
			socket.on("data", (data) => {
				if (!authenticated) {
					assert.equal(JSON.parse(data.toString()).proof, trustProof(current.token, nonce));
					authenticated = true;
					socket.write(`${JSON.stringify(frame)}\n`);
				} else {
					resolve(data.toString());
					socket.destroy();
				}
			});
		});
		assert.match(reply, /invalid or expired/);
	}
});
