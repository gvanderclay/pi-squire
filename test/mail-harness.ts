// Reusable multi-instance protocol harness: independent squire/mail runtimes,
// shared isolated XDG mail root, fake Pi lifecycle and fake tmux only.
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Envelope } from "../src/results.ts";
import { root, type SessionOptions, session } from "./harness.ts";

// The package has no exports entry; Pi also loads this manifest-declared file.
// Node strips TS outside node_modules only. Copy the installed minimum-release
// source unchanged, with dependencies resolving to this worktree's installation.
const packageRoot: string = fileURLToPath(new URL("../node_modules/pi-session-mail/", import.meta.url));
const copy: string = join(root, "provider");
cpSync(packageRoot, copy, { recursive: true });
symlinkSync(fileURLToPath(new URL("../node_modules/", import.meta.url)), join(root, "node_modules"), "dir");
const provider: (pi: ExtensionAPI) => void = (await import(pathToFileURL(join(copy, "src", "index.ts")).href)).default;
process.env.XDG_STATE_HOME = join(root, "mail-state");
delete process.env.PI_UNATTENDED;

export function mailSession(options: SessionOptions = {}): ReturnType<typeof session> {
	delete process.env.PI_DELEGATE_PARENT;
	delete process.env.PI_DELEGATE_AUTO_EXIT;
	delete process.env.PI_DELEGATE_FALLBACK;
	delete process.env.PI_DELEGATE_AGENT;
	return session({ parent: randomUUID(), ...options, mailProvider: provider });
}

export function scan(instance: ReturnType<typeof session>): void {
	instance.events.emit("message:scan", {});
}

export function envelopes(address: string, box: "new" | "cur" | "sent"): Envelope[] {
	const path: string = join(root, "mail-state", "pi-session-mail", address, box);
	return existsSync(path)
		? readdirSync(path).map((name) => JSON.parse(readFileSync(join(path, name), "utf8")) as Envelope)
		: [];
}

export function request(from: ReturnType<typeof session>, to: string, body = "do the task"): Envelope {
	const payload: { to: string; body: string; envelope?: Envelope; error?: string } = { to, body };
	from.events.emit("message:send", payload);
	if (!payload.envelope) throw new Error(payload.error ?? "missing real provider");
	return payload.envelope;
}

export const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
