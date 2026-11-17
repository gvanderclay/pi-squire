// Rex companion ownership. Rex has no session metadata marker, so the proof
// that a companion session is Squire's is a durable creation receipt: the exact
// session.create id, saved before any delegate window is dispatched there. A
// label, a filename, a task title or a familiar first block is never proof.
// Receipts are scoped to one Pi agent directory and one exact server endpoint,
// so two agent directories never share ownership proof, even when their labels
// match. Acquisition is asynchronous but every state transaction is short and
// synchronous: withTreeLock cannot be held across an await.
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { companionLabel, companionNumber } from "./companion-names.ts";
import { WindowOpenError } from "./host.ts";
import { readState, writeState } from "./local-state.ts";
import { processAlive, withTreeLock } from "./tree-lock.ts";

/** Rex's session label schema: at most 128 characters. */
export const MAX_SESSION_LABEL = 128;

export type RexCompanionRoute = { server: string };
/** One Rex CLI call on the pinned endpoint; the same runner the adapter uses. */
export type RexCompanionRun = (route: RexCompanionRoute, args: string[]) => Promise<string>;

/** A proved companion session: the exact id, and the label it currently has. */
export type AcquiredCompanion = { session: string; label: string };

type Receipt = { session: string; createdLabel: string };
type Pending = { token: string; pid: number; label: string };
type State = { version: 1; server: string; base: string; receipts: Receipt[]; pending?: Pending };
type LiveSession = { id: string; label: string };

export type RexCompanions = {
	/**
	 * The proved companion session for this base, creating an empty one when no
	 * receipted candidate is live. Resolves only after the receipt is durable, so
	 * a caller may dispatch a delegate window in the returned id.
	 */
	acquire(route: RexCompanionRoute, base: string): Promise<AcquiredCompanion>;
	/** Read-only receipts for diagnostics; never routing authority. */
	receipts(route: RexCompanionRoute, base: string): Receipt[];
};

export type RexCompanionOptions = {
	run: RexCompanionRun;
	/** Storage root for receipts; defaults to this Pi agent directory. */
	agentDir?: () => string;
	/** Whether a PID is still alive; only ESRCH proves it dead. */
	alive?: (pid: number) => boolean;
	pid?: () => number;
	/** Durable write seam; a test can fail one exact commit. */
	write?: (path: string, state: unknown) => void;
};

const bounded = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 4096;

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid Rex response");
	return value as Record<string, unknown>;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** One private directory per exact endpoint and preferred base; hashing avoids path and length hazards. */
export function companionStatePath(agentDir: string, server: string, base: string): string {
	const key = createHash("sha256").update(`${server}\u0000${base}`).digest("hex");
	return join(agentDir, "squire", "rex-companions", key, "state.json");
}

/** Malformed state blocks acquisition: it is never reset, and a live label is never adopted. */
function broken(path: string, reason: string): WindowOpenError {
	return new WindowOpenError(
		`Rex companion state ${path} is unusable: ${reason}. Repair or remove that file, then retry; no session is adopted by its label and no delegate window was requested.`,
		"not-opened",
	);
}

function storage(path: string, action: "read" | "write", error: unknown): WindowOpenError {
	return new WindowOpenError(
		`could not ${action} Rex companion state ${path}: ${message(error)}. Repair that file or its directory permissions, then retry; no session is adopted by its label and no delegate window was requested.`,
		"not-opened",
	);
}

function validate(value: unknown, server: string, base: string, path: string): State {
	const state = value as Partial<State>;
	if (!state || typeof state !== "object" || Array.isArray(state)) throw broken(path, "it is not a state object");
	if (state.version !== 1) throw broken(path, `its version is not 1`);
	if (state.server !== server || state.base !== base)
		throw broken(path, "its server or base does not match this launch");
	if (!Array.isArray(state.receipts)) throw broken(path, "its receipts are missing");
	const receipts = state.receipts.map((item): Receipt => {
		const receipt = item as Partial<Receipt>;
		if (!bounded(receipt?.session) || typeof receipt.createdLabel !== "string")
			throw broken(path, "a receipt has no usable session id or label");
		return { session: receipt.session, createdLabel: receipt.createdLabel };
	});
	if (new Set(receipts.map((receipt) => receipt.session)).size !== receipts.length)
		throw broken(path, "two receipts name the same session id");
	let pending: Pending | undefined;
	if (state.pending !== undefined) {
		const claim = state.pending as Partial<Pending>;
		if (
			!bounded(claim?.token) ||
			!Number.isSafeInteger(claim.pid) ||
			(claim.pid as number) < 1 ||
			typeof claim.label !== "string"
		)
			throw broken(path, "its pending acquisition claim is malformed");
		pending = { token: claim.token, pid: claim.pid as number, label: claim.label };
	}
	return { version: 1, server, base, receipts, ...(pending === undefined ? {} : { pending }) };
}

