// One authenticated loopback connection per trust decision, with no replay.
// The owner-only endpoint descriptor is squire state, not provider state.
import { createHash, createHmac, randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { readState } from "./local-state.ts";
import {
	TRUST_TIMEOUT_MS,
	type TrustAnswer,
	type TrustDecision,
	type TrustQuestion,
	trustLifetime,
	trustStopped,
} from "./trust-prompt.ts";

export type TrustEndpoint = { port: number; token: string };
export type TrustRequest = TrustQuestion & { token: string; root: string; id: string; expiresAt: number };
type TrustResponse = { id: string; answer?: TrustAnswer; error?: string };
const FRAME_LIMIT = 32 * 1024;
const CONNECT_TIMEOUT_MS = 1000;

/** Fresh client nonce proves the endpoint still holds this runtime's secret. */
export function trustProof(token: string, nonce: string): string {
	return createHmac("sha256", token).update(nonce).digest("hex");
}

export function trustEndpointPath(agentDir: string, root: string): string {
	const key: string = createHash("sha256").update(root).digest("hex");
	return join(agentDir, "squire", "trust", `${key}.json`);
}

/** Bounded one-frame reader. Errors are delivered once; trailing/duplicate frames are ignored. */
export function readTrustFrame(socket: Socket, receive: (value: unknown) => void, fail: (error: Error) => void): void {
	let buffer = "";
	let done = false;
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		if (done) return;
		buffer += chunk;
		if (Buffer.byteLength(buffer) > FRAME_LIMIT) {
			done = true;
			fail(new Error("project trust control frame is too large"));
			return;
		}
		const end: number = buffer.indexOf("\n");
		if (end < 0) return;
		done = true;
		try {
			receive(JSON.parse(buffer.slice(0, end)));
		} catch {
			fail(new Error("invalid project trust control frame"));
		}
	});
}
export function writeTrustFrame(socket: Socket, value: unknown): void {
	socket.write(`${JSON.stringify(value)}\n`);
}

function endpointAt(agentDir: string, root: string): TrustEndpoint {
	let value: TrustEndpoint | undefined;
	try {
		value = readState<TrustEndpoint>(trustEndpointPath(agentDir, root));
	} catch (error) {
		throw new Error(
			`could not read root ${root} project trust service endpoint: ${String(error)}; nothing was launched`,
		);
	}
	if (
		!value ||
		!Number.isInteger(value.port) ||
		value.port < 1 ||
		value.port > 65535 ||
		typeof value.token !== "string"
	)
		throw new Error(
			`root ${root} is not running an available project trust service; reopen that root and retry the launch`,
		);
	return value;
}
function responseAnswer(value: unknown, id: string): TrustAnswer {
	const reply: TrustResponse = value as TrustResponse;
	if (!reply || reply.id !== id) throw new Error("invalid project trust decision identity");
	if (typeof reply.error === "string") throw new Error(reply.error);
	const answer: TrustAnswer | undefined = reply.answer;
	if (
		answer &&
		(("saved" in answer && typeof answer.saved === "boolean") ||
			("label" in answer && typeof answer.label === "string"))
	)
		return answer;
	throw new Error("invalid project trust decision");
}

export async function requestRootTrust(
	agentDir: string,
	root: string,
	question: TrustQuestion,
	signal?: AbortSignal,
	expiresAt = Date.now() + TRUST_TIMEOUT_MS,
): Promise<TrustDecision> {
	trustStopped(signal);
	const endpoint: TrustEndpoint = endpointAt(agentDir, root);
	const lifetime: ReturnType<typeof trustLifetime> = trustLifetime(expiresAt, [signal]);
	try {
		return await exchange(
			endpoint,
			{ ...question, root, token: endpoint.token, id: randomUUID(), expiresAt },
			lifetime.signal,
		);
	} finally {
		lifetime.dispose();
	}
}

function authenticate(
	socket: Socket,
	token: string,
	nonce: string,
	ready: () => void,
	fail: (error: Error) => void,
): void {
	readTrustFrame(
		socket,
		(hello) => {
			if (!hello || typeof hello !== "object" || !("proof" in hello) || hello.proof !== trustProof(token, nonce)) {
				fail(new Error("root project trust endpoint failed authentication; nothing was launched"));
				return;
			}
			ready();
		},
		fail,
	);
}

function exchange(endpoint: TrustEndpoint, request: TrustRequest, signal: AbortSignal): Promise<TrustDecision> {
	return new Promise((resolve, reject) => {
		const socket: Socket = connect({ host: "127.0.0.1", port: endpoint.port });
		let settled = false;
		const finish = (error?: Error, answer?: TrustAnswer): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			if (error) {
				socket.destroy();
				reject(error);
			} else if (answer)
				resolve({
					answer,
					assertLive: () => {
						trustStopped(signal);
						if (Date.now() >= request.expiresAt || socket.destroyed)
							throw new Error("the project trust request expired or disconnected; nothing was launched");
					},
					release: () => socket.destroy(),
				});
		};
		const abort = (): void =>
			finish(
				signal.reason instanceof Error ? signal.reason : new Error("the launch was aborted; nothing was launched"),
			);
		const timer: ReturnType<typeof setTimeout> = setTimeout(
			() => finish(new Error(`root ${request.root} project trust service is unavailable; nothing was launched`)),
			CONNECT_TIMEOUT_MS,
		);
		timer.unref();
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		const nonce: string = randomUUID();
		socket.on("connect", () => {
			if (!settled) writeTrustFrame(socket, { nonce });
		});
		socket.on("error", () =>
			finish(new Error(`root ${request.root} is not running an available project trust service; nothing was launched`)),
		);
		socket.on("close", () =>
			finish(new Error(`root ${request.root} disappeared during project trust; nothing was launched`)),
		);
		authenticate(
			socket,
			endpoint.token,
			nonce,
			() => {
				clearTimeout(timer);
				if (settled) return;
				writeTrustFrame(socket, request);
				readTrustFrame(
					socket,
					(value) => {
						try {
							trustStopped(signal);
							finish(undefined, responseAnswer(value, request.id));
						} catch (error) {
							finish(error instanceof Error ? error : new Error(String(error)));
						}
					},
					(error) => finish(error),
				);
			},
			(error) => finish(error),
		);
	});
}
