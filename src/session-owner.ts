// One Squire actor per exact Pi session. Already-claimed Squire mail is staged
// before dispatch so a duplicate provider cannot steal it from the live owner.
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { readChildRecords } from "./child-tasks.ts";
import { readIdentity } from "./identity.ts";
import { readState, writeState } from "./local-state.ts";
import { type Inbound, isStarted, sessionIdOf } from "./results.ts";
import { processAlive, withTreeLock } from "./tree-lock.ts";
import { readTree } from "./tree-registry.ts";

type OwnerRecord = { pid: number; token: string };
type Callback = (...args: unknown[]) => unknown;
const base = (session: string): string => join(getAgentDir(), "squire", "owners", encodeURIComponent(session));
const lock = <T>(session: string, work: () => T): T => withTreeLock(`${base(session)}.lock`, work);
function ownerRecord(session: string): OwnerRecord | undefined {
	const saved: OwnerRecord | undefined = readState<OwnerRecord>(`${base(session)}.json`);
	if (saved && (!Number.isSafeInteger(saved.pid) || saved.pid < 1 || typeof saved.token !== "string"))
		throw new Error(`invalid Squire process owner ${base(session)}.json; repair that owner record before reopening`);
	return saved;
}
export function ownerDetails(session: string): string {
	const path: string = `${base(session)}.json`;
	try {
		const saved: OwnerRecord | undefined = ownerRecord(session);
		return `${path} (PID ${saved?.pid ?? "not recorded"})`;
	} catch (error) {
		return `${path} (unreadable: ${String(error)})`;
	}
}
/** Observation only: matches the elected incarnation, never grants action authority. */
export function matchesSessionOwner(session: string, pid: number, token: string): boolean {
	const saved: OwnerRecord | undefined = ownerRecord(session);
	return saved?.pid === pid && saved.token === token;
}
export function sessionIsOwned(session: string): boolean {
	const saved: OwnerRecord | undefined = ownerRecord(session);
	return saved !== undefined && processAlive(saved.pid);
}
function recognizes(session: string, input: Inbound): boolean {
	const envelope = input.envelope as Inbound["envelope"] & { kind?: string };
	if (envelope.kind === "request") return readIdentity(session)?.parent === envelope.from;
	if (!Array.isArray(envelope.in_reply_to) || !envelope.in_reply_to.length) return false;
	const matches = (record: import("./results.ts").Recorded): boolean =>
		isStarted(record) && sessionIdOf(record) === envelope.from && envelope.in_reply_to.includes(record.requestId);
	return readChildRecords(session).some(matches) || registryStarts(session).some(matches);
}
function registryStarts(session: string): import("./results.ts").Delegation[] {
	try {
		return readTree(readIdentity(session)?.root ?? session, 0)
			.entries.filter((entry) => entry.identity.parent === session && entry.launch !== undefined)
			.flatMap((entry) => (entry.launch ? [entry.launch] : []));
	} catch {
		return [];
	}
}
export class SessionOwner {
	readonly token: string = randomUUID();
	session: string | undefined;
	owned = false;
	ctx: ExtensionContext | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly inbound: Callback[] = [];
	private draining = false;
	private ready = false;
	private failed = false;
	private readonly warned: Set<string> = new Set();

	private warn(message: string): void {
		if (this.warned.has(message)) return;
		this.warned.add(message);
		if (this.ctx) this.ctx.ui.notify(message, "error");
		else console.error(message);
	}

