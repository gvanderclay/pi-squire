// Shared start lifecycle. Callers own eligibility and workspace preparation;
// this module owns identity, prompt, hook, mail, dispatch, open and recording.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Agent } from "./agents.ts";
import { AGENT_ENV, AUTO_EXIT_ENV, FALLBACK_ENV } from "./child.ts";
import { delegatePrompt, parentCommand, toolArgs } from "./delegate-composition.ts";
import { type DelegateHost, type OpenedWindow, WindowOpenError, type WindowSpec } from "./host.ts";
import type { AdmittedHost } from "./host-admission.ts";
import { type createIdentity, type Identity, readIdentity, writeIdentity } from "./identity.ts";
import { windowLocator } from "./locators.ts";
import { MULTIPLEXER_ENV } from "./multiplexer.ts";
import { type Delegation, type Results, type StartedRecorded, sessionIdOf } from "./results.ts";
import { sessionIsOwned } from "./session-owner.ts";
import {
	assertParentPlacement,
	bindTree,
	dispatchTree,
	failedTree,
	openedTree,
	type Reservation,
	readTree,
	reconcileTree,
	reserveTree,
	type TreeIntent,
} from "./tree-registry.ts";
import { assertRootPlacement } from "./window-placement.ts";
import type { Workspace } from "./workspace.ts";

type SendPayload = { to: unknown; body: unknown; envelope?: { id?: unknown }; error?: unknown };
/** cwd is informational: listeners cannot change where the host opens. */
type LaunchPayload = {
	args: string[];
	env: Record<string, string>;
	agent: string;
	readonly cwd: string;
	readonly parent: string;
	readonly root: string;
	readonly depth: number;
	readonly chain: readonly string[];
	readonly toolCallId: string | undefined;
};
export type ChildStart = {
	agent: Agent;
	model: string;
	rest: string[];
	thinking: string;
	autoExit: boolean;
	notices: string[];
};
export type StartSession =
	| { kind: "launch" }
	| { kind: "fork"; id: string; path: string; sourceCwd: string }
	| { kind: "resume"; id: string; path: string; sessionId: string };

type StartInput = {
	id: string;
	name: string;
	session: StartSession;
	identity: Identity;
	workspace: Workspace;
	trusted: boolean;
	sessionDir: string;
	start: ChildStart;
	task: string;
	toolCallId: string | undefined;
	admission: AdmittedHost;
	tools: readonly string[];
	/** Managed workspace facts are published at the original mail boundary. */
	onMailed?: (requestId: string) => void;
	onWindowOpened?: () => void;
};
type StartDeps = {
	pi: ExtensionAPI;
	host: DelegateHost;
	identity: ReturnType<typeof createIdentity>;
	results: Results;
	admit(agent: string, ctx: ExtensionContext): void;
	startPolling(): void;
};
type Started = { opened: OpenedWindow; requestId: string };

function writePromptFile(prompt: string): string {
	const path = join(mkdtempSync(join(tmpdir(), "pi-squire-")), "prompt.md");
	writeFileSync(path, prompt, { mode: 0o600 });
	return path;
}

function promptContext(input: StartInput): string {
	const workspace = input.workspace;
	let context = "";
	if (workspace.mode === "managed")
		context = `\n\nYour managed worktree is ${workspace.cwd}, branch ${workspace.createdBranch}, based on commit ${workspace.baseCommit}.`;
	else if (workspace.mode === "existing")
		context = `\n\nThe session that started you chose your working directory: ${workspace.cwd}`;
	if (workspace.mode === "managed" && input.session.kind === "fork" && input.session.sourceCwd)
		context += `\n\nThis session was forked from one that worked in ${input.session.sourceCwd}. Work only in ${workspace.cwd}; its uncommitted changes are not here.`;
	return context;
}

function sessionIdFor(input: StartInput): string {
	return input.session.kind === "resume" ? input.session.sessionId : input.id;
}

const startedSessionId = (input: StartInput, opened: OpenedWindow): string => opened.sessionId ?? sessionIdFor(input);

