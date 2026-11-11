import type { Static } from "typebox";
import type { Thinking } from "./agents.ts";
import type { RoutingEvidenceSchema } from "./routing-schema.ts";

export const CATEGORIES = ["narrow", "bounded", "standard", "deep"] as const;
export type Category = (typeof CATEGORIES)[number];
export type RoutingRequest = {
	category: Category;
	data: "private" | "public" | "unknown";
	/** Attests task, instructions, inherited context, workspace and future tool reads; not isolation. */
	safePublicContext?: boolean;
	requirements?: { contextTokens?: number; input?: ("text" | "image")[]; tools?: string[]; capabilities?: string[] };
	review?: { authors: string[] };
};
export type ModelPolicy = { family: string; data: "any" | "public-only"; capabilities?: string[] };
export type RouteCandidate = { model: string; thinking: Thinking; quality: number; priority?: number };
export type RoutingPolicy = {
	version: 1;
	models: Record<string, ModelPolicy>;
	profiles: Record<
		string,
		{
			pool: string;
			independentReview?: boolean;
			routes: Partial<Record<Category, { minQuality: number; candidates: RouteCandidate[] }>>;
		}
	>;
	usage?: { maxAgeMs: number; applicableProviders: string[] };
};
export type Candidate = RouteCandidate & ModelPolicy & { effectiveThinking: Thinking; pressure: boolean };
export type ServedModel = RoutingEvidence["served"][number];
export type AuthorProof = {
	source: string;
	sessionId: string;
	leafId: string | null;
	models: string[];
	families: string[];
};
export type RoutingRecord = {
	version: 1;
	policyVersion: 1;
	policyDigest: string;
	profile: string;
	role: string;
	pool: string;
	request: RoutingRequest;
	independentReview: boolean;
	authors: AuthorProof[];
	excludedFamilies: string[];
	/** Exact physical lineage map frozen at dispatch; never infer lineage from an endpoint provider. */
	models: Record<string, ModelPolicy>;
	/** CLI-account applicability frozen for mark filtering and runtime substitution. Go direct-key checks remain applicable. */
	usageProviders: string[];
	candidates: Candidate[];
	excluded?: { model: string; reason: string }[];
	observations?: {
		at: number;
		quota: Record<string, { exhausted: boolean; pressured: boolean; observedAt?: number }>;
		models: Record<string, { problem?: string; contextWindow?: number; input?: readonly string[] }>;
		tools: string[];
	};
	selected: string;
	reason: string;
	launchId?: string;
	tieTurn?: number;
};
export type RoutingEvidence = Static<typeof RoutingEvidenceSchema>;
