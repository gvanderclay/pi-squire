// pi-squire: hand a task to a delegate Pi session in a background tmux
// window, over the `message:*` hooks.
//
// `/delegate <agent> [--model <provider/id>] [--thinking <level>]
// [--label <name>] [--cwd <dir> | --worktree <branch> [--worktree-source <dir>] [--worktree-base <commit-ish>] ] [--auto-exit | --no-auto-exit] <task…>`
// reads the agent from `<agent dir>/agents/<name>.md` or, in a trusted project,
// `<cwd>/.pi/agents/<name>.md` (`agents.ts`), writes the task
// to the delegate's inbox through `message:send`, emits `session:launch` so
// listeners can add arguments and environment, then opens a window in the
// parent's working directory, or the existing directory `--cwd` selects
// (`workspace.ts`), running the parent's own Pi. The window and the
// session share one name: `<agent>-<label>`, or `<agent>-<first 8 of the id>`
// without a label. Starting a delegation adds nothing to
// the model's context. Each delegation is recorded
// in the parent session; its answer is taken over on `message:inbound` and
// shown as one result message, so the parent hears back on its own.
//
// With auto-exit on (the agent's `auto_exit`, default true, overridden per
// call) the delegate closes its own window after a normal completion; the
// delegate's side lives in `child.ts`. With it off the window stays open.
// An agent's `tools`, or the parent's active tools when it has no `tools`
// field (less any `-name` entries), goes to the child as `--tools` with the
// `delegateTools` setting added (`--no-tools` when that leaves nothing).
// An agent with no `model` or `thinking` runs
// on the parent's.
//
// The model gets five tools. `delegate` takes agent, task and optional model
// and thinking, validates them the way the command does, and starts the
// delegation at once, opening no dialog, so parallel calls cannot block one
// another; the one exception is a `cwd` whose project trust is unresolved,
// which the user answers in the parent. `delegation_status`
// reports each delegation as running (window open, no result yet), done (with
// its result status) or closed, with the session name, window, session and
// envelope paths.
// `delegation_close` kills the window and records the close. `delegation_resume`
// (`resume.ts`) reopens an exited delegate's session in a new window with a
// follow-up task, recorded as a new delegation. `delegation_fork` copies a
// child's context into a new session, leaving the original untouched.
// A delegate can launch children
// only below maxDepth and with its current agent allow_nested_delegation grant.
// Durable identity restores that boundary even on a manual session reopening.
//
// The `session:launch` contract this package provides, and the `message:*`
// hooks it consumes, live in this package's README.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type Agent,
	delegateTools,
	disabledProblem,
	isThinking,
	projectAgentsDir,
	type Roster,
	readRoster,
	THINKING_LEVELS,
	withoutLocked,
} from "./agents.ts";
import { registerChild } from "./child.ts";
import { registerCompletionHost } from "./completion-holds.ts";
import {
	DELEGATION_TOOLS,
	delegateVisible,
	parentTrust,
	toolDescription,
	toolSelection,
	whereAgentsGo,
} from "./delegate-composition.ts";
import {
	completions,
	LABEL_MAX,
	labelProblem,
	type Parsed,
	parse,
	parseResume,
	RESUME_USAGE,
	resumeCompletions,
	thinkingProblem,
	USAGE,
} from "./delegate-request.ts";
import { DelegateSchema } from "./delegate-schema.ts";
import { createDelegateStart } from "./delegate-start.ts";
import { type ForkSource, forkTool } from "./fork.ts";
import { type DelegateHost, WindowOpenError } from "./host.ts";
import { createHostAdmission } from "./host-admission.ts";
import { createIdentity, grantsNesting } from "./identity.ts";
import { clearMarks, readMarks } from "./limits.ts";
import { openedIn } from "./location.ts";
import { agentModels, chooseModel, fallbackNote, modelIds, type Skipped } from "./model-choice.ts";
import { createMultiplexer } from "./multiplexer.ts";
import { createNavigator, OPEN_USAGE, openCompletions, parseOpen } from "./navigator.ts";
import { type NewDelegateDeps, type NewRequest, startNewDelegate } from "./new-delegate.ts";
import { registerPaseoChild } from "./paseo-child.ts";
import { dirtyNotice, renderDelegateCall, renderDelegateResult, resourceLine } from "./render.ts";
import { createResults, delegateName, isStarted, type WorkspaceAttempt } from "./results.ts";
import { createResume, resumableIds, startedLine } from "./resume.ts";
import { pickResume } from "./resume-picker.ts";
import { createRoutingDispatch } from "./routing-dispatch.ts";
import { promptRouting } from "./routing-input.ts";
import { RoutingRequestSchema } from "./routing-schema.ts";
import type { RoutingRecord, RoutingRequest } from "./routing-types.ts";
import { ownedAPI, SessionOwner } from "./session-owner.ts";
import { registerTaskReplies } from "./task-replies.ts";
import { availableTools } from "./tool-names.ts";
import { createTracking, toolResult } from "./tracking.ts";
import { claimTree, finishTree, publishTreeRecords, type Reservation, readTree } from "./tree-registry.ts";
import { assertChildAuthority, assertResumeAuthority, historicalRecord, visibleRecords } from "./tree-view.ts";
import { registerTrustControl } from "./trust-control.ts";
import { createProactive, createUsageClient, type UsageClient } from "./usage.ts";
import { registerDelegateWidget } from "./widget.ts";
import { registerActivityRuntime } from "./widget-activity-runtime.ts";
import { assertRootPlacement, placementProject, windowSettings } from "./window-placement.ts";
import { normalizeWorkspaceValue, prepareDirectory, trustPlannedWorktree, type Workspace } from "./workspace.ts";
import {
	createWorktree,
	inQueue,
	prepareWorktree,
	recoveryCommands,
	revalidate,
	rollbackWorktree,
	type WorktreePlan,
} from "./worktree.ts";