function sessionArgs(input: StartInput): string[] {
	if (input.session.kind === "resume") return ["--session", input.session.path];
	const fork = input.session.kind === "fork" ? ["--fork", input.session.path] : [];
	return [...fork, "--session-id", input.id, "--name", input.name];
}

function environment(input: StartInput): Record<string, string> {
	const { identity: own, start, id } = input;
	const env: Record<string, string> = {
		PI_CODING_AGENT_DIR: getAgentDir(),
		PI_SQUIRE_LIVE_LAUNCH: JSON.stringify({ version: 1, sessionId: sessionIdFor(input), launchId: id }),
		PI_DELEGATE_PARENT: own.parent,
		PI_DELEGATE_ROOT: own.root,
		PI_DELEGATE_DEPTH: String(own.depth),
		PI_DELEGATE_CHAIN: own.chain.join(","),
		[AUTO_EXIT_ENV]: start.autoExit && input.admission.client.keepsDelegatesOpen !== true ? "1" : "0",
		[AGENT_ENV]: start.agent.name,
		[MULTIPLEXER_ENV]: input.admission.client.id,
		PI_UNATTENDED: "1",
	};
	if (start.rest.length > 0) env[FALLBACK_ENV] = start.rest.join(",");
	const sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
	if (sessionDir !== undefined && sessionDir !== "") env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
	return env;
}

/** Preserve the README hook's mutable args/env and protected ancestry fields. */
function launchPayload(input: StartInput): LaunchPayload {
	const { start, identity: own } = input;
	const prompt = writePromptFile(delegatePrompt(start.agent, promptContext(input)));
	const payload: LaunchPayload = {
		args: [
			...parentCommand(),
			...sessionArgs(input),
			input.trusted ? "--approve" : "--no-approve",
			"--session-dir",
			input.sessionDir,
			"--model",
			start.model,
			"--thinking",
			start.thinking,
			...toolArgs(input.tools),
			"--append-system-prompt",
			prompt,
		],
		env: environment(input),
		agent: start.agent.name,
		cwd: input.workspace.cwd,
		toolCallId: input.toolCallId,
		parent: own.parent,
		root: own.root,
		depth: own.depth,
		chain: Object.freeze([...own.chain]),
	};
	for (const key of ["parent", "root", "depth", "chain"] as const)
		Object.defineProperty(payload, key, { writable: false, configurable: false });
	return payload;
}

/** Mail failure after open uses only the host's taskless-resource rollback seam. */
async function mailTask(
	deps: { host: DelegateHost; sendTask(to: string, task: string): string },
	opened: OpenedWindow,
	sessionId: string,
	task: string,
): Promise<string> {
	try {
		return deps.sendTask(sessionId, task);
	} catch (error) {
		return closeAfterFailure(deps.host, opened, error);
	}
}

async function closeAfterFailure(client: DelegateHost, opened: OpenedWindow, error: unknown): Promise<never> {
	try {
		await client.closeTaskless(opened);
	} catch (closeError) {
		throw new Error(
			`${(error as Error).message ?? String(error)}; ${(closeError as Error).message ?? String(closeError)}`,
			{ cause: error },
		);
	}
	throw error;
}

function publishRequest(token: Reservation, requestId: string, windowId: string, ctx: ExtensionContext): void {
	try {
		bindTree(token, { requestId });
	} catch (error) {
		ctx.ui.notify(
			`delegate: window ${windowId} opened and task mail was sent, but shared request publication failed: ${String(error)}. Local tracking continues; accounting reconciles before the next admission.`,
			"warning",
		);
	}
}

function startRecord(input: StartInput, opened: OpenedWindow, requestId: string): Delegation {
	const { id, name, session, start, workspace } = input;
	const sessionId = sessionIdFor(input);
	return {
		id,
		identity: session.kind === "resume" ? (readIdentity(sessionId) ?? input.identity) : readIdentity(id),
		agent: start.agent.name,
		...(start.agent.displayName === undefined ? {} : { displayName: start.agent.displayName }),
		model: start.model,
		thinking: start.thinking,
		name,
		locator: opened.locator ?? windowLocator({ id: opened.id, name }),
		requestId,
		autoExit: start.autoExit && input.admission.client.keepsDelegatesOpen !== true,
		cwd: workspace.cwd,
		sessionDir: input.sessionDir,
		workspace,
		...(session.kind === "fork" ? { forkedFrom: session.id } : {}),
		...(session.kind === "resume" ? { resumedFrom: session.id, sessionId } : {}),
		...(opened.sessionId === undefined ? {} : { sessionId: opened.sessionId }),
	};
}

