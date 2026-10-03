// The one test file that runs the real usage client, with `globalThis.fetch`
// stubbed. It never reaches the network, and puts `fetch` back afterwards.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";

import { createUsageClient } from "../src/usage.ts";
import { agentDir, agentFile, cleanup, resetRoot, session, writeAgent } from "./harness.ts";

const realFetch = globalThis.fetch;
const URL_ = "https://opencode.ai/zen/go/v1/usage";
const FULL = {
	usage: {
		rolling: { status: "rate-limited", percent: 100, resetsAt: "2026-10-03T15:00:00.000Z" },
		weekly: { status: "ok", percent: 30, resetsAt: "2026-10-08T00:00:00.000Z" },
		monthly: { status: "ok", percent: 12, resetsAt: "2026-11-01T00:00:00.000Z" },
	},
};
const requests: { url: string; init: RequestInit | undefined }[] = [];
const EXTRA = [{ provider: "opencode-go", id: "paid" }];

beforeEach(() => {
	resetRoot();
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "pi-squire-limits.json"), "[]");
	writeAgent("paid", agentFile({ description: "d", thinking: "low", model: "opencode-go/paid" }));
	requests.length = 0;
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		requests.push({ url: String(url), init });
		return Response.json(FULL);
	}) as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = realFetch;
});
after(() => cleanup());

test("a full-quota payload blocks a launch, and the key goes only to the Go origin", async () => {
	const real = session({ extraModels: EXTRA, usage: createUsageClient() as never });
	await real.start();
	await assert.rejects(
		real.toolCall("delegate", { agent: "paid", task: "t" }),
		/usage-limited .*Go 5h window at 100%/s,
	);
	assert.equal(requests.length, 1);
	assert.equal(requests[0].url, URL_);
	assert.equal(requests[0].init?.redirect, "error");
	assert.deepEqual(requests[0].init?.headers, {
		Authorization: "Bearer fake-key-opencode-go",
		Accept: "application/json",
	});
	assert.equal(real.tmux.opened.length, 0);
});

test("a provider base URL on another origin makes no fetch and fails open", async () => {
	const p = session({
		extraModels: EXTRA,
		usage: createUsageClient() as never,
		providerBaseUrls: { "opencode-go": "https://evil.example/v1" },
	});
	await p.start();
	const result = await p.toolCall("delegate", { agent: "paid", task: "t" });
	assert.equal(requests.length, 0);
	assert.match(
		result.content[0].text,
		/Could not read opencode-go quota: .*not on https:\/\/opencode\.ai.*launched without a proactive check/,
	);
});

test("HTTP errors, bad payloads and network errors fail open without throwing", async () => {
	const client = createUsageClient();
	const urls = [] as (string | undefined)[];
	globalThis.fetch = (async () => new Response("no", { status: 500 })) as typeof fetch;
	assert.deepEqual(await client.readGo("k", urls), { ok: false, reason: "HTTP 500" });
	globalThis.fetch = (async () => Response.json({ nope: 1 })) as typeof fetch;
	assert.deepEqual(await client.readGo("k", urls), { ok: false, reason: "unreadable response" });
	globalThis.fetch = (async () => {
		throw new TypeError("boom");
	}) as typeof fetch;
	assert.deepEqual(await client.readGo("k", urls), { ok: false, reason: "network error: boom" });
	assert.deepEqual(await client.readGo(undefined, urls), { ok: false, reason: "no API key" });
});
