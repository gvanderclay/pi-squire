// Partial opens share the normal tree and managed-attempt journals, never a second resource store.
import type { OpenedWindow, OpenProgress } from "./host.ts";
import { bindTree, type Reservation } from "./tree-registry.ts";
import type { Workspace } from "./workspace.ts";

type ProgressInput = { workspace: Workspace; onProgress?: (progress: OpenProgress) => void };

/** Hosts without incremental progress still publish receipts before configuration or mail. */
export function publishOpenedProgress(input: ProgressInput, token: Reservation, opened: OpenedWindow): void {
	if (opened.paseo)
		publishOpenProgress(input, token, {
			paseo: opened.paseo,
			...(opened.locator ? { locator: opened.locator } : {}),
			...(opened.sessionId ? { sessionId: opened.sessionId } : {}),
		});
}

export function publishOpenProgress(input: ProgressInput, token: Reservation, progress: OpenProgress): void {
	let facts: OpenProgress = progress;
	if (input.workspace.mode === "managed" && progress.paseo) {
		const previous = input.workspace.paseo;
		const paseo =
			previous?.provenance === "created" &&
			previous.home === progress.paseo.home &&
			previous.workspaceId === progress.paseo.workspaceId
				? previous
				: progress.paseo;
		// Resume shares its source record: never mutate or downgrade the original creation proof.
		input.workspace = { ...input.workspace, paseo };
		facts = { ...progress, paseo };
	}
	// Both writes are synchronous and a failure stops the launch. Before dispatch
	// nothing exists, so the caller rolls the worktree back; after dispatch it
	// retains uncertain resources and the facts published here.
	input.onProgress?.(facts);
	bindTree(token, {
		workspace: input.workspace,
		...(facts.locator ? { locator: facts.locator } : {}),
		...(facts.sessionId ? { sessionId: facts.sessionId } : {}),
	});
}
