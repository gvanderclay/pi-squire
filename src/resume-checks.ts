// The checks a resume makes before it launches anything, shared by `resume`
// and the resume picker so both accept the same delegations: the call-wide
// prerequisites once, then per record the window, session file, agent, thinking
// level and model. None of them changes anything; killing an exited window and
// deciding trust stay with the resume itself.
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { Agent } from "./agents.ts";
import { sessionHeaderCwd, sessionIdOf } from "./result-sessions.ts";
import { deriveState, finishedModel, locateSession, type StartedRecorded } from "./results.ts";
import type { ResumeDeps, ResumeRequest } from "./resume.ts";
import { requireTmuxVersion, type TmuxWindow } from "./tmux.ts";
import { ownWindow, windowState } from "./tracking.ts";
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

/** The model choices: an explicit model alone, else where the delegate ended, then the agent's fallbacks. */
export function preferredModels(record: StartedRecorded, agent: Agent, sessionPath: string): string[] {
	const ended = finishedModel(sessionPath) ?? record.result?.finishedModel ?? record.model;
	return [...new Set([ended, ...agent.fallback])];
}

/** Steps 5 and 6: the session file and the agent, and no resume of the delegation already under way. */
export function recordCheck(
	deps: ResumeDeps,
	record: StartedRecorded,
	ctx: ExtensionContext,
): { session: SessionFile; agent: Agent } {
	const session = sessionFor(record, ctx);
	const agent = deps.roster(ctx).agents.find((item) => item.name === record.agent);
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
	const { record, agent, session, request } = input;
	const thinking = request.thinking ?? record.thinking;
	const badThinking = deps.thinkingProblem(thinking);
	if (badThinking !== undefined) throw new Error(badThinking);
	const preferred = preferredModels(record, agent, session.path);
	return { thinking, chosen: await deps.chooseModel(request.model, agent, ctx.modelRegistry, preferred) };
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
		const key = JSON.stringify([record.thinking, agent.name, preferredModels(record, agent, session.path)]);
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
