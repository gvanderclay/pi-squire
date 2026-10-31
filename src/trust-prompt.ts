// Project-trust presentation shared by local and root-forwarded requests.
// Decisions are returned, not saved here: only the live requester may save one.

import { dirname } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";

export const TRUST_TIMEOUT_MS = 10 * 60 * 1000;
export type TrustQuestion = { directory: string; key: string; requester: string; chain: readonly string[] };
export type TrustAnswer = { saved: boolean } | { label: string };
export type TrustDecision = { answer: TrustAnswer; assertLive(): void; release(): void };
export type TrustResolver = (directory: string, key: string, signal?: AbortSignal) => Promise<TrustDecision>;
export type TrustChoice = { label: string; trusted: boolean; updates: { path: string; decision: boolean | null }[] };

export function trustChoices(key: string): TrustChoice[] {
	const parent: string = dirname(key);
	return [
		{ label: "Trust", trusted: true, updates: [{ path: key, decision: true }] },
		...(parent === key
			? []
			: [
					{
						label: `Trust parent folder (${parent})`,
						trusted: true,
						updates: [
							{ path: parent, decision: true },
							{ path: key, decision: null },
						],
					},
				]),
		{ label: "Trust (this session only)", trusted: true, updates: [] },
		{ label: "Do not trust", trusted: false, updates: [{ path: key, decision: false }] },
		{ label: "Do not trust (this session only)", trusted: false, updates: [] },
	];
}

export function trustStopped(signal?: AbortSignal): void {
	if (signal?.aborted)
		throw signal.reason instanceof Error ? signal.reason : new Error("the launch was aborted; nothing was launched");
}

/** Also bounds UIs which ignore their cancellation signal; late resolutions have no side effects. */
export async function waitForTrust<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	trustStopped(signal);
	let abort: () => void = () => {};
	const canceled: Promise<never> = new Promise((_, reject) => {
		abort = (): void =>
			reject(
				signal.reason instanceof Error ? signal.reason : new Error("the launch was aborted; nothing was launched"),
			);
		signal.addEventListener("abort", abort, { once: true });
	});
	try {
		return await Promise.race([work, canceled]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}

export function trustLifetime(
	expiresAt: number,
	signals: (AbortSignal | undefined)[],
): { signal: AbortSignal; dispose(): void } {
	const timeout: AbortController = new AbortController();
	const remaining: number = expiresAt - Date.now();
	const expire = (): void => timeout.abort(new Error("the project trust request expired; nothing was launched"));
	const timer: ReturnType<typeof setTimeout> = setTimeout(expire, Math.max(0, remaining));
	timer.unref();
	if (remaining <= 0) expire();
	const signal: AbortSignal = AbortSignal.any([
		timeout.signal,
		...signals.filter((item): item is AbortSignal => item !== undefined),
	]);
	return { signal, dispose: () => clearTimeout(timer) };
}

export class TrustPrompts {
	private readonly ctx: ExtensionContext;
	private readonly agentDir: string;
	private readonly attended: boolean;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(ctx: ExtensionContext, agentDir: string, attended = true) {
		this.ctx = ctx;
		this.agentDir = agentDir;
		this.attended = attended;
	}

	async ask(
		question: TrustQuestion,
		signal?: AbortSignal,
		expiresAt = Date.now() + TRUST_TIMEOUT_MS,
	): Promise<TrustDecision> {
		const lifetime: ReturnType<typeof trustLifetime> = trustLifetime(expiresAt, [signal]);
		let deliver: (decision: TrustDecision) => void = () => {};
		let fail: (error: unknown) => void = () => {};
		const response: Promise<TrustDecision> = new Promise((resolve, reject) => {
			deliver = resolve;
			fail = reject;
		});
		const assertLive = (): void => {
			trustStopped(lifetime.signal);
			if (Date.now() >= expiresAt) throw new Error("the project trust request expired; nothing was launched");
		};
		const run = async (): Promise<void> => {
			assertLive();
			if (!this.ctx.hasUI || !this.attended)
				throw new Error(
					`the target exposes project resources and project trust needs an attended root with a dialog-capable UI; open Pi in ${question.key}, answer its trust question, then delegate again; nothing was launched`,
				);
			const answer: TrustAnswer = await this.select(question, lifetime.signal, expiresAt);
			let release: () => void = () => {};
			const released: Promise<void> = new Promise((resolve) => {
				release = resolve;
			});
			assertLive();
			deliver({ answer, assertLive, release });
			// Keep the queue through requester persistence (or disconnect/cancel).
			await waitForTrust(released, lifetime.signal);
		};
		const turn: Promise<void> = this.queue.then(run, run);
		this.queue = turn.catch(fail).finally(() => lifetime.dispose());
		return waitForTrust(response, lifetime.signal);
	}

	private async select(question: TrustQuestion, signal: AbortSignal, expiresAt: number): Promise<TrustAnswer> {
		const saved: boolean | null = new ProjectTrustStore(this.agentDir).get(question.key);
		if (saved !== null) return { saved };
		const title: string = [
			"A delegate is about to start in a directory with project resources Pi loads only when trusted.",
			...(question.chain.length
				? [`Agent chain: ${question.chain.join(" → ")}`, `Requester session: ${question.requester}`]
				: []),
			`Directory: ${question.directory}`,
			...(question.key === question.directory ? [] : [`Main repository: ${question.key}`]),
			`"Trust" and "Do not trust" save the decision for ${question.key}; "Trust parent folder" saves it for the folder named; "this session only" applies to this launch alone.`,
		].join("\n");
		const options: string[] = trustChoices(question.key).map((option) => option.label);
		const label: string | undefined = await waitForTrust(
			this.ctx.ui.select(title, options, {
				signal,
				timeout: Math.max(1, expiresAt - Date.now()),
			}),
			signal,
		);
		trustStopped(signal);
		if (label === undefined || !options.includes(label))
			throw new Error(`the trust question for ${question.directory} was cancelled; nothing was launched`);
		return { label };
	}
}

const standalone: WeakMap<ExtensionContext, TrustPrompts> = new WeakMap();
export function localTrust(ctx: ExtensionContext, agentDir: string): TrustResolver {
	let prompts: TrustPrompts | undefined = standalone.get(ctx);
	if (!prompts) {
		prompts = new TrustPrompts(ctx, agentDir, process.env.PI_UNATTENDED !== "1");
		standalone.set(ctx, prompts);
	}
	const queue: TrustPrompts = prompts;
	return (directory: string, key: string, signal?: AbortSignal): Promise<TrustDecision> =>
		queue.ask({ directory, key, chain: [], requester: ctx.sessionManager.getSessionId() }, signal);
}
