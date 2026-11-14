// Full and compact delegation_status blocks; structured details live in tracking.ts.

import { locationTerms, recordedLocation } from "./location.ts";
import { autoExitText } from "./locators.ts";
import { attemptLines, cwdLine, modelLabel, snapshotLines, workspaceLine } from "./render.ts";
import {
	type DelegationState,
	recordedName,
	type StartedRecorded,
	sessionIdOf,
	type WorkspaceAttempt,
} from "./results.ts";
import { servedSummary } from "./routing-provenance.ts";
import type { RoutingEvidence } from "./routing-types.ts";
import { type SessionUsage, usageText } from "./session-usage.ts";
import type { WorkspaceSnapshot } from "./snapshot.ts";
import { accountingFor } from "./tree-view.ts";

/** Records from before auto-exit existed kept their windows open, so they read off. */
export function autoExitLine(record: StartedRecorded): string {
	return autoExitText(record, record.autoExit === true);
}

/** The state, worded for the `state:` line. */
export function stateLine(state: DelegationState, record: StartedRecorded): string {
	const { noun, host } = locationTerms(record);
	switch (state) {
		case "running":
			return `running — the ${noun} is open and no result has arrived`;
		case "gone":
			return `closed without a result — the ${noun} is gone and no reply arrived; a late reply would make it done`;
		case "done":
			return `done — result status: ${record.result?.status ?? "unknown"}; the result reaches this session as a [delegate] message on its own`;
		case "closed":
			return "closed — delegation_close recorded it";
		case "window-closed":
			return `closed — the ${noun} is gone`;
		case "unknown":
			return `unknown — ${host} could not be asked whether the ${noun} is open`;
		case "planned":
		case "created":
		case "rolled-back":
		case "retained":
		case "interrupted":
			return `${state} — no window id/start was recorded; a window may still exist`;
	}
}

/** How long ago, worded for the `state:` line: `just now`, `N min ago` or `N h M min ago`. */
export function ago(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	return `${Math.floor(minutes / 60)} h ${minutes % 60} min ago`;
}

/** One delegation as `delegation_status` reports it; its text and details both read from this. */
export type View = {
	usage?: SessionUsage;
	routingEvidence?: RoutingEvidence;
	record: StartedRecorded;
	state: DelegationState;
	name: string;
	sessionPath: string | undefined;
	/** When the session file was last written; set only for a running delegation with a file. */
	lastActive: Date | undefined;
	/** The checkout observed for this status call; the recorded result keeps its own. */
	snapshot: WorkspaceSnapshot;
	/** The delegation that resumed this one, if any. */
	resumedAs: string | undefined;
	/** The session its window is in now, looked up; undefined when the window is gone or unknown. */
	windowSession: string | undefined;
	canResume: boolean;
};

/** How many path entries a Git snapshot's category lines would print. */
function changedPathCount(snapshot: WorkspaceSnapshot): number {
	if (snapshot.kind !== "git") return 0;
	return snapshot.committed.total + Object.values(snapshot.pending).reduce((sum, paths) => sum + paths.total, 0);
}

/** The checkout summary line and, when paths changed, the count that replaces the category lines. */
function checkoutLines(snapshot: WorkspaceSnapshot): string[] {
	const [checkout] = snapshotLines(snapshot);
	const changed = changedPathCount(snapshot);
	return [
		`  checkout now: ${checkout}`,
		...(changed === 0
			? []
			: [`    ${changed} changed path${changed === 1 ? "" : "s"}; details in the structured result`]),
	];
}

