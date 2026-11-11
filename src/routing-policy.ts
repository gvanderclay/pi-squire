import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isThinking } from "./agents.ts";
import { CATEGORIES, type RoutingPolicy, type RoutingRequest } from "./routing-types.ts";

type ObjectValue = Record<string, unknown>;
function object(value: unknown, path: string): ObjectValue {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
	return value as ObjectValue;
}
function keys(value: ObjectValue, allowed: string[], path: string): void {
	const extra: string[] = Object.keys(value).filter((key) => !allowed.includes(key));
	if (extra.length) throw new Error(`${path} has unknown fields: ${extra.join(", ")}`);
}
function name(value: unknown, path: string): asserts value is string {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value))
		throw new Error(`${path} must be a nonempty name (letters, digits, _, . or -)`);
}
function strings(value: unknown, path: string): asserts value is string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim()))
		throw new Error(`${path} must be an array of nonempty strings`);
	if (new Set(value).size !== value.length) throw new Error(`${path} has duplicate entries`);
}
function integer(value: unknown, path: string): void {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${path} must be a nonnegative integer`);
}
function optionalBoolean(value: unknown, path: string): void {
	if (value !== undefined && typeof value !== "boolean") throw new Error(`${path} must be boolean`);
}
export function exactModel(value: unknown): value is string {
	return typeof value === "string" && /^[^/\s*,]+\/[^\s*,]+$/.test(value);
}
function modelPolicy(value: unknown, path: string): void {
	const model: ObjectValue = object(value, path);
	keys(model, ["family", "data", "capabilities"], path);
	name(model.family, `${path}.family`);
	if (!["any", "public-only"].includes(String(model.data))) throw new Error(`${path}.data must be any or public-only`);
	if (model.capabilities !== undefined) strings(model.capabilities, `${path}.capabilities`);
}
function route(value: unknown, path: string, models: ObjectValue): void {
	const entry: ObjectValue = object(value, path);
	keys(entry, ["minQuality", "candidates"], path);
	integer(entry.minQuality, `${path}.minQuality`);
	if (!Array.isArray(entry.candidates) || !entry.candidates.length)
		throw new Error(`${path}.candidates must be nonempty`);
	const seen: Set<string> = new Set();
	for (const raw of entry.candidates) {
		const candidate: ObjectValue = object(raw, `${path}.candidate`);
		keys(candidate, ["model", "thinking", "quality", "priority"], path);
		if (!exactModel(candidate.model) || !Object.hasOwn(models, candidate.model))
			throw new Error(`${path}: candidate must name an exact model in models`);
		if (seen.has(candidate.model)) throw new Error(`${path}: duplicate model ${candidate.model}`);
		seen.add(candidate.model);
		if (typeof candidate.thinking !== "string" || !isThinking(candidate.thinking))
			throw new Error(`${path}: invalid thinking level`);
		integer(candidate.quality, `${path}.quality`);
		if (candidate.priority !== undefined) integer(candidate.priority, `${path}.priority`);
	}
}
function profile(value: unknown, path: string, models: ObjectValue): void {
	const entry: ObjectValue = object(value, path);
	keys(entry, ["pool", "independentReview", "routes"], path);
	name(entry.pool, `${path}.pool`);
	optionalBoolean(entry.independentReview, `${path}.independentReview`);
	const routes: ObjectValue = object(entry.routes, `${path}.routes`);
	keys(routes, [...CATEGORIES], `${path}.routes`);
	if (!Object.keys(routes).length) throw new Error(`${path}.routes must not be empty`);
	for (const [key, value] of Object.entries(routes)) route(value, `${path}.routes.${key}`, models);
}
/** Strict, pure v1 parser. Unknown fields/versions refuse rather than weaken constraints. */
export function parseRoutingPolicy(value: unknown): RoutingPolicy {
	const policy: ObjectValue = object(value, "routing");
	keys(policy, ["version", "models", "profiles", "usage"], "routing");
	if (policy.version !== 1) throw new Error("routing.version must be 1");
	const models: ObjectValue = object(policy.models, "routing.models");
	for (const [id, value] of Object.entries(models)) {
		if (!exactModel(id)) throw new Error(`routing.models: ${id} is not an exact provider/id`);
		modelPolicy(value, `routing.models.${id}`);
	}
	const profiles: ObjectValue = object(policy.profiles, "routing.profiles");
	for (const [id, value] of Object.entries(profiles)) {
		name(id, "profile name");
		profile(value, `routing.profiles.${id}`, models);
	}
	if (policy.usage !== undefined) usage(policy.usage);
	return structuredClone(policy) as RoutingPolicy;
}
function usage(value: unknown): void {
	const entry: ObjectValue = object(value, "routing.usage");
	keys(entry, ["maxAgeMs", "applicableProviders"], "routing.usage");
	integer(entry.maxAgeMs, "routing.usage.maxAgeMs");
	if ((entry.maxAgeMs as number) < 1) throw new Error("routing.usage.maxAgeMs must be positive");
	strings(entry.applicableProviders, "routing.usage.applicableProviders");
}
/** Read only when a role opts in; absent/invalid policy is a routed-call error, never parent-model inheritance. */
export function readRoutingPolicy(agentDir: string): RoutingPolicy {
	const path: string = join(agentDir, "squire", "routing.json");
	try {
		return parseRoutingPolicy(JSON.parse(readFileSync(path, "utf8")));
	} catch (error) {
		throw new Error(`required routing policy ${path}: ${String((error as Error).message)}`, { cause: error });
	}
}
function requirements(value: unknown): void {
	const entry: ObjectValue = object(value, "routing.requirements");
	keys(entry, ["contextTokens", "input", "tools", "capabilities"], "routing.requirements");
	if (entry.contextTokens !== undefined) integer(entry.contextTokens, "contextTokens");
	for (const key of ["input", "tools", "capabilities"]) {
		if (entry[key] !== undefined) strings(entry[key], `routing.requirements.${key}`);
	}
	if ((entry.input as string[] | undefined)?.some((value) => !["text", "image"].includes(value)))
		throw new Error("routing.requirements.input accepts text and image");
}
/** Pure request validator, also used for --routing JSON and restored runtime constraints. */
export function parseRoutingRequest(value: unknown): RoutingRequest {
	const request: ObjectValue = object(value, "routing request (category and data required)");
	keys(request, ["category", "data", "safePublicContext", "requirements", "review"], "routing request");
	if (!(CATEGORIES as readonly unknown[]).includes(request.category))
		throw new Error(`routing.category must be ${CATEGORIES.join(", ")}`);
	if (!["private", "public", "unknown"].includes(String(request.data)))
		throw new Error("routing.data must be private, public or unknown");
	optionalBoolean(request.safePublicContext, "routing.safePublicContext");
	if (request.safePublicContext === true && request.data !== "public")
		throw new Error("safePublicContext requires data public");
	if (request.requirements !== undefined) requirements(request.requirements);
	if (request.review !== undefined) {
		const review: ObjectValue = object(request.review, "routing.review");
		keys(review, ["authors"], "routing.review");
		strings(review.authors, "routing.review.authors");
		if (!review.authors.length) throw new Error("routing.review.authors must not be empty");
	}
	return structuredClone(request) as RoutingRequest;
}