/** The optional parent guidance file under `<agent dir>/squire/`. */
const PARENT_PROMPT = "delegation_prompt.md";
/** The parent system-prompt section this extension owns. */
const PARENT_SECTION = "squire_parent_delegation";

export { DelegateSchema } from "./delegate-schema.ts";

/** A request that passed the roster, model, thinking and label checks. */
type Start = {
	routing?: RoutingRecord;
	agent: Agent;
	model: string;
	/** Candidates passed over for `model`, with why; empty unless a fallback was used. */
	skipped: Skipped[];
	/** Lines for the parent, such as a quota reading that failed. */
	notices: string[];
	/** The candidates after `model`, for the delegate to move to on a usage limit; empty for an explicit model. */
	rest: string[];
	thinking: string;
	label?: string;
	/** The existing directory to run in, as given; undefined inherits the parent's. */
	cwd?: string;
	/** The new local branch to create a worktree for; undefined creates none. */
	worktree?: string;
	worktree_base?: string;
	worktree_source?: string;
	autoExit: boolean;
	task: string;
};
/** A delegation that is open in a tmux window. */
type Launched = {
	location?: string;
	id: string;
	name: string;
	windowId: string;
	windowName: string;
	/** The session the window opened in; undefined when tmux could not say. */
	windowSession: string | undefined;
	requestId: string;
	cwd: string;
	sessionDir: string;
	workspace: Workspace;
};

/** Read `<agent dir>/squire/delegation_prompt.md`; missing or whitespace-only means no guidance. */
function readParentPrompt(): { text?: string; error?: string } {
	const path = join(getAgentDir(), "squire", PARENT_PROMPT);
	try {
		const text = readFileSync(path, "utf8");
		return text.trim() === "" ? {} : { text };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
		return {
			error: `could not read ${path}: ${(err as Error).message}; parent delegation guidance is off for this run`,
		};
	}
}

/**
 * Register `/delegate` and the three tools. The second and third
 * parameters are test-only seams, for tmux and for the usage readers: Pi
 * passes only `pi`, so they are not part of the package's documented contract.
 */