/** The text block for one delegation. */
export function viewText({
	record,
	state,
	name,
	sessionPath,
	lastActive,
	snapshot,
	resumedAs,
	windowSession,
	routingEvidence,
	usage,
}: View): string {
	const seen = lastActive === undefined ? "" : ` (last active ${ago(Date.now() - lastActive.getTime())})`;
	const lines = [
		`${record.id} ${record.agent} (${modelLabel(record.model, record.result?.finishedModel)}, thinking ${record.thinking})`,
		`  name: ${name}`,
		...(record.routing
			? [
					`  routing: ${record.routing.profile}/${record.routing.request.category}; policy v${record.routing.policyVersion}; ${record.routing.reason}`,
					`  served this attempt: ${servedSummary(routingEvidence?.served)}; independent family history: ${routingEvidence?.independent ?? "unverified"}`,
				]
			: []),
		`  identity: session ${sessionIdOf(record)} · parent ${record.identity?.parent ?? "this session"} · root ${record.identity?.root ?? "this session"} · depth ${record.identity?.depth ?? 1}`,
		...(accountingFor(record) ? [`  shared accounting: ${accountingFor(record)} (not result processing)`] : []),
		...(record.resumedFrom === undefined ? [] : [`  resumed from ${record.resumedFrom}`]),
		...(record.forkedFrom === undefined ? [] : [`  forked from ${record.forkedFrom}`]),
		...(resumedAs === undefined ? [] : [`  resumed as ${resumedAs}`]),
		`  state: ${stateLine(state, record)}${seen}`,
		...(usage === undefined
			? []
			: [`  usage: ${usageText(usage, (record.resumedFrom ?? record.forkedFrom) !== undefined)}`]),
		`  ${recordedLocation(record, windowSession)}`,
		`  cwd: ${cwdLine(record.cwd)}`,
		...(record.workspace === undefined ? [] : [`  workspace: ${workspaceLine(record.workspace)}`]),
		...checkoutLines(snapshot),
		`  auto-exit: ${autoExitLine(record)}`,
		`  session: ${sessionPath ?? `${sessionIdOf(record)} (no session file yet)`}`,
	];
	if (record.result !== undefined) lines.push(`  envelope: ${record.result.envelopePath}`);
	return lines.join("\n");
}

/** Settled list rows omit launch/control facts; an id still gives the full block. */
export function compactText({ record, state, snapshot, sessionPath, resumedAs }: View): string {
	const checkout =
		snapshot.kind === "git"
			? `${snapshot.position.detached ? "detached HEAD" : `branch ${snapshot.position.branch}`}, head ${snapshot.head.slice(0, 12)}, launch ${snapshot.baseline.slice(0, 12)}, +${snapshot.ahead} commits, ${snapshot.workingState}`
			: snapshotLines(snapshot)[0];
	const changed = changedPathCount(snapshot);
	return [
		`${record.id} ${record.agent} (${modelLabel(record.model, record.result?.finishedModel)}, thinking ${record.thinking})`,
		...(record.resumedFrom === undefined ? [] : [`  resumed from ${record.resumedFrom}`]),
		...(record.forkedFrom === undefined ? [] : [`  forked from ${record.forkedFrom}`]),
		...(resumedAs === undefined ? [] : [`  resumed as ${resumedAs}`]),
		`  state: ${state === "done" ? `done — result status: ${record.result?.status}` : stateLine(state, record)}`,
		`  checkout now: ${checkout}${changed ? `; ${changed} changed path${changed === 1 ? "" : "s"}; details in the structured result` : ""}`,
		`  session: ${sessionPath ?? `${sessionIdOf(record)} (no session file yet)`}`,
		...(record.result ? [`  envelope: ${record.result.envelopePath}`] : []),
	].join("\n");
}

/** One unstarted attempt as the status text words it. */
export function attemptText(record: WorkspaceAttempt): string {
	return [
		`${record.id} ${record.agent} (${modelLabel(record.model, undefined)}, thinking ${record.thinking})`,
		`  name: ${recordedName(record)}`,
		`  state: ${record.attempt.phase} — no window id/start was recorded; a window may still exist (close requires a verified window id)`,
		...attemptLines(record).map((line) => `  ${line}`),
	].join("\n");
}
