// A failed follow-up must roll back through the selected host, never hard-delete a native source.
import type { DelegateHost, OpenedWindow } from "./host.ts";

/** Mail failure after open uses only the host's taskless-resource rollback seam. */
export async function mailTask(
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

export async function closeAfterFailure(client: DelegateHost, opened: OpenedWindow, error: unknown): Promise<never> {
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
