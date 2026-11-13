// A deterministic Paseo delegate host fixture: the production parser and host
// over an in-memory fake API. No daemon, SDK, CLI or terminal is involved, so
// the same file runs in CI without Paseo installed.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DelegateHost, OpenedWindow, WindowSpec } from "../src/host.ts";
import { windowPresentation } from "../src/locators.ts";
import { createPaseoHost } from "../src/paseo.ts";
import type { PaseoApi } from "../src/paseo-api.ts";
import { paseoLocator } from "../src/paseo-locator.ts";
import type { WindowRecord } from "../src/tmux.ts";
import type { AdapterContract, AdapterFixture } from "./adapter-contract.ts";

/** What one create asks the daemon for; the fake keeps it as the started delegate. */
export type PaseoCreate = Parameters<PaseoApi["create"]>[0];

/** The daemon as a set of agent ids: create adds one, remove deletes one, live lists them. */
export class FakePaseo implements PaseoApi {
	readonly running = new Set<string>();
	/** Rows the daemon no longer lists but still holds: live leaves them out, remove deletes them. */
	readonly archived = new Set<string>();
	readonly created: PaseoCreate[] = [];
	/** Every method this fake was asked for, in order. */
	readonly calls: string[] = [];
	/** Every agent id the host asked to delete, in order. */
	readonly removals: string[] = [];
	failCreate: string | undefined;
	failLive = false;
	failRemove = false;
	/** When true the create answer is lost after the agent exists. */
	ambiguous = false;
	ambiguousAgent: string | undefined;
	/** When true, any call is a test failure: the caller must not reach Paseo at all. */
	failAll = false;

	private use(name: string): void {
		this.calls.push(name);
		if (this.failAll) throw new Error(`unexpected Paseo API call: ${name}`);
	}

	async unavailable(): Promise<string | undefined> {
		this.use("unavailable");
		return undefined;
	}

	async create(input: PaseoCreate): Promise<{ sessionId: string }> {
		this.use("create");
		if (this.failCreate !== undefined) throw new Error(this.failCreate);
		this.running.add(input.agentId);
		this.created.push({ ...input, env: { ...input.env } });
		if (this.ambiguous) {
			this.ambiguous = false;
			this.ambiguousAgent = input.agentId;
			throw new Error("the create answer was lost");
		}
		return { sessionId: `paseo-session-${input.agentId}` };
	}

	async live(): Promise<Set<string>> {
		this.use("live");
		if (this.failLive) throw new Error("Paseo did not answer");
		return new Set(this.running);
	}

	async activity(agentId: string): Promise<string> {
		this.use("activity");
		if (!this.running.has(agentId)) throw new Error(`no Paseo agent ${agentId}`);
		return `recent activity of ${agentId}\nSQUIRE-ADAPTER-SCREEN\n`;
	}

	async archive(agentId: string, _sessionId: string, eligible: () => boolean): Promise<boolean> {
		this.use("archive");
		if (!eligible()) return false;
		if (!this.running.delete(agentId)) throw new Error(`no Paseo agent ${agentId}`);
		this.archived.add(agentId);
		return true;
	}

	async remove(agentId: string): Promise<boolean> {
		this.use("remove");
		this.removals.push(agentId);
		if (this.failRemove) throw new Error("paseo delete refused");
		return this.running.delete(agentId) || this.archived.delete(agentId);
	}
}

/** The argv `launchPayload` builds for one delegate, with a real prompt file. */
function launchArgv(fields: { name: string; dir: string; prompt: string }): string[] {
	return [
		process.execPath,
		"worker",
		"--session-id",
		randomUUID(),
		"--name",
		fields.name,
		"--approve",
		"--session-dir",
		fields.dir,
		"--model",
		"provider/model",
		"--thinking",
		"low",
		"--tools",
		"read",
		"--append-system-prompt",
		fields.prompt,
	];
}

export async function paseoAdapter(): Promise<AdapterFixture> {
	mkdirSync(".scratch/tmp", { recursive: true });
	const dir = mkdtempSync(join(process.cwd(), ".scratch/tmp/paseo-fixture-"));
	const prompt = join(dir, "prompt.md");
	writeFileSync(prompt, "the delegate's instructions");
	const api = new FakePaseo();
	const agent = randomUUID();
	const env: Record<string, string | undefined> = { PASEO_AGENT_ID: agent };
	const host: DelegateHost = createPaseoHost(api, env);
	const target = (record: WindowRecord) => ({ windowId: windowPresentation(record).windowId, locator: record.locator });
	const spec = (name: string): WindowSpec => ({
		name,
		cwd: process.cwd(),
		argv: launchArgv({ name, dir, prompt }),
		env: {},
	});
	const adapter: AdapterContract = {
		async open(name) {
			const opened = await host.openWindow(spec(name), "current", "");
			return { locator: opened.locator };
		},
		state: async (record) => (await host.states()).state(record),
		close: async (record) => (await host.states(true)).close(record),
		show: (record, verify) => host.show(target(record), verify),
		peek: (record) => host.peek(target(record)),
		unavailable: (checkVersion) => (checkVersion ? host.unavailable(true) : host.unavailable()),
	};
	return {
		adapter,
		host,
		viewer: false as const,
		spec,
		openHost: (window: WindowSpec): Promise<OpenedWindow> => host.openWindow(window, "current", "delegates"),
		async started() {
			// A Paseo agent is created from fields; the two argv cases are the declared gaps.
			throw new Error("a Paseo agent has no argv to compare");
		},
		async exit(record) {
			const own = paseoLocator(record.locator);
			if (own) api.running.delete(own.agent);
		},
		async replace(record) {
			const own = paseoLocator(record.locator);
			if (!own) throw new Error("invalid Paseo record");
			api.running.delete(own.agent);
			const next = randomUUID();
			api.running.add(next);
			return { locator: { ...own, agent: next } };
		},
		failAsk(fail) {
			api.failLive = fail;
		},
		ambiguousOpen() {
			api.ambiguous = true;
		},
		async ambiguousSurvives() {
			return api.ambiguousAgent !== undefined && api.running.has(api.ambiguousAgent);
		},
		setUnavailable(unavailable) {
			if (unavailable) delete env.PASEO_AGENT_ID;
			else env.PASEO_AGENT_ID = agent;
		},
		async isShown() {
			return false;
		},
		async dispose() {
			rmSync(dir, { recursive: true, force: true });
		},
		failClose(fail) {
			api.failRemove = fail;
		},
	};
}