	active(): boolean {
		if (!this.owned || this.failed || !this.session) return false;
		try {
			return ownerRecord(this.session)?.token === this.token;
		} catch (error) {
			this.warn(
				`delegate: could not read Squire owner ${ownerDetails(this.session)}: ${String(error)}; processing is blocked until storage is repaired and this session reopened.`,
			);
			return false;
		}
	}
	assert(): void {
		if (this.failed)
			throw new Error(
				"Squire input processing failed; staged input is retained. Repair storage and reopen this session.",
			);
		if (!this.owned || !this.session || ownerRecord(this.session)?.token !== this.token)
			throw new Error(
				`Squire is inactive: this session is already open in another process, or has shut down. ${this.session ? ownerDetails(this.session) : "No owner session"}. Reopen the owning session only once.`,
			);
	}
	start(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.session = ctx.sessionManager.getSessionId();
		this.ready = false;
		this.failed = false;
		this.warned.clear();
		this.owned = false;
		this.owned = lock(this.session, () => {
			const saved: OwnerRecord | undefined = ownerRecord(this.session as string);
			if (saved && saved.token !== this.token && processAlive(saved.pid)) return false;
			writeState(`${base(this.session as string)}.json`, { pid: process.pid, token: this.token });
			return true;
		});
		if (!this.owned) {
			ctx.ui.notify(
				`delegate: this Pi session is already open in another process: ${ownerDetails(this.session)}. Squire actions are disabled here; return to the existing owner. Inspect the PID/record if stale; never evict a live owner.`,
				"error",
			);
			ctx.shutdown();
		}
	}
	listen(callback: Callback): () => void {
		this.inbound.push(callback);
		return (): void => {
			const i: number = this.inbound.indexOf(callback);
			if (i >= 0) this.inbound.splice(i, 1);
		};
	}
	receive(payload: Inbound): void {
		if (payload?.handled || !payload?.envelope) return;
		const session: string | undefined = payload.envelope.to || this.session;
		if (!session) return;
		if (!recognizes(session, payload)) {
			if (this.active() && this.ready) for (const callback of this.inbound) callback(payload);
			return;
		}
		try {
			const dir: string = join(base(session), "inbound");
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			writeState(join(dir, arrivalName(payload)), { ...payload, handled: false });
		} catch (error) {
			this.unstaged(payload, error);
			return;
		}
		payload.handled = true;
		this.drain();
	}
	drain(): void {
		if (!this.active() || !this.ready || !this.session || this.draining) return;
		this.draining = true;
		try {
			this.deliver();
		} catch (error) {
			this.failed = true;
			this.ctx?.ui.notify(
				`delegate: staged task input retained: ${String(error)}; repair storage and reopen this session.`,
				"error",
			);
		} finally {
			this.draining = false;
		}
	}
	private unstaged(payload: Inbound, error: unknown): void {
		this.warn(`delegate: could not stage claimed Squire input ${payload.path}: ${String(error)}.`);
		try {
			if (this.active() && this.ready) for (const callback of this.inbound) callback(payload);
			if (payload.handled) return;
		} catch (failure) {
			this.failed = true;
			this.warn(`delegate: direct Squire input processing failed: ${String(failure)}.`);
		}
		payload.handled = true;
		this.warn(
			`delegate: claimed Squire input ${payload.envelope.id} at ${payload.path} could not be retained or delivered to its owner. Delivery is NOT lossless with unwritable staging here: repair storage and ask the sender to resend; no plain-mail fallback was used.`,
		);
	}
	private deliver(): void {
		if (!this.session || ownerRecord(this.session)?.token !== this.token) throw new Error("Squire ownership changed");
		const dir: string = join(base(this.session), "inbound");
		let names: string[];
		try {
			names = readdirSync(dir)
				.filter((name) => name.endsWith(".json"))
				.sort();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for (const name of names) {
			const path: string = join(dir, name);
			const payload: Inbound | undefined = readState<Inbound>(path);
			if (!payload) continue;
			this.assert();
			for (const callback of this.inbound) callback(payload);
			if (!payload.handled) throw new Error("staged Squire input did not match restored task state");
			this.assert();
			unlinkSync(path);
		}
	}
	arm(): void {
		if (!this.owned) return;
		this.ready = true;
		this.drain();
		if (this.timer) clearInterval(this.timer);
		this.timer = setInterval(() => this.drain(), 250).unref();
	}
	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.ready = false;
		try {
			if (this.session && this.owned)
				lock(this.session, () => {
					if (ownerRecord(this.session as string)?.token === this.token)
						unlinkSync(`${base(this.session as string)}.json`);
				});
		} finally {
			this.owned = false;
			this.ctx = undefined;
		}
	}
}

function arrivalName(payload: Inbound): string {
	const parsed: number = Date.parse(payload.envelope.ts);
	const time: string = String(Number.isFinite(parsed) ? parsed : 0).padStart(16, "0");
	return `${time}-${encodeURIComponent(basename(payload.path || ""))}-${encodeURIComponent(payload.envelope.id)}.json`;
}

/** Wrap only Squire registrations; mail and other extensions keep their own API. */
export function ownedAPI(pi: ExtensionAPI, owner: SessionOwner): ExtensionAPI {
	const events: ExtensionAPI["events"] = {
		...pi.events,
		on: (name: string, handler: Parameters<ExtensionAPI["events"]["on"]>[1]) =>
			name === "message:inbound" ? owner.listen(handler as Callback) : pi.events.on(name, handler),
		emit: (name: string, payload: unknown) => {
			if (name === "message:scan" && !owner.active()) return;
			owner.assert();
			pi.events.emit(name, payload);
		},
	};
	return new Proxy(pi, {
		get(target: ExtensionAPI, key: string | symbol, receiver: unknown): unknown {
			if (key === "events") return events;
			const value: unknown = Reflect.get(target, key, receiver);
			if (typeof value !== "function") return value;
			return (...args: unknown[]): unknown => dispatchAPI(target, key, value as Callback, args, owner);
		},
	});
}
function dispatchAPI(
	target: ExtensionAPI,
	key: string | symbol,
	call: Callback,
	args: unknown[],
	owner: SessionOwner,
): unknown {
	if (key === "on") {
		const [name, handler] = args as [string, Callback];
		return Reflect.apply(call, target, [
			name,
			(...params: unknown[]) => (name === "session_shutdown" || owner.active() ? handler(...params) : undefined),
		]);
	}
	if (key === "registerTool" || key === "registerCommand" || key === "registerShortcut") {
		const index: number = key === "registerTool" ? 0 : 1;
		const definition: Record<string, unknown> = args[index] as Record<string, unknown>;
		const method: string = key === "registerTool" ? "execute" : "handler";
		const callback: Callback = definition[method] as Callback;
		args[index] = {
			...definition,
			[method]: (...params: unknown[]): unknown => {
				owner.assert();
				return callback(...params);
			},
		};
	}
	if (["appendEntry", "sendMessage", "sendUserMessage", "setModel", "setActiveTools"].includes(String(key)))
		owner.assert();
	return Reflect.apply(call, target, args);
}
