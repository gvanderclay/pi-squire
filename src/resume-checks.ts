// The checks a resume makes before it launches anything, shared by `resume`
// and the resume picker so both accept the same delegations: the call-wide
// prerequisites once, then per record the window, session file, agent, thinking
// level and model. None of them changes anything; killing an exited window and
// deciding trust stay with the resume itself.

import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Agent, disabledProblem, isThinking, withoutLocked } from "./agents.ts";
import { sessionHeaderCwd, sessionIdOf, sessionThinking } from "./result-sessions.ts";
import { deriveState, finishedModel, locateSession, type StartedRecorded } from "./results.ts";
import type { ResumeDeps, ResumeRequest } from "./resume.ts";
import { ownerDetails, sessionIsOwned } from "./session-owner.ts";
import { requireTmuxVersion, type TmuxWindow } from "./tmux.ts";
import { ownWindow, windowState } from "./tracking.ts";
import { assertResumeAuthority } from "./tree-view.ts";
import type { WindowPlacement } from "./window-placement.ts";

/**
 * Steps 3 and 4: no process of this delegate is left. A running delegate is
 * mailed instead; tmux that cannot be asked proves nothing; a window with the
 * record's id and name that still runs its program is refused, and one whose
 * program exited is killed first.
 */
export function windowCheck(record: StartedRecorded, windows: TmuxWindow[] | undefined): TmuxWindow | undefined {
	const state = deriveState(record, windowState(windows, record));
	if (state === "running") {
		throw new Error(`delegation ${record.id} is running; send it a message instead of resuming it`);
	}
	if (windows === undefined || state === "unknown") {
		throw new Error(`could not ask tmux whether delegation ${record.id}'s window is open, so it is not resumed`);
	}
	const own = ownWindow(windows, record);
	if (own !== undefined && !own.exited) {
		throw new Error(
			`delegation ${record.id}'s window ${record.windowName} (${record.windowId}) is still open; its Pi may still be running, so it is not resumed. Close it with delegation_close, or send it a message`,
		);
	}
	return own;
}

/** Whether `path` is an existing directory. */
export function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** A delegate's session file, the directory its header says Pi runs it in, and the session directory to pass. */
export type SessionFile = { path: string; cwd: string; dir: string };

/** Step 5: the session file, and the directory its header says Pi will run it in. */
export function sessionFor(record: StartedRecorded, ctx: ExtensionContext): SessionFile {
	const dir = record.sessionDir ?? ctx.sessionManager.getSessionDir();
	const path = locateSession(record, ctx.sessionManager.getSessionDir());
	if (path === undefined) {
		throw new Error(
			`no session file for session ${sessionIdOf(record)} was found in ${dir}, so delegation ${record.id} is not resumable`,
		);
	}
	if (!isAbsolute(path) || !isAbsolute(dir)) {
		throw new Error(
			`the session file ${path} or its directory ${dir} is not an absolute path, so delegation ${record.id} is not resumable`,
		);
	}
	const cwd = sessionHeaderCwd(path);
	if (cwd === undefined) {
		throw new Error(
			`could not read a working directory from the header of ${path}, so delegation ${record.id} is not resumable`,
		);
	}
	if (!isDirectory(cwd)) {
		throw new Error(
			`delegation ${record.id}'s session runs in ${cwd}, which no longer exists, so it is not resumable (a removed worktree cannot be resumed)`,
		);
	}
	return { path, cwd, dir };
}

/**
 * What a resume runs with when the call passes nothing. A field the agent
 * locks takes the agent file's current value, or the parent's current one when
 * the file sets none, even when the delegate last ran on another (a fallback
 * after a usage limit, or a value from before the file changed). A field it
 * does not lock keeps what the delegate last ran on: the model of its last
 * answer, and the thinking level its session last changed to, or the
 * recorded ones when the session does not say. The models are in order, the
 * agent's fallbacks after the first.
 */
export function resumeDefaults(
	record: StartedRecorded,
	agent: Agent,
	sessionPath: string,
	parent: { model?: string; thinking: string },
): { models: string[]; thinking: string } {
	const first = agent.locked.includes("model")
		? (agent.model ?? parent.model)
		: (finishedModel(sessionPath) ?? record.result?.finishedModel ?? record.model);
	const thinking = agent.locked.includes("thinking")
		? (agent.thinking ?? parent.thinking)
		: lastThinking(record, sessionPath);
	return { models: [...new Set([...(first === undefined ? [] : [first]), ...agent.fallback])], thinking };
}