function parseSessions(raw: string): LiveSession[] {
	const listed = object(JSON.parse(raw)).sessions;
	const sessions = listed === null ? [] : listed;
	if (!Array.isArray(sessions)) throw new Error("invalid Rex session list");
	const found = sessions.map((item): LiveSession => {
		const session = object(item);
		if (!bounded(session.session_id) || typeof session.label !== "string")
			throw new Error("Rex session list lacks session identity");
		return { id: session.session_id, label: session.label };
	});
	if (new Set(found.map((session) => session.id)).size !== found.length) throw new Error("ambiguous Rex session list");
	return found;
}

/**
 * The proved candidate in numeric order, else the first unoccupied candidate
 * label. A receipted session counts only while it is live under a label of this
 * base's family; a renamed one is left alone for new placement. Duplicate
 * labels never collapse two sessions into one, and an unproved session at a
 * candidate label is skipped rather than adopted.
 */
function choose(
	base: string,
	sessions: readonly LiveSession[],
	receipts: readonly Receipt[],
): AcquiredCompanion | { label: string } {
	const proved = receipts
		.map((receipt) => {
			const live = sessions.find((session) => session.id === receipt.session);
			const number = live === undefined ? undefined : companionNumber(base, live.label);
			return live === undefined || number === undefined ? undefined : { live, number };
		})
		.filter((item): item is { live: LiveSession; number: number } => item !== undefined)
		.sort((a, b) => a.number - b.number);
	const first = proved[0];
	if (first) return { session: first.live.id, label: first.live.label };
	const occupied = new Set(sessions.map((session) => session.label));
	let number = 1;
	while (occupied.has(companionLabel(base, number))) number++;
	const label = companionLabel(base, number);
	if (label.length > MAX_SESSION_LABEL)
		throw new WindowOpenError(
			`Rex session label ${JSON.stringify(label)} is longer than Rex's ${MAX_SESSION_LABEL}-character limit; no session was created and no delegate window was requested. Use a shorter companionSuffix or a shorter project directory name.`,
			"not-opened",
		);
	return { label };
}