export default function delegate(
	api: ExtensionAPI,
	tmux: DelegateHost = createMultiplexer(),
	usage: UsageClient = createUsageClient(),
): void {
	const owner = new SessionOwner();
	const host = api;
	host.on("session_start", (_event, ctx) => owner.start(ctx));
	host.events.on("message:inbound", (payload) => owner.receive(payload as import("./results.ts").Inbound));
	const pi = ownedAPI(host, owner);
	const externalReady = registerCompletionHost(pi);
	const identity = createIdentity(pi);
	const results = createResults(
		pi,
		() => identity.current() !== undefined,
		(ctx, records) =>
			publishTreeRecords(
				identity.current()?.root ?? ctx.sessionManager.getSessionId(),
				ctx.sessionManager.getSessionId(),
				records,
			),
		() => owner.active(),
		(ctx) =>
			readTree(identity.current()?.root ?? ctx.sessionManager.getSessionId())
				.entries.filter((entry) => entry.identity.parent === ctx.sessionManager.getSessionId() && entry.closed)
				.map((entry) => entry.id),
	);
	pi.on("session_start", (_event, ctx) => tracking.restore(ctx));
	const replies = registerTaskReplies(
		pi,
		() => identity.current()?.parent,
		() => {
			try {
				owner.assert();
				identity.current();
				return results.completionReady() && externalReady();
			} catch {
				return false;
			}
		},
		(ctx) => coordinates(currentRoster(ctx)),
		(ctx, ids) => {
			owner.assert();
			const own = identity.current();
			if (own) finishTree(own.root, ctx.sessionManager.getSessionId(), ids);
		},
	);
	registerChild(pi, replies, identity.current, () => owner.active());
	// Pi asks for project trust before `session_start` elects this session's owner.
	registerPaseoChild(pi, host);
	host.on("session_start", () => owner.arm());
	// Restore answers synchronously before this potentially slow tmux read.
	pi.on("session_start", async (_event, ctx) => {
		try {
			const own = identity.current();
			if (!own) return;
			const window = await tmux.currentWindow?.();
			owner.assert();
			claimTree(own.root, ctx.sessionManager.getSessionId(), window);
		} catch (error) {
			ctx.ui.notify(
				`delegate: could not publish startup accounting: ${String(error)}; uncertain reservations remain charged.`,
				"error",
			);
		}
	});

	const proactive = createProactive(usage);
	let viewContext: ExtensionContext | undefined;
	pi.on("session_start", (_event, ctx) => {
		viewContext = ctx;
	});
	const viewResults = {
		...results,
		list: () => (viewContext ? visibleRecords(results, viewContext) : results.list()),
		find: (id: string) =>
			viewContext ? visibleRecords(results, viewContext).find((record) => record.id === id) : results.find(id),
	};
	const tracking = createTracking(pi, results, tmux, proactive.errors, viewResults, () => owner.assert());
	const trustControl = registerTrustControl(pi, identity.current);
	// Factual lifecycle observation survives failed action processing; only creation needs ownership.
	registerActivityRuntime(host, () => owner.active(), tmux, owner.token);
	registerDelegateWidget(
		pi,
		results,
		tmux,
		async (ctx, id) => {
			owner.assert();
			await navigator.openDelegate(ctx, id, "switch");
		},
		(ctx, id) => navigator.closeDelegate(ctx, id),
		() => owner.assert(),
	);

	/** Captured because `getArgumentCompletions` is called without a context. */
	let registry: ModelRegistry | undefined;
	/** The latest context, for the roster a completion reads; undefined before the session starts. */
	let latest: ExtensionContext | undefined;

	/** The project's agents folder when `ctx`'s project is trusted; undefined otherwise or without a context. */
	function trustedProject(ctx: ExtensionContext | undefined): string | undefined {
		if (ctx === undefined) return undefined;
		try {
			return ctx.isProjectTrusted() ? projectAgentsDir(ctx.cwd) : undefined;
		} catch {
			return undefined; // a stale context after a session replacement
		}
	}

	/** The roster as it stands: the global agents, and the project's when it is trusted. */
	const currentRoster = (ctx: ExtensionContext | undefined = latest): Roster =>
		readRoster(getAgentDir(), trustedProject(ctx));

	/** What an agent with no `model` or `thinking` runs on: the parent's model and level now. */
	function parentDefaults(ctx: ExtensionContext): { model?: string; thinking: string } {
		let thinking = "medium";
		try {
			thinking = pi.getThinkingLevel();
		} catch {
			// Pi binds this before any call can reach here; the default only covers a host without it.
		}
		return { ...(ctx.model === undefined ? {} : { model: `${ctx.model.provider}/${ctx.model.id}` }), thinking };
	}

	/**
	 * The delegate's tools for a launch or resume starting now: the agent's
	 * named tools, or the parent's current tools (including indirect callable
	 * tools, less any `-name` entries), then `delegateTools`.
	 * Throws, naming the file, on an invalid setting.
	 */
	function childTools(agent: Agent): string[] {
		const selected = toolSelection(
			agent,
			agent.tools === undefined ? availableTools(pi) : [],
			delegateTools(getAgentDir()),
		);
		if (grantsNesting(agent, (identity.current()?.depth ?? 0) + 1)) selected.push(...DELEGATION_TOOLS);
		return [...new Set(selected)];
	}

	const routing = createRoutingDispatch(
		pi,
		(id, ctx) => {
			const record = viewResults.find(id) ?? historicalRecord(id, ctx);
			return record && isStarted(record) ? record : undefined;
		},
		childTools,
		proactive,
	);

	function coordinates(roster: Roster): boolean {
		const own = identity.current();
		const agent = roster.agents.find((item) => item.name === own?.agent);
		return own !== undefined && agent !== undefined && grantsNesting(agent, own.depth);
	}

	function admit(agent: string, roster: Roster): void {
		owner.assert();
		results.checkStorage();
		identity.admit(agent, roster);
	}

	function exposeDelegation(roster: Roster): void {
		if (!identity.current()) return;
		const enabled = coordinates(roster);
		const base = pi.getActiveTools().filter((name) => !DELEGATION_TOOLS.has(name));
		pi.setActiveTools(enabled ? [...base, ...DELEGATION_TOOLS] : base);
	}

	/** Read the roster now, warning about every file left out. */
	function rosterFor(ctx: ExtensionContext): Roster {
		const roster = currentRoster(ctx);
		for (const warning of roster.warnings) ctx.ui.notify(`delegate: ${warning}`, "warning");
		return roster;
	}

	/** The roster warnings already shown this session, so a run shows only new ones. */
	const announced = new Set<string>();

	/** Show each roster warning not yet shown this session, such as a file that is disabled. */
	function announce(roster: Roster, ctx: ExtensionContext): void {
		for (const warning of roster.warnings) {
			if (announced.has(warning)) continue;
			announced.add(warning);
			ctx.ui.notify(`delegate: ${warning}`, "warning");
		}
	}

	/** The refusal for an empty roster. */
	const noAgents = (): string => `no agents are defined; add ${whereAgentsGo(getAgentDir())}`;

	/**
	 * The request as a start, or an error naming what to fix. `byUser` marks the
	 * `/delegate` command and form: there a model the user names, with no
	 * routing metadata, launches a bound role outside its routing profile.
	 */
	async function validate(request: Parsed, roster: Roster, ctx: ExtensionContext, byUser = false): Promise<Start> {
		admit(request.agent, roster);
		results.checkStorage(true);
		const disabled = disabledProblem(roster, request.agent);
		if (disabled !== undefined) throw new Error(disabled);
		if (roster.agents.length === 0) throw new Error(noAgents());
		const agent = roster.agents.find((candidate) => candidate.name === request.agent);
		if (agent === undefined) {
			throw new Error(
				`no agent named ${JSON.stringify(request.agent)}; available: ${roster.agents.map((item) => item.name).join(", ")}`,
			);
		}
		if (request.task.trim() === "") throw new Error("a task is required");
		const parent = parentDefaults(ctx);
		const own = agentModels(agent, parent.model);
		const defaultThinking = agent.thinking ?? parent.thinking;
		const unlocked = withoutLocked(agent, request, { model: own[0], thinking: defaultThinking });
		const thinking = unlocked.request.thinking ?? defaultThinking;
		if (request.routing !== undefined && !agent.routingProfile)
			throw new Error("routing metadata requires an agent with routing_profile");
		const userModel = byUser && request.routing === undefined && unlocked.request.model !== undefined;
		const chosen: Awaited<ReturnType<typeof chooseModel>> & { routing?: RoutingRecord; thinking?: string } =
			agent.routingProfile && !userModel
				? await routing.choose(agent, request.routing, ctx, {
						model: agent.locked.includes("model") ? own[0] : unlocked.request.model,
						thinking: isThinking(unlocked.request.thinking ?? "")
							? (unlocked.request.thinking as import("./agents.ts").Thinking)
							: agent.locked.includes("thinking")
								? (defaultThinking as import("./agents.ts").Thinking)
								: undefined,
					})
				: await chooseModel(unlocked.request.model, agent, ctx.modelRegistry, proactive, own);
		const { model, skipped, rest } = chosen;
		const unrouted =
			agent.routingProfile && userModel
				? [`${agent.name} runs on ${model}, the model you chose, outside routing profile ${agent.routingProfile}`]
				: [];
		const notices = [...(unlocked.notice === undefined ? [] : [unlocked.notice]), ...unrouted, ...chosen.notices];
		const badThinking = thinkingProblem(thinking);
		if (badThinking !== undefined) throw new Error(badThinking);
		const badLabel = request.label === undefined ? undefined : labelProblem(request.label);
		if (badLabel !== undefined) throw new Error(badLabel);
		return {
			agent,
			model,
			skipped,
			notices,
			rest,
			thinking: chosen.thinking ?? thinking,
			...(chosen.routing ? { routing: chosen.routing } : {}),
			label: request.label,
			cwd: request.cwd,
			worktree: request.worktree,
			worktree_base: request.worktree_base,
			worktree_source: request.worktree_source,
			autoExit: request.autoExit ?? agent.autoExit,
			task: request.task,
		};
	}

	const admission = createHostAdmission(tmux, () => windowSettings(getAgentDir()));
	const starter = createDelegateStart({
		pi,
		host: tmux,
		identity,
		results,
		admit: (agent, ctx) => admit(agent, currentRoster(ctx)),
		startPolling: tracking.startPolling,
	});

	async function launch(
		start: Start,
		ctx: ExtensionContext,
		signal?: AbortSignal,
		toolCallId?: string,
		fork?: ForkSource,
	): Promise<Launched> {
		admit(start.agent.name, currentRoster(ctx));
		results.checkStorage(true);
		const admitted = await admission.admit();
		const { placement, companionSuffix } = admitted;
		const parentIdentity = identity.current();
		const project = parentIdentity
			? { companion: parentIdentity.rootPlacement, notices: [] }
			: fork
				? { companion: fork.rootPlacement, notices: [] }
				: placementProject(ctx.cwd, companionSuffix);
		assertRootPlacement(project.companion);
		const own = starter.childIdentity(start.agent, ctx, project.companion);
		if (placement === "companion") start.notices.push(...project.notices);
		const tools = childTools(start.agent);
		const sessionDir = fork?.sessionDir ?? ctx.sessionManager.getSessionDir();
		if (!isAbsolute(sessionDir))
			throw new Error(
				`the parent's session directory ${JSON.stringify(sessionDir)} is not an absolute path; start Pi with an absolute --session-dir`,
			);
		const cwdOption = normalizeWorkspaceValue(start.cwd, "cwd");
		const worktreeOption = normalizeWorkspaceValue(start.worktree, "worktree");
		const baseOption = normalizeWorkspaceValue(start.worktree_base, "worktree_base");
		const sourceOption = normalizeWorkspaceValue(start.worktree_source, "worktree_source");
		if (sourceOption !== undefined && worktreeOption === undefined)
			throw new Error("worktree_source requires worktree");
		if (baseOption !== undefined && worktreeOption === undefined) throw new Error("worktree_base requires worktree");
		if (cwdOption !== undefined && worktreeOption !== undefined)
			throw new Error("cwd and worktree are mutually exclusive; name only one");
		const signals = [signal, ctx.signal].filter((item): item is AbortSignal => item !== undefined);
		const combined = signals.length ? AbortSignal.any(signals) : undefined;
		let plan: WorktreePlan | undefined;
		let directory: Workspace | undefined;
		let trusted: boolean;
		let revalidateTrust: (() => void) | undefined;
		if (worktreeOption !== undefined) {
			plan = await prepareWorktree(
				{
					worktree: worktreeOption,
					...(baseOption === undefined ? {} : { worktree_base: baseOption }),
					...(sourceOption === undefined ? {} : { worktree_source: sourceOption }),
				},
				ctx,
				getAgentDir(),
			);
			if (combined?.aborted) throw new Error("the launch was aborted");
			const trust = await trustPlannedWorktree(
				plan,
				ctx,
				getAgentDir(),
				combined,
				trustControl.forAgent(start.agent.name, ctx),
			);
			if (combined?.aborted) throw new Error("the launch was aborted");
			trusted = trust.trusted;
			revalidateTrust = trust.revalidate;
			plan.trusted = trusted;
		} else {
			const prepared = await prepareDirectory(
				{ cwd: cwdOption, signal, trust: trustControl.forAgent(start.agent.name, ctx) },
				ctx,
				getAgentDir(),
			);
			directory = prepared.workspace;
			trusted = prepared.trusted;
		}
		const id = randomUUID();
		const parentId = ctx.sessionManager.getSessionId();
		let attempt: WorkspaceAttempt | undefined;
		let managed: Extract<Workspace, { mode: "managed" }> | undefined;
		let windowOpened = false;
		let reservation: Reservation | undefined;
		const run = async (): Promise<Launched> => {
			admit(start.agent.name, currentRoster(ctx));
			results.checkStorage(true);
			reservation = await starter.reserve(
				{
					id,
					sessionId: id,
					identity: own,
					sessionDir,
					...(fork ? { forkedFrom: fork.id } : {}),
				},
				start.agent.name,
				ctx,
				combined,
			);
			if (plan !== undefined) {
				revalidate(plan);
				revalidateTrust?.();
				attempt = {
					kind: "workspace-attempt",
					id,
					parentId,
					agent: start.agent.name,
					model: start.model,
					thinking: start.thinking,
					...(start.label === undefined ? {} : { name: start.label }),
					sessionDir,
					plan,
					attempt: { phase: "planned", resources: { kind: "none" } },
				};
				results.recordAttempt(attempt, ctx);
				const created = createWorktree(plan);
				if (!("workspace" in created)) {
					const recovery = recoveryCommands(plan, created.resources);
					attempt = {
						...attempt,
						attempt:
							created.resources.kind === "none"
								? { phase: "rolled-back", resources: { kind: "none" }, cause: created.cause }
								: { phase: "retained", resources: created.resources, cause: created.cause, recovery },
					};
					results.recordAttempt(attempt, ctx);
					throw new Error(
						`worktree launch ${id} from ${plan.sourceCwd} failed at ${plan.destination} (${plan.branch}): ${created.cause}; ${resourceLine(created.resources)}${recovery.length ? `; recovery: ${recovery.join("; ")}` : created.resources.kind === "worktree" ? "; inspect and preserve its contents before any cleanup" : ""}`,
					);
				}
				managed = created.workspace;
				attempt = {
					...attempt,
					attempt: {
						phase: "created",
						resources: { kind: "worktree", cwd: managed.cwd, branch: managed.createdBranch, head: managed.baseCommit },
					},
				};
				results.recordAttempt(attempt, ctx);
			}
			let workspace: Workspace;
			if (managed !== undefined) workspace = managed;
			else if (directory !== undefined) workspace = directory;
			else throw new Error("workspace preparation did not produce a launch directory");
			const name = delegateName(start.agent.displayName ?? start.agent.name, id, start.label);
			const { opened, requestId, forkSourcePath } = await starter.start(
				{
					identity: own,
					id,
					name,
					session: fork
						? {
								kind: "fork",
								id: fork.id,
								path: fork.sessionPath,
								sessionId: fork.sessionId,
								sourceCwd: fork.sourceCwd,
							}
						: { kind: "launch" },
					workspace,
					trusted,
					sessionDir,
					start,
					task: start.task,
					toolCallId,
					admission: admitted,
					tools,
					onMailed: (requestId) => {
						if (attempt !== undefined) {
							attempt = { ...attempt, requestId };
							results.recordAttempt(attempt, ctx);
						}
					},
					onWindowOpened: () => {
						windowOpened = true;
					},
				},
				ctx,
			);
			if (fork && forkSourcePath) fork.sessionPath = forkSourcePath;
			return {
				id,
				name,
				windowId: opened.id,
				windowName: name,
				windowSession: opened.session,
				requestId,
				cwd: workspace.cwd,
				sessionDir,
				workspace,
				location: opened.location,
			};
		};
		const runWithRollback = async (): Promise<Launched> => {
			try {
				return await run();
			} catch (error) {
				if (reservation) starter.refund(reservation, ctx);
				if (attempt !== undefined && managed !== undefined) {
					const cause = (error as Error).message;
					if (windowOpened || (error instanceof WindowOpenError && error.certainty === "unknown")) {
						attempt = {
							...attempt,
							attempt: {
								phase: "retained",
								resources: {
									kind: "worktree",
									cwd: managed.cwd,
									branch: managed.createdBranch,
									head: managed.baseCommit,
								},
								cause,
								recovery: [],
							},
						};
					} else {
						const rollbackPlan = plan;
						if (rollbackPlan === undefined) throw error;
						const rolled = rollbackWorktree(rollbackPlan, managed);
						attempt =
							rolled.kind === "rolled-back"
								? { ...attempt, attempt: { phase: "rolled-back", resources: { kind: "none" }, cause } }
								: {
										...attempt,
										attempt: {
											phase: "retained",
											resources: rolled.resources,
											cause: `${cause}; ${rolled.reason}`,
											recovery: recoveryCommands(rollbackPlan, rolled.resources),
										},
									};
					}
					results.recordAttempt(attempt, ctx);
					const state = attempt.attempt;
					const recovery =
						state.phase !== "retained"
							? ""
							: state.recovery.length > 0
								? `; recovery: ${state.recovery.join("; ")}`
								: state.resources.kind === "worktree"
									? "; inspect and preserve its contents before any cleanup"
									: "";
					throw new Error(
						`worktree launch ${id} from ${managed.sourceCwd} at ${managed.cwd} (${managed.createdBranch}) failed: ${cause}; outcome ${state.phase}${recovery}`,
						{ cause: error },
					);
				}
				throw error;
			}
		};
		if (plan === undefined) return runWithRollback();
		return inQueue(plan.source.commonDir, combined, runWithRollback);
	}

	const resumer = createResume({
		results,
		tmux,
		delegateSchema: DelegateSchema,
		admission,
		starter,
		childTools,
		roster: rosterFor,
		admit: (agent, ctx) => admit(agent, currentRoster(ctx)),
		authorize: (id, ctx) => {
			owner.assert();
			results.checkStorage();
			const record = results.find(id) ?? viewResults.find(id) ?? historicalRecord(id, ctx);
			if (record && isStarted(record)) assertResumeAuthority(record, ctx);
		},
		parentDefaults,
		chooseModel: (explicit, agent, models, preferred) =>
			chooseModel(explicit, agent, models, proactive, agentModels(agent, undefined), preferred),
		thinkingProblem,
		chooseRouting: (agent, request, ctx, options) => routing.choose(agent, request, ctx, options),
		prepareDirectory: (cwd, ctx, signal, agent) =>
			prepareDirectory({ cwd, signal, trust: trustControl.forAgent(agent, ctx) }, ctx, getAgentDir()),
	});

	/** Where a selected directory put the delegate, for the start text; inherited starts stay compact. */
	const placedIn = (launched: Launched): string =>
		launched.workspace.mode !== "inherited" ? ` in ${launched.cwd}` : "";

	const started = (launched: Launched, start: Start): string =>
		`delegate: ${start.agent.name} ${launched.id} started in ${openedIn(launched)}${placedIn(launched)}${launched.workspace.mode === "managed" ? `. Branch ${launched.workspace.createdBranch} starts at ${launched.workspace.baseCommit}. ${dirtyNotice(launched.workspace.sourceDirty)}` : ""}${start.skipped.length > 0 ? `. ${fallbackNote(start)}` : ""}${start.notices.map((line) => `. ${line}`).join("")}`;

	/** Start a delegate from a parsed `/delegate` or the form, telling the user how it went. */
	async function runDelegate(parsed: Parsed, ctx: ExtensionContext): Promise<void> {
		const fail = (message: string) => ctx.ui.notify(`delegate: ${message}`, "error");
		try {
			const cwd = normalizeWorkspaceValue(parsed.cwd, "--cwd");
			const worktree_source = normalizeWorkspaceValue(parsed.worktree_source, "--worktree-source");
			const worktree_base = normalizeWorkspaceValue(parsed.worktree_base, "--worktree-base");
			const worktree = normalizeWorkspaceValue(parsed.worktree, "--worktree");
			if (worktree_source !== undefined && worktree === undefined)
				throw new Error("--worktree-source requires --worktree");
			const start = await validate(
				{ ...parsed, cwd, worktree, worktree_base, worktree_source },
				rosterFor(ctx),
				ctx,
				true,
			);
			const launched = await launch(start, ctx);
			ctx.ui.notify(started(launched, start), "info");
		} catch (err) {
			fail((err as Error).message);
		}
	}

	/** What the no-argument `/delegate` form needs. */
	const newDelegateDeps: NewDelegateDeps = {
		unavailable: admission.probe,
		roster: rosterFor,
		noAgents,
		defaults: (agent, ctx) => {
			if (agent.routingProfile) return { model: undefined, thinking: "" };
			const parent = parentDefaults(ctx);
			const model = agentModels(agent, parent.model)[0];
			return { ...(model === undefined ? {} : { model }), thinking: agent.thinking ?? parent.thinking };
		},
		labelProblem,
		start: (request: NewRequest, context) => runDelegate(request, context),
	};

	/** `/delegate`: with no arguments the new-delegate form, otherwise the typed request. */
	async function command(input: string, ctx: ExtensionContext): Promise<void> {
		if (input.trim() === "") {
			await startNewDelegate(ctx, newDelegateDeps);
			return;
		}
		const outcome = parse(input);
		if ("error" in outcome) {
			ctx.ui.notify(`delegate: ${outcome.error}`, "error");
			return;
		}
		await runDelegate(outcome.parsed, ctx);
	}

	async function resumePicker(ctx: ExtensionContext, id?: string): Promise<void> {
		await pickResume(
			ctx,
			{
				unavailable: admission.probe,
				eligible: resumer.eligible,
				resume: async (request, context) => {
					try {
						const record = viewResults.find(request.id);
						const agent = currentRoster(context).agents.find((agent) => agent.name === record?.agent);
						const routing = agent?.routingProfile ? await promptRouting(context, agent.name) : undefined;
						if (agent?.routingProfile && !routing) return;
						context.ui.notify(startedLine(await resumer.resume({ ...request, routing }, context)), "info");
					} catch (err) {
						context.ui.notify(`delegate: ${(err as Error).message}`, "error");
					}
				},
			},
			id,
		);
	}

	async function resumeCommand(input: string, ctx: ExtensionContext): Promise<void> {
		if (input.trim() === "") return resumePicker(ctx);
		const outcome = parseResume(input);
		if ("error" in outcome) {
			ctx.ui.notify(`delegate: ${outcome.error}`, "error");
			return;
		}
		try {
			ctx.ui.notify(startedLine(await resumer.resume(outcome.request, ctx)), "info");
		} catch (err) {
			ctx.ui.notify(`delegate: ${(err as Error).message}`, "error");
		}
	}

	/** The roster description last registered, so unchanged metadata is not registered again. */
	let registeredDescription: string | undefined;

	const delegateTool = (description: string, includeRouting: boolean) => ({
		name: "delegate",
		label: "Delegate",
		description,
		parameters: Type.Object({
			agent: Type.String({ description: "Roster agent name." }),
			task: Type.String(),
			...(includeRouting ? { routing: Type.Optional(RoutingRequestSchema) } : {}),
			model: Type.Optional(Type.String({ description: "provider/id; defaults to the agent's." })),
			thinking: Type.Optional(Type.String({ description: `${THINKING_LEVELS.join(", ")}; defaults to the agent's.` })),
			label: Type.Optional(
				Type.String({
					description: `Window and session name suffix: letters, digits, _ or -, at most ${LABEL_MAX}.`,
				}),
			),
			cwd: Type.Optional(
				Type.Union([Type.String(), Type.Null()], { description: "Existing directory to run in. Not with worktree." }),
			),
			worktree: Type.Optional(
				Type.Union([Type.String(), Type.Null()], {
					description: "New branch name: creates a managed worktree from HEAD or worktree_base. Not with cwd.",
				}),
			),
			worktree_source: Type.Optional(
				Type.Union([Type.String(), Type.Null()], { description: "Git checkout to create the worktree from." }),
			),
			worktree_base: Type.Optional(
				Type.Union([Type.String(), Type.Null()], { description: "Local commit-ish for the worktree branch." }),
			),
			auto_exit: Type.Optional(
				Type.Boolean({
					description: "Close the window when it finishes; defaults to the agent's. False keeps it open for mail.",
				}),
			),
		}),
		outputSchema: DelegateSchema,
		renderCall: renderDelegateCall,
		renderResult: renderDelegateResult,
		// Opens a new window each call and removes nothing. Open world: the delegate calls a remote model and runs its agent's tools unattended.
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		async execute(
			toolCallId: string,
			params: {
				agent: string;
				task: string;
				routing?: RoutingRequest;
				model?: string | null;
				thinking?: string | null;
				label?: string | null;
				auto_exit?: boolean | null;
				cwd?: unknown;
				worktree?: unknown;
				worktree_base?: unknown;
				worktree_source?: unknown;
			},
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			const refusal = admission.probe();
			if (refusal !== undefined) throw new Error(refusal);
			// Some models fill every optional field with null or the string "null"; both mean unset.
			const given = (value: string | null | undefined) => (value == null || value === "null" ? undefined : value);
			const cwd = normalizeWorkspaceValue(params.cwd, "cwd");
			const worktree = normalizeWorkspaceValue(params.worktree, "worktree");
			const worktree_base = normalizeWorkspaceValue(params.worktree_base, "worktree_base");
			const worktree_source = normalizeWorkspaceValue(params.worktree_source, "worktree_source");
			const start = await validate(
				{
					agent: params.agent,
					routing: params.routing,
					model: given(params.model),
					thinking: given(params.thinking),
					label: given(params.label),
					cwd,
					worktree,
					worktree_base,
					worktree_source,
					autoExit: typeof params.auto_exit === "boolean" ? params.auto_exit : undefined,
					task: params.task ?? "",
				},
				rosterFor(ctx),
				ctx,
			);
			const launched = await launch(start, ctx, signal, toolCallId);
			ctx.ui.notify(started(launched, start), "info");
			return toolResult(
				`Started delegation ${launched.id}: ${start.agent.name} (${start.model}, thinking ${start.thinking}) in ${openedIn(launched)}${placedIn(launched)}.${launched.workspace.mode === "managed" ? ` Branch ${launched.workspace.createdBranch} starts at ${launched.workspace.baseCommit}. ${dirtyNotice(launched.workspace.sourceDirty)}` : ""} It runs in the background, and its result arrives as a message that starts your next turn on its own; delegation_close ends it.${start.skipped.length > 0 ? ` ${fallbackNote(start)}` : ""}${start.notices.map((line) => ` ${line}`).join("")}`,
				{
					outcome: "started",
					...(start.routing ? { routing: start.routing } : {}),
					id: launched.id,
					agent: start.agent.name,
					model: start.model,
					skipped: start.skipped.map(({ model, reason }) => ({ model, reason })),
					notices: start.notices,
					thinking: start.thinking,
					autoExit: start.autoExit,
					windowId: launched.windowId,
					windowName: launched.windowName,
					...(launched.windowSession === undefined ? {} : { windowSession: launched.windowSession }),
					cwd: launched.cwd,
					sessionDir: launched.sessionDir,
					workspace: launched.workspace,
				},
			);
		},
	});

	const registerDelegate = (description: string): void => {
		pi.registerTool(
			delegateTool(
				description,
				currentRoster().agents.some((agent) => agent.routingProfile),
			) as never,
		);
		registeredDescription = description;
	};

	pi.on("session_start", (_event, ctx) => {
		registry = ctx.modelRegistry;
		latest = ctx;
		// The roster is read at call time; the description is rebuilt here and before each run.
		const roster = currentRoster(ctx);
		announced.clear();
		announce(roster, ctx);
		registerDelegate(toolDescription(roster.agents, getAgentDir()));
		registerRoutingTools(roster);
		exposeDelegation(roster);
	});

	// One roster/prompt snapshot prepares this run: refresh the description only when
	// it changed, and replace only this extension's prompt section from the same snapshot.
	pi.on("before_agent_start", (event, ctx) => {
		latest = ctx;
		const own = identity.current();
		const roster = currentRoster(ctx);
		if (own)
			event.systemPromptOptions.sections.squire_delegate_task = `You are a delegate. ${parentTrust(own.parent, coordinates(roster))}`;
		else delete event.systemPromptOptions.sections.squire_delegate_task;
		registerRoutingTools(roster);
		exposeDelegation(roster);
		announce(roster, ctx);
		const description = toolDescription(roster.agents, getAgentDir());
		const prompt = readParentPrompt();
		const visible = delegateVisible(event.systemPromptOptions) && pi.getActiveTools().includes("delegate");
		// Report a read failure even when guidance cannot be used, so it does not go unseen.
		if (prompt.error !== undefined) ctx.ui.notify(`delegate: ${prompt.error}`, "warning");
		if (visible && description !== registeredDescription) registerDelegate(description);
		if (!visible || prompt.error !== undefined || prompt.text === undefined) {
			delete event.systemPromptOptions.sections[PARENT_SECTION];
			return;
		}
		event.systemPromptOptions.sections[PARENT_SECTION] = prompt.text;
	});

	pi.on("session_shutdown", () => {
		tracking.stop();
	});
	host.on("session_shutdown", () => owner.stop());

	pi.registerCommand("delegate", {
		description: `Start a delegate Pi session in a background terminal: ${USAGE}`,
		getArgumentCompletions: (prefix) =>
			completions(
				prefix,
				() => currentRoster().agents.map((agent) => agent.name),
				() => modelIds(registry),
				() =>
					currentRoster()
						.agents.filter((agent) => agent.routingProfile)
						.map((agent) => agent.name),
			),
		handler: command,
	});

	pi.registerCommand("delegate-resume", {
		description: `Reopen an exited delegate's session in a new window with a follow-up task: ${RESUME_USAGE}`,
		getArgumentCompletions: (prefix) =>
			resumeCompletions(
				prefix,
				() => resumableIds(results),
				() => modelIds(registry),
				() =>
					results
						.list()
						.filter((record) => isStarted(record) && record.routing)
						.map((record) => record.id),
			),
		handler: resumeCommand,
	});

	const navigator = createNavigator(viewResults, tmux, tracking, {
		assertActive: () => owner.assert(),
		close: (id, ctx) => tracking.close(id, ctx),
	});

	pi.registerCommand("delegate-open", {
		description: `Reach one open delegate: ${OPEN_USAGE}`,
		getArgumentCompletions: async (prefix: string) => openCompletions(prefix, await navigator.openIds()),
		handler: async (args: string, ctx: ExtensionContext) => {
			const parsed = parseOpen(args);
			if ("error" in parsed) return ctx.ui.notify(`delegate: ${parsed.error}`, "error");
			await navigator.openDelegate(ctx, parsed.id, parsed.mode);
		},
	});

	pi.registerCommand("delegate-clear", {
		description: "Clear usage-limit marks: all, a provider, or a provider/model",
		getArgumentCompletions: (prefix: string) => {
			const hits = [
				"all",
				...readMarks()
					.filter((m) => m.clearsAt > Date.now())
					.map((m) => m.scope),
			].filter((v) => v.startsWith(prefix.trim()));
			return hits.length > 0 ? hits.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args: string, ctx: ExtensionContext) => {
			const target = args.trim();
			const cleared = target === "" ? [] : clearMarks(target);
			if (cleared.length > 0) proactive.clear();
			const active = readMarks().filter((m) => m.clearsAt > Date.now());
			const list = active.map((m) => `${m.scope} until ${new Date(m.clearsAt).toISOString()}`).join(", ");
			ctx.ui.notify(
				cleared.length > 0
					? `delegate-clear: cleared ${cleared.join(", ")}.`
					: active.length === 0
						? "delegate-clear: no usage-limit marks are active."
						: `delegate-clear: ${target === "" ? "name a mark to clear" : `no active mark matches "${target}"`}. Active marks: ${list}. Use all, a provider or provider/model.`,
				"info",
			);
		},
	});

	const forkDeps: Parameters<typeof forkTool>[0] = {
		results,
		tmux,
		delegateSchema: DelegateSchema,
		roster: rosterFor,
		parentDefaults,
		chooseModel: (explicit, agent, models, preferred) =>
			chooseModel(explicit, agent, models, proactive, agentModels(agent, undefined), preferred),
		thinkingProblem,
		chooseRouting: (agent, request, ctx, options) => routing.choose(agent, request, ctx, options),
		authorize: (id, ctx) => {
			owner.assert();
			results.checkStorage();
			const record = results.find(id) ?? viewResults.find(id) ?? historicalRecord(id, ctx);
			if (record && isStarted(record)) assertChildAuthority(record, ctx, "fork");
		},
		admit: (agent, ctx) => admit(agent, currentRoster(ctx)),
		launch: async (start, source, ctx, signal, toolCallId) => {
			const input = {
				...start,
				cwd: start.worktree ? undefined : start.cwd,
				worktree_source: start.worktree ? start.cwd : undefined,
			};
			const launched = await launch(input, ctx, signal, toolCallId, source);
			return {
				...(input.routing ? { routing: input.routing } : {}),
				id: launched.id,
				agent: start.agent.name,
				model: input.model,
				skipped: start.skipped.map(({ model, reason }) => ({ model, reason })),
				notices: start.notices,
				thinking: input.thinking,
				autoExit: start.autoExit,
				windowId: launched.windowId,
				windowName: launched.windowName,
				...(launched.windowSession === undefined ? {} : { windowSession: launched.windowSession }),
				...(launched.location === undefined ? {} : { location: launched.location }),
				cwd: launched.cwd,
				sessionDir: launched.sessionDir,
				workspace: launched.workspace,
			};
		},
	};
	let routingMetadata: boolean | undefined;
	function registerRoutingTools(roster: Roster): void {
		const enabled = roster.agents.some((agent) => agent.routingProfile);
		if (enabled === routingMetadata) return;
		const previous = routingMetadata === undefined ? undefined : new Set(pi.getActiveTools());
		pi.registerTool(resumer.tool(enabled) as never);
		pi.registerTool(forkTool(forkDeps, enabled) as never);
		routingMetadata = enabled;
		if (previous)
			pi.setActiveTools(
				pi
					.getActiveTools()
					.filter((name) => !["delegation_resume", "delegation_fork"].includes(name) || previous.has(name)),
			);
	}
	registerDelegate(toolDescription(currentRoster().agents, getAgentDir()));
	tracking.registerTools();
	registerRoutingTools(currentRoster());
}