/** The thinking level the delegate last ran on: its session's last change, else the level recorded at its start. */
function lastThinking(record: StartedRecorded, sessionPath: string): string {
	const level = sessionThinking(sessionPath);
	return level !== undefined && isThinking(level) ? level : record.thinking;
}

export function assertNoOwner(record: StartedRecorded): void {
	if (sessionIsOwned(sessionIdOf(record)))
		throw new Error(
			`delegation ${record.id} is already open in another process: ${ownerDetails(sessionIdOf(record))}; send it a message instead of resuming it`,
		);
}

/** Steps 5 and 6: the session file and the agent, and no resume of the delegation already under way. */
export function recordCheck(
	deps: ResumeDeps,
	record: StartedRecorded,
	ctx: ExtensionContext,
): { session: SessionFile; agent: Agent } {
	assertResumeAuthority(record, ctx);
	assertNoOwner(record);
	deps.authorize?.(record.id, ctx);
	deps.admit?.(record.agent, ctx);
	const session = sessionFor(record, ctx);
	const roster = deps.roster(ctx);
	const disabled = disabledProblem(roster, record.agent);
	if (disabled !== undefined) throw new Error(`${disabled}, so delegation ${record.id} is not resumed`);
	const agent = roster.agents.find((item) => item.name === record.agent);
	if (agent === undefined) {
		throw new Error(
			`agent ${JSON.stringify(record.agent)} is no longer in the roster, so delegation ${record.id} is not resumed`,
		);
	}
	if (inFlight.has(record.id)) throw new Error(`delegation ${record.id} is already being resumed`);
	return { session, agent };
}

/** The thinking level and model a resume runs with; throws when the level is invalid or no model can be used. */
export async function settleModel(
	deps: ResumeDeps,
	input: {
		record: StartedRecorded;
		agent: Agent;
		session: SessionFile;
		request: Pick<ResumeRequest, "model" | "thinking">;
	},
	ctx: ExtensionContext,
): Promise<{ thinking: string; chosen: Awaited<ReturnType<ResumeDeps["chooseModel"]>> }> {
	const { record, agent, session } = input;
	const defaults = resumeDefaults(record, agent, session.path, deps.parentDefaults(ctx));
	const { request, notice } = withoutLocked(agent, input.request, {
		model: defaults.models[0],
		thinking: defaults.thinking,
	});
	const thinking = request.thinking ?? defaults.thinking;
	const badThinking = deps.thinkingProblem(thinking);
	if (badThinking !== undefined) throw new Error(badThinking);
	const chosen = await deps.chooseModel(request.model, agent, ctx.modelRegistry, defaults.models);
	return { thinking, chosen: notice === undefined ? chosen : { ...chosen, notices: [notice, ...chosen.notices] } };
}

/** The call-wide prerequisites of a resume: inside tmux, a new enough tmux, a valid placement setting (read once). */
export async function preflight(deps: ResumeDeps): Promise<WindowPlacement> {
	if (!deps.tmux.insideTmux()) throw new Error(deps.notInTmux);
	await requireTmuxVersion(deps.tmux);
	return deps.placement();
}

/** The delegation ids with a resume under way in this process. */
export const inFlight = new Set<string>();

/** Whether `record` passes every check a resume makes that changes nothing; the resume's own kill of an exited window and trust prompt are left to it. */
export async function passes(
	deps: ResumeDeps,
	record: StartedRecorded,
	windows: TmuxWindow[],
	ctx: ExtensionContext,
	models: Map<string, boolean>,
): Promise<boolean> {
	try {
		windowCheck(record, windows);
		const { session, agent } = recordCheck(deps, record, ctx);
		// Model choice depends on the agent and where the delegate ended, so records alike share one answer.
		const key = JSON.stringify([agent.name, resumeDefaults(record, agent, session.path, deps.parentDefaults(ctx))]);
		let ok = models.get(key);
		if (ok === undefined) {
			ok = await settleModel(deps, { record, agent, session, request: {} }, ctx).then(
				() => true,
				() => false,
			);
			models.set(key, ok);
		}
		return ok;
	} catch {
		return false;
	}
}