export class DelegateStarter {
	private readonly deps: StartDeps;
	constructor(deps: StartDeps) {
		this.deps = deps;
	}

	/** Launch/fork identity is computed before workspace/trust side effects. */
	childIdentity(agent: Agent, ctx: ExtensionContext, companion: string): Identity {
		const own = this.deps.identity.child(agent, ctx, companion);
		if (this.deps.identity.current()) assertParentPlacement(readTree(own.root), own);
		return own;
	}

	/** Reserve before workspace creation, reconciling through the routing host. */
	async reserve(intent: TreeIntent, agent: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<Reservation> {
		await reconcileTree(intent.identity.root, this.deps.host);
		this.deps.admit(agent, ctx);
		if (signal?.aborted) throw new Error("the launch was aborted");
		return reserveTree(intent);
	}

	async reserveResume(record: StartedRecorded, id: string, ctx: ExtensionContext): Promise<Reservation> {
		const own = record.identity;
		if (!own) throw new Error(`delegation ${record.id} has no original root placement identity; resume refused`);
		assertRootPlacement(own.rootPlacement);
		return this.reserve(
			{
				id,
				sessionId: sessionIdOf(record),
				identity: own,
				resumedFrom: record.id,
				sessionDir: record.sessionDir,
			},
			record.agent,
			ctx,
		);
	}

	refund(token: Reservation, ctx: ExtensionContext): void {
		try {
			failedTree(token);
		} catch (accounting) {
			ctx.ui.notify(`delegate: reservation remains charged: ${String(accounting)}`, "error");
		}
	}

	private sendTask(to: string, task: string): string {
		const sent: SendPayload = { to, body: task };
		this.deps.pi.events.emit("message:send", sent);
		if (typeof sent.error === "string") throw new Error(`could not send the task to ${to}: ${sent.error}`);
		if (sent.envelope === undefined)
			throw new Error(
				"needs a provider of message:* to send the task; install a mailbox extension (for example pi-session-mail)",
			);
		const requestId = sent.envelope.id;
		if (typeof requestId !== "string") throw new Error(`the message:send provider wrote no request id for ${to}`);
		return requestId;
	}

	async start(input: StartInput, ctx: ExtensionContext): Promise<Started> {
		const client = input.admission.client;
		const token = { root: input.identity.root, id: input.id };
		const before = client.taskMailTiming(input.session.kind) === "before-open";
		const mailed = before ? this.mailBeforeOpen(input, token) : undefined;
		const opened = await this.openSession(input, token, ctx);
		if (client.configureStart) await this.configure(input, opened);
		const requestId = mailed ?? (await this.mailAfterOpen(input, opened, token, ctx));
		this.deps.results.recordStart(startRecord(input, opened, requestId), ctx);
		this.deps.startPolling();
		return { opened, requestId };
	}

	private mailBeforeOpen(input: StartInput, token: Reservation): string {
		const requestId = this.sendTask(sessionIdFor(input), input.task);
		bindTree(token, { requestId });
		input.onMailed?.(requestId);
		return requestId;
	}

	private async mailAfterOpen(
		input: StartInput,
		opened: OpenedWindow,
		token: Reservation,
		ctx: ExtensionContext,
	): Promise<string> {
		const requestId = await mailTask(
			{ host: input.admission.client, sendTask: (to: string, task: string) => this.sendTask(to, task) },
			opened,
			startedSessionId(input, opened),
			input.task,
		);
		publishRequest(token, requestId, opened.id, ctx);
		input.onMailed?.(requestId);
		return requestId;
	}

	private async configure(input: StartInput, opened: OpenedWindow): Promise<void> {
		const client = input.admission.client;
		if (!client.configureStart) return;
		try {
			await client.configureStart(opened, {
				kind: input.session.kind,
				sessionId: startedSessionId(input, opened),
				launchId: input.id,
				model: input.start.model,
				thinking: input.start.thinking,
				cwd: input.workspace.cwd,
				sessionDir: input.sessionDir,
			});
		} catch (error) {
			await closeAfterFailure(client, opened, error);
		}
	}

	private async openSession(input: StartInput, token: Reservation, ctx: ExtensionContext): Promise<OpenedWindow> {
		const { start, identity: own, workspace, session } = input;
		this.deps.admit(start.agent.name, ctx);
		this.deps.results.checkStorage(true);
		if (session.kind === "resume" && sessionIsOwned(session.sessionId))
			throw new Error(`delegate session ${session.sessionId} is already open; resume refused before spawn`);
		assertRootPlacement(own.rootPlacement);
		own.autoExit = start.autoExit && input.admission.client.keepsDelegatesOpen !== true;
		writeIdentity(sessionIdFor(input), own);
		const payload = launchPayload(input);
		this.deps.pi.events.emit("session:launch", payload);
		bindTree(token, { cwd: workspace.cwd, workspace });
		dispatchTree(token);
		const spec = { name: input.name, cwd: workspace.cwd, argv: payload.args, env: payload.env };
		const opened = await this.open(input, spec, token, ctx);
		input.onWindowOpened?.();
		if (opened.sessionId !== undefined) {
			writeIdentity(opened.sessionId, own);
			this.publishSession(input, opened, token, ctx, opened.sessionId);
		}
		this.publishOpened(input, opened, token, ctx);
		return opened;
	}

	private async open(
		input: StartInput,
		spec: WindowSpec,
		token: Reservation,
		ctx: ExtensionContext,
	): Promise<OpenedWindow> {
		const client = input.admission.client;
		try {
			return await client.openWindow(spec, input.admission.placement, input.identity.rootPlacement);
		} catch (err) {
			if (err instanceof WindowOpenError && err.certainty === "not-opened") this.refundNotOpened(token, ctx);
			const noun = client.windowNoun ?? "window";
			const message = `could not open ${noun} ${input.name} for ${input.id}: ${(err as Error).message}`;
			throw new WindowOpenError(message, err instanceof WindowOpenError ? err.certainty : "unknown");
		}
	}

	private refundNotOpened(token: Reservation, ctx: ExtensionContext): void {
		try {
			failedTree(token, true);
		} catch (accounting) {
			ctx.ui.notify(
				`delegate: could not refund the pre-start reservation: ${String(accounting)}; it remains charged.`,
				"warning",
			);
		}
	}

	/** A host-assigned session id is re-filed; a shared failure keeps the opened delegate local. */
	private publishSession(
		input: StartInput,
		opened: OpenedWindow,
		token: Reservation,
		ctx: ExtensionContext,
		sessionId: string,
	): void {
		try {
			bindTree(token, { sessionId });
		} catch (error) {
			const noun = input.admission.client.windowNoun ?? "window";
			ctx.ui.notify(
				`delegate: ${noun} ${opened.id} opened as session ${sessionId}, but shared session publication failed: ${String(error)}. Local tracking continues; accounting reconciles before the next admission.`,
				"warning",
			);
		}
	}

	private publishOpened(input: StartInput, opened: OpenedWindow, token: Reservation, ctx: ExtensionContext): void {
		try {
			openedTree(token, opened.locator ?? windowLocator({ id: opened.id, name: input.name }));
		} catch (error) {
			const noun = input.admission.client.windowNoun ?? "window";
			ctx.ui.notify(
				`delegate: ${noun} ${opened.id} opened, but shared accounting publication failed: ${String(error)}. Local tracking continues; the reservation remains charged until accounting reconciles.`,
				"warning",
			);
		}
	}
}

export function createDelegateStart(deps: StartDeps): DelegateStarter {
	return new DelegateStarter(deps);
}