class CompanionStore implements RexCompanions {
	private readonly options: RexCompanionOptions;
	constructor(options: RexCompanionOptions) {
		this.options = options;
	}
	private get root(): string {
		return (this.options.agentDir ?? getAgentDir)();
	}
	private get pid(): number {
		return (this.options.pid ?? ((): number => process.pid))();
	}
	private alive(pid: number): boolean {
		return (this.options.alive ?? processAlive)(pid);
	}
	private read(path: string, server: string, base: string): State {
		let value: unknown;
		try {
			value = readState<unknown>(path);
		} catch (error) {
			throw storage(path, "read", error);
		}
		return value === undefined ? { version: 1, server, base, receipts: [] } : validate(value, server, base, path);
	}
	private write(path: string, state: State): void {
		try {
			(this.options.write ?? writeState)(path, state);
		} catch (error) {
			throw storage(path, "write", error);
		}
	}
	/** One short synchronous transaction; no await may happen inside it. */
	private transaction<T>(lock: string, work: () => T): T {
		try {
			return withTreeLock(lock, work);
		} catch (error) {
			if (error instanceof WindowOpenError) throw error;
			throw new WindowOpenError(
				`Rex companion session bookkeeping failed: ${message(error)}. Retry the launch; no delegate window was requested.`,
				"not-opened",
			);
		}
	}
	/** Drop this acquisition's claim; a successor's claim is never overwritten. */
	private clear(path: string, server: string, base: string, token: string, lock: string): void {
		this.transaction(lock, () => {
			const state = this.read(path, server, base);
			if (state.pending?.token !== token) return;
			this.write(path, { ...state, pending: undefined });
		});
	}
	private async list(route: RexCompanionRoute): Promise<LiveSession[]> {
		try {
			return parseSessions(await this.options.run(route, ["api", "call", "session.list"]));
		} catch (error) {
			throw new WindowOpenError(
				`could not list Rex sessions: ${message(error)}; no delegate window was requested`,
				"not-opened",
			);
		}
	}
	/** Create an EMPTY session: no initial windows, so no unused shell tab exists. */
	private async create(route: RexCompanionRoute, label: string): Promise<string> {
		const residue =
			"No delegate window was requested; an empty session may remain, and it will not be adopted by its label or deleted.";
		let raw: string;
		try {
			raw = await this.options.run(route, ["api", "call", "session.create", JSON.stringify({ label })]);
		} catch (error) {
			throw new WindowOpenError(
				`could not create the empty Rex companion session ${JSON.stringify(label)}: ${message(error)}. ${residue}`,
				"not-opened",
			);
		}
		let id: unknown;
		try {
			id = object(JSON.parse(raw)).session_id;
		} catch {
			id = undefined;
		}
		if (!bounded(id))
			throw new WindowOpenError(
				`Rex created a session for ${JSON.stringify(label)} but reported no usable session id. ${residue}`,
				"not-opened",
			);
		return id;
	}
	/** Prove the exact created id exists with the intended label before any window dispatch. */
	private async prove(route: RexCompanionRoute, session: string, label: string): Promise<void> {
		const found = (await this.list(route)).find((item) => item.id === session);
		if (found === undefined || found.label !== label)
			throw new WindowOpenError(
				`Rex did not report the new companion session ${session} with label ${JSON.stringify(label)}. No delegate window was requested; an empty session may remain, and it will not be adopted by its label or deleted.`,
				"not-opened",
			);
	}
	receipts(route: RexCompanionRoute, base: string): Receipt[] {
		const path = companionStatePath(this.root, route.server, base);
		return [...this.read(path, route.server, base).receipts];
	}
	async acquire(route: RexCompanionRoute, base: string): Promise<AcquiredCompanion> {
		if (!bounded(base))
			throw new WindowOpenError("invalid Rex companion base name; no delegate window was requested", "not-opened");
		const path = companionStatePath(this.root, route.server, base);
		const lock = join(dirname(path), "lock");
		const token = randomUUID();
		const pid = this.pid;
		// 1. Reserve this base under a short synchronous transaction. A live claim
		// refuses; only a dead owner's claim is replaced, and it can have created
		// at most an empty unowned session because dispatch needs the receipt.
		const receipts = this.transaction(lock, () => {
			const state = this.read(path, route.server, base);
			if (state.pending !== undefined && this.alive(state.pending.pid))
				throw new WindowOpenError(
					`Rex companion session for ${JSON.stringify(base)} is already being created by another Pi (pid ${state.pending.pid}); companion acquisition busy; retry the launch. No delegate window was requested.`,
					"not-opened",
				);
			this.write(path, { ...state, pending: { token, pid, label: "" } });
			return state.receipts;
		});
		let committed = false;
		try {
			// 2. The lock is released before any Rex call.
			const sessions = await this.list(route);
			const chosen = choose(base, sessions, receipts);
			if ("session" in chosen) {
				// 3. A proved candidate is reused; no session is created or adopted.
				this.clear(path, route.server, base, token, lock);
				committed = true;
				return chosen;
			}
			this.transaction(lock, () => {
				const state = this.read(path, route.server, base);
				if (state.pending?.token !== token)
					throw new WindowOpenError(
						`another Pi took over the Rex companion acquisition for ${JSON.stringify(base)}; no delegate window was requested`,
						"not-opened",
					);
				this.write(path, { ...state, pending: { token, pid, label: chosen.label } });
			});
			const session = await this.create(route, chosen.label);
			await this.prove(route, session, chosen.label);
			// 4. Commit the exact-id receipt before any delegate window is dispatched.
			this.transaction(lock, () => {
				const state = this.read(path, route.server, base);
				if (state.pending?.token !== token)
					throw new WindowOpenError(
						`another Pi took over the Rex companion acquisition for ${JSON.stringify(base)} after session ${session} was created; no delegate window was requested and that empty session may remain`,
						"not-opened",
					);
				this.write(path, {
					...state,
					receipts: [...state.receipts, { session, createdLabel: chosen.label }],
					pending: undefined,
				});
			});
			committed = true;
			return { session, label: chosen.label };
		} finally {
			if (!committed) {
				try {
					this.clear(path, route.server, base, token, lock);
				} catch {
					// The acquisition's own failure is the report; a leftover claim is
					// replaced only once its owner is provably gone.
				}
			}
		}
	}
}

export function createRexCompanions(options: RexCompanionOptions): RexCompanions {
	return new CompanionStore(options);
}
