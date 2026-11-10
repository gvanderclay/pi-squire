import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Agent } from "./agents.ts";
import { closest } from "./delegate-request.ts";
import { activeMark, isFree, type Mark } from "./limits.ts";
import type { Proactive } from "./usage.ts";

/** A candidate model passed over: `why` finishes "<model> is …", `reason` is the long form for a refusal. */
export type Skipped = { model: string; why: string; reason: string };

/** All known model ids, including models without configured credentials. */
export const modelIds = (source: ModelRegistry | undefined): string[] =>
	(source?.getAll() ?? []).map((model) => `${model.provider}/${model.id}`);

/** Why `value` is not a usable model, or undefined when it is. */
export function modelProblem(value: string, registry: ModelRegistry): string | undefined {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return `--model takes provider/id, got ${JSON.stringify(value)}`;
	const known = registry.find(value.slice(0, slash), value.slice(slash + 1));
	if (known !== undefined) {
		if (registry.hasConfiguredAuth(known)) return undefined;
		return `no credentials for model ${JSON.stringify(value)}; log in to the provider ${JSON.stringify(known.provider)} (/login), then try again`;
	}
	const names = registry.getAll().map((model) => `${model.provider}/${model.id}`);
	const close = closest(value, names);
	return `unknown model ${JSON.stringify(value)}${close.length > 0 ? `; close matches: ${close.join(", ")}` : ""}`;
}

/** The registry's model for an exact `provider/id`; undefined for anything else, such as a pattern. */
function registered(value: string, registry: ModelRegistry): { provider: string; id: string } | undefined {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return undefined;
	return registry.find(value.slice(0, slash), value.slice(slash + 1));
}

/** An agent's own models in order: its `model`, or the parent's when it has none, then its fallbacks. */
export function agentModels(agent: Agent, parentModel: string | undefined): string[] {
	const first = agent.model ?? parentModel;
	return [...(first === undefined ? [] : [first]), ...agent.fallback];
}

/**
 * The model for a launch. An explicit model is the only candidate; otherwise
 * `preferred`, by default `own`: the agent's model then its fallbacks. The
 * first candidate that passes `modelProblem` and has no active mark wins; the
 * rest are returned as skipped. A paid candidate on a provider with a quota
 * check is read first, and skipped when its quota is used up. A candidate from
 * the agent file that is not an exact `provider/id` the registry knows, such
 * as a pattern, is passed to the child unchanged for Pi to resolve. Refuses,
 * listing every candidate, when none is left. A resume passes its own
 * `preferred`.
 */
export async function chooseModel(
	explicit: string | undefined,
	agent: Agent,
	models: ModelRegistry,
	proactive: Proactive,
	own: readonly string[],
	preferred: readonly string[] = own,
): Promise<{ model: string; skipped: Skipped[]; notices: string[]; rest: string[] }> {
	const candidates = explicit !== undefined ? [explicit] : [...preferred];
	if (candidates.length === 0)
		throw new Error(
			`agent ${agent.name} names no model and this session has none; add model to ${agent.path}, or pass one`,
		);
	const skipped: Skipped[] = [];
	const notices: string[] = [];
	for (const model of candidates) {
		const rest = (): string[] => candidates.slice(candidates.indexOf(model) + 1);
		if (explicit === undefined && registered(model, models) === undefined)
			return { model, skipped, notices, rest: rest() };
		const problem = await candidateProblem(model, models, proactive, notices);
		if (problem === undefined) return { model, skipped, notices, rest: rest() };
		skipped.push(problem);
	}
	refuseModels(explicit, agent, models, own, skipped);
}

/** Recheck an active mark before a paid model's proactive quota check. */
async function candidateMark(
	model: string,
	models: ModelRegistry,
	proactive: Proactive,
	notices: string[],
): Promise<Mark | undefined> {
	const slash = model.indexOf("/");
	const provider = model.slice(0, slash);
	const id = model.slice(slash + 1);
	let mark = activeMark(models, provider, id);
	if (mark !== undefined) {
		const cleared = await proactive.recheck(models, provider, id);
		for (const line of cleared) if (!notices.includes(line)) notices.push(line);
		if (cleared.length > 0) mark = activeMark(models, provider, id);
	}
	if (mark === undefined && !isFree(models, provider, id)) {
		const checked = await proactive.check(models, provider, id);
		if (checked.notice !== undefined && !notices.includes(checked.notice)) notices.push(checked.notice);
		mark = activeMark(models, provider, id) ?? checked.mark;
	}
	return mark;
}

async function candidateProblem(
	model: string,
	models: ModelRegistry,
	proactive: Proactive,
	notices: string[],
): Promise<Skipped | undefined> {
	const problem = modelProblem(model, models);
	if (problem !== undefined) return { model, why: `unavailable (${problem})`, reason: problem };
	const mark = await candidateMark(model, models, proactive, notices);
	if (mark === undefined) return undefined;
	const what = mark.scope.includes("/") ? `model ${mark.scope}` : `provider ${mark.scope}`;
	const until = new Date(mark.clearsAt).toISOString();
	return {
		model,
		why: `usage-limited until ${until}`,
		reason: `usage-limited (${what}) until ${until}: ${mark.reason}`,
	};
}

/** No substitution for an explicit model; the refusal may suggest an open agent model. */
function refuseModels(
	explicit: string | undefined,
	agent: Agent,
	models: ModelRegistry,
	own: readonly string[],
	skipped: readonly Skipped[],
): never {
	if (skipped.length === 1) {
		const [only] = skipped;
		if (!only.why.startsWith("usage-limited")) throw new Error(only.reason);
		// An explicit model is never substituted, but the refusal names the agent's models still open.
		const open = own.filter((model) => {
			if (model === only.model) return false;
			if (registered(model, models) === undefined) return true;
			if (modelProblem(model, models) !== undefined) return false;
			const slash = model.indexOf("/");
			return activeMark(models, model.slice(0, slash), model.slice(slash + 1)) === undefined;
		});
		const hint =
			explicit !== undefined && open.length > 0
				? ` Omit model to launch ${agent.name} on ${open[0]}${open.length > 1 ? ` (also open: ${open.slice(1).join(", ")})` : ""}, or clear marks with /delegate-clear.`
				: " Clear marks with /delegate-clear.";
		throw new Error(`${only.model} is ${only.reason}.${hint}`);
	}
	throw new Error(
		`no model is available for agent ${agent.name}:\n${skipped.map((item) => `- ${item.model}: ${item.reason}`).join("\n")}\nClear marks with /delegate-clear.`,
	);
}

/** The sentence that says a fallback ran, or "" when the agent's own model did. */
export const fallbackNote = (start: { model: string; skipped: readonly Skipped[] }): string =>
	start.skipped.length === 0
		? ""
		: `Used fallback ${start.model} because ${start.skipped.map((item) => `${item.model} is ${item.why}`).join("; ")}.`;
