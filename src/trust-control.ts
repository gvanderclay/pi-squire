// Root-owned, non-model project-trust control. Each runtime has a fresh token;
// sockets and pending prompts die on replacement. Nothing is replayed on reopen.
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { isAbsolute } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Identity, readIdentity } from "./identity.ts";
import { readState, writeState } from "./local-state.ts";
import {
	TRUST_TIMEOUT_MS,
	type TrustDecision,
	TrustPrompts,
	type TrustQuestion,
	type TrustResolver,
	trustLifetime,
	trustStopped,
} from "./trust-prompt.ts";
import {
	readTrustFrame,
	requestRootTrust,
	type TrustEndpoint,
	type TrustRequest,
	trustEndpointPath,
	trustProof,
	writeTrustFrame,
} from "./trust-wire.ts";

function validRequest(value: unknown, root: string, token: string): TrustRequest {
	const request: TrustRequest = value as TrustRequest;
	if (
		!request ||
		request.token !== token ||
		request.root !== root ||
		typeof request.id !== "string" ||
		typeof request.requester !== "string" ||
		!Array.isArray(request.chain) ||
		!request.chain.every((name) => typeof name === "string" && /^[a-zA-Z0-9_-]+$/.test(name)) ||
		typeof request.directory !== "string" ||
		!isAbsolute(request.directory) ||
		typeof request.key !== "string" ||
		!isAbsolute(request.key) ||
		!Number.isSafeInteger(request.expiresAt) ||
		request.expiresAt <= Date.now() ||
		request.expiresAt > Date.now() + TRUST_TIMEOUT_MS
	)
		throw new Error("invalid or expired project trust request; nothing was launched");
	const own: Identity | undefined = readIdentity(request.requester);
	if (
		!own ||
		own.root !== root ||
		request.chain.length !== own.chain.length + 1 ||
		!own.chain.every((name, index) => name === request.chain[index])
	)
		throw new Error("project trust requester does not belong to this root; nothing was launched");
	return request;
}

class TrustRuntime {
	readonly stopped: AbortController = new AbortController();
	readonly prompts: TrustPrompts;
	private readonly agentDir: string;
	private readonly root: string;
	private readonly token: string = randomUUID();
	private server: Server | undefined;
	private readonly sockets: Set<Socket> = new Set();

	constructor(ctx: ExtensionContext, agentDir: string, attended: boolean) {
		this.agentDir = agentDir;
		this.root = ctx.sessionManager.getSessionId();
		this.prompts = new TrustPrompts(ctx, agentDir, attended);
	}

	async start(): Promise<void> {
		const server: Server = createServer((socket) => this.accept(socket));
		this.server = server;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.removeListener("error", reject);
				resolve();
			});
		});
		server.unref();
		server.on("error", () => this.stop());
		if (this.stopped.signal.aborted) {
			server.close();
			return;
		}
		const address: ReturnType<Server["address"]> = server.address();
		if (!address || typeof address === "string") throw new Error("project trust endpoint has no loopback port");
		writeState(trustEndpointPath(this.agentDir, this.root), { port: address.port, token: this.token });
	}

	stop(): void {
		if (this.stopped.signal.aborted) return;
		this.stopped.abort(new Error("the project trust session was replaced or stopped; nothing was launched"));
		for (const socket of this.sockets) socket.destroy();
		this.server?.close(() => {});
		const path: string = trustEndpointPath(this.agentDir, this.root);
		try {
			if (readState<TrustEndpoint>(path)?.token === this.token) unlinkSync(path);
		} catch {
			/* A stale descriptor cannot authenticate a new runtime. */
		}
	}

	private accept(socket: Socket): void {
		this.sockets.add(socket);
		const closed: AbortController = new AbortController();
		socket.on("error", () => socket.destroy());
		socket.on("close", () => {
			this.sockets.delete(socket);
			closed.abort(new Error("the requesting launch was canceled or stopped; nothing was launched"));
		});
		// Bound connections which never provide a complete first frame.
		socket.setTimeout(1000, () => socket.destroy());
		readTrustFrame(
			socket,
			(value) => {
				if (
					!value ||
					typeof value !== "object" ||
					!("nonce" in value) ||
					typeof value.nonce !== "string" ||
					value.nonce.length > 128
				) {
					socket.destroy();
					return;
				}
				writeTrustFrame(socket, { proof: trustProof(this.token, value.nonce) });
				readTrustFrame(
					socket,
					(request) => {
						socket.setTimeout(0);
						this.answer(socket, request, closed.signal).catch(() => socket.destroy());
					},
					() => socket.destroy(),
				);
			},
			() => socket.destroy(),
		);
	}

	private async answer(socket: Socket, value: unknown, disconnected: AbortSignal): Promise<void> {
		const id: string | undefined =
			typeof value === "object" && value !== null && "id" in value && typeof value.id === "string"
				? value.id
				: undefined;
		let request: TrustRequest | undefined;
		try {
			request = validRequest(value, this.root, this.token);
			const lifetime: ReturnType<typeof trustLifetime> = trustLifetime(request.expiresAt, [
				disconnected,
				this.stopped.signal,
			]);
			try {
				const decision: TrustDecision = await this.prompts.ask(request, lifetime.signal, request.expiresAt);
				decision.assertLive();
				socket.once("close", decision.release);
				writeTrustFrame(socket, { id: request.id, answer: decision.answer });
			} finally {
				lifetime.dispose();
			}
		} catch (error) {
			writeTrustFrame(socket, { id, error: error instanceof Error ? error.message : String(error) });
			socket.end();
		}
	}
}

export type TrustControl = { forAgent(agent: string, ctx: ExtensionContext): TrustResolver };
export function registerTrustControl(pi: ExtensionAPI, identity: () => Identity | undefined): TrustControl {
	const agentDir: string = getAgentDir();
	const attended: boolean = process.env.PI_UNATTENDED !== "1";
	let runtime: TrustRuntime | undefined;
	pi.on("session_start", async (_event, ctx) => {
		runtime?.stop();
		const active: TrustRuntime = new TrustRuntime(ctx, agentDir, attended);
		runtime = active;
		if (identity() || !ctx.hasUI || !attended) return;
		try {
			await active.start();
		} catch (error) {
			active.stop();
			// A transport failure must not take away the root's existing local UI.
			if (runtime === active) runtime = new TrustRuntime(ctx, agentDir, attended);
			ctx.ui.notify(`delegate: could not start root project trust control: ${String(error)}`, "error");
		}
	});
	pi.on("session_shutdown", () => runtime?.stop());
	return {
		forAgent: (agent: string, ctx: ExtensionContext): TrustResolver => {
			const active: TrustRuntime | undefined = runtime;
			if (!active) throw new Error("project trust session has not started");
			const own: Identity | undefined = identity();
			return (directory: string, key: string, signal?: AbortSignal): Promise<TrustDecision> => {
				const question: TrustQuestion = {
					directory,
					key,
					requester: ctx.sessionManager.getSessionId(),
					chain: [...(own?.chain ?? []), agent],
				};
				const combined: AbortSignal = AbortSignal.any([
					active.stopped.signal,
					...[signal].filter((item): item is AbortSignal => item !== undefined),
				]);
				trustStopped(combined);
				if (own) return requestRootTrust(agentDir, own.root, question, combined);
				return active.prompts.ask(question, combined);
			};
		},
	};
}
