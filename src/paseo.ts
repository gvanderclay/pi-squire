// The Paseo delegate host: a coordinator Paseo started delegates as Paseo
// agents; a coordinator in another multiplexer never loads the SDK or asks the
// daemon anything.
import { readFileSync } from "node:fs";
import {
	type DelegateHost,
	type OpenedWindow,
	type ShowResult,
	WindowOpenError,
	type WindowSpec,
	type WindowTarget,
} from "./host.ts";
import { recordLocator } from "./locators.ts";
import { createPaseoApi, type PaseoApi } from "./paseo-api.ts";
import { paseoLaunch } from "./paseo-launch.ts";
import { type PaseoLocator, paseoLocator } from "./paseo-locator.ts";
import {
	type ClosableStates,
	type WindowLook,
	type WindowRecord,
	type WindowState,
	windowStates,
} from "./window-state.ts";

/** The session that started this Pi; Paseo exports the agent id it chose. */
type Environment = Record<string, string | undefined>;

const NOT_HOSTED = "this session is not hosted by Paseo";
const LIST_REFUSAL = "could not ask Paseo for its agents";
const INVALID_LOCATOR = "invalid or unsupported delegate window locator";

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The durable record for one started agent; the agent's title is presentation only. */
const locatorOf = (agent: string, name: string): PaseoLocator => ({
	adapter: "paseo",
	version: 1,
	kind: "window",
	agent,
	name,
});

/** The system prompt `--append-system-prompt` names; a read failure dispatched nothing. */
function promptOf(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		throw new WindowOpenError(
			`could not read the delegate's system prompt ${path} (${messageOf(error)})`,
			"not-opened",
		);
	}
}

class PaseoHost implements DelegateHost {
	readonly id = "paseo";
	readonly windowNoun = "agent";
	readonly usesWindowPlacement = false;
	readonly requiresSessionGuard = false;
	readonly keepsDelegatesOpen = true;
	readonly windowListRefusal = LIST_REFUSAL;
	private readonly api: PaseoApi;
	/** Read at every call: same process, and the router asks before any launch. */
	private readonly env: Environment;

	constructor(api: PaseoApi, env: Environment) {
		this.api = api;
		this.env = env;
	}

	/** Paseo chooses the session id after the agent starts, so no task is mailed before open. */
	taskMailTiming(): "after-open" {
		return "after-open";
	}

	ownsLocator(value: unknown, target?: WindowTarget): boolean {
		const own = paseoLocator(value);
		return own !== undefined && (target === undefined || target.windowId === own.agent);
	}

	unavailable(): string | undefined;
	unavailable(checkVersion: true): Promise<string | undefined>;
	unavailable(checkVersion?: true): string | undefined | Promise<string | undefined> {
		if (!this.hosted()) return checkVersion ? Promise.resolve(NOT_HOSTED) : NOT_HOSTED;
		return checkVersion ? this.api.unavailable() : undefined;
	}

	async openWindow(spec: WindowSpec): Promise<OpenedWindow> {
		const launch = paseoLaunch(spec);
		const systemPrompt = promptOf(launch.promptFile);
		let created: { sessionId: string };
		try {
			created = await this.api.create({
				agentId: launch.agentId,
				title: launch.title,
				cwd: spec.cwd,
				model: launch.model,
				thinking: launch.thinking,
				systemPrompt,
				env: launch.env,
			});
		} catch (error) {
			throw new WindowOpenError(`could not start Paseo agent ${launch.agentId}: ${messageOf(error)}`, "unknown");
		}
		return {
			id: launch.agentId,
			session: undefined,
			sessionId: created.sessionId,
			locator: locatorOf(launch.agentId, spec.name),
		};
	}

	async states(strict = false): Promise<ClosableStates> {
		if (!this.hosted()) {
			if (strict) throw new Error(NOT_HOSTED);
			return this.refused(NOT_HOSTED);
		}
		const live = await this.live(strict);
		if (live === undefined) return this.refused(`${LIST_REFUSAL}; none closed`);
		return this.closable(live);
	}

	async closeTaskless(opened: OpenedWindow): Promise<void> {
		try {
			await this.api.remove(opened.id);
		} catch (error) {
			throw new Error(
				`the delegate's Paseo agent ${opened.id} could not be closed and may still run Pi with no task (${messageOf(error)}); close it yourself`,
			);
		}
	}

	async show(target: WindowTarget): Promise<ShowResult> {
		return {
			text: `a Paseo delegate has no terminal; open agent ${target.windowId} in the Paseo app`,
			brief: "open it in Paseo",
		};
	}

	async peek(target: WindowTarget): Promise<string> {
		const own = paseoLocator(target.locator);
		if (own === undefined) throw new Error(INVALID_LOCATOR);
		return await this.api.activity(own.agent);
	}

	private hosted(): boolean {
		return (this.env.PASEO_AGENT_ID ?? "") !== "";
	}

	/** One agent listing for every record; undefined when the daemon could not be asked. */
	private async live(strict: boolean): Promise<Set<string> | undefined> {
		try {
			return await this.api.live();
		} catch (error) {
			if (strict) throw new Error(`${LIST_REFUSAL}: ${messageOf(error)}`);
			return undefined;
		}
	}

	/** Every record unknown: nothing was asked. */
	private refused(reason: string): ClosableStates {
		return { ...windowStates(undefined), close: (): Promise<boolean> => Promise.reject(new Error(reason)) };
	}

	private closable(live: Set<string>): ClosableStates {
		const owner = (record: WindowRecord): PaseoLocator | undefined => paseoLocator(recordLocator(record));
		const look = (record: WindowRecord): WindowLook => {
			const own = owner(record);
			if (own === undefined) return { state: "unknown" };
			return { state: live.has(own.agent) ? "running" : "gone" };
		};
		return {
			answered: true,
			look,
			state: (record: WindowRecord): WindowState => look(record).state,
			listed: (record: WindowRecord): boolean => {
				const own = owner(record);
				return own !== undefined && live.has(own.agent);
			},
			close: async (record: WindowRecord): Promise<boolean> => {
				const own = owner(record);
				if (own === undefined) throw new Error(`${INVALID_LOCATOR}; close refused`);
				if (!live.has(own.agent)) return false;
				return await this.api.remove(own.agent);
			},
		};
	}
}

export function createPaseoHost(api: PaseoApi = createPaseoApi(), env: Environment = process.env): DelegateHost {
	return new PaseoHost(api, env);
}
