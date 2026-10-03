// The one test file that runs the real usage client, with `globalThis.fetch`
// stubbed. It never reaches the network, and puts `fetch` back afterwards.

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";

import { createUsageClient } from "../src/usage.ts";
import { agentDir, agentFile, cleanup, resetRoot, session, writeAgent } from "./harness.ts";

const realFetch = globalThis.fetch;
const URL_ = "https://opencode.ai/zen/go/v1/usage";
const FULL = {
	usage: {
		rolling: { status: "rate-limited", percent: 100, resetsAt: "2999-10-03T15:00:00.000Z" },
		weekly: { status: "ok", percent: 30, resetsAt: "2999-10-08T00:00:00.000Z" },
		monthly: { status: "ok", percent: 12, resetsAt: "2999-11-01T00:00:00.000Z" },
	},
};
const realEnv = { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
const tmp = mkdtempSync(join(tmpdir(), "squire-usage-"));
const claudeDir = join(tmp, "config");
const bin = join(tmp, "bin");
const argsFile = join(tmp, "claude-args");
const requests: { url: string; init: RequestInit | undefined }[] = [];
const EXTRA = [{ provider: "opencode-go", id: "paid" }];

beforeEach(() => {
	resetRoot();
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "pi-squire-limits.json"), "[]");
	writeAgent("paid", agentFile({ description: "d", thinking: "low", model: "opencode-go/paid" }));
	requests.length = 0;
	// Every test in this file reads the Claude cache from the temp directory, never ~/.claude.json.
	process.env.CLAUDE_CONFIG_DIR = claudeDir;
	process.env.PATH = `${bin}${delimiter}${realEnv.PATH}`;
	rmSync(claudeDir, { recursive: true, force: true });
	mkdirSync(claudeDir, { recursive: true });
	mkdirSync(bin, { recursive: true });
	writeFileSync(argsFile, "");
	writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "$@" >> "${argsFile}"\n`);
	chmodSync(join(bin, "claude"), 0o755);
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		requests.push({ url: String(url), init });
		return Response.json(FULL);
	}) as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = realFetch;
	for (const [key, value] of Object.entries(realEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});
after(() => {
	cleanup();
	rmSync(tmp, { recursive: true, force: true });
});

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

const cacheFile = (fetchedAtMs: number, percent: number) =>
	writeFileSync(
		join(claudeDir, ".claude.json"),
		JSON.stringify({
			cachedUsageUtilization: {
				fetchedAtMs,
				utilization: { limits: [{ kind: "session", percent, resets_at: "2999-10-03T15:00:00.000Z" }] },
			},
		}),
	);

const claudeSession = () => {
	writeAgent("claude", agentFile({ description: "d", thinking: "low", model: "anthropic/opus" }));
	return session({
		extraModels: [{ provider: "anthropic", id: "opus" }],
		oauth: ["anthropic/opus"],
		usage: createUsageClient() as never,
	});
};

test("a full Claude cache blocks a launch without running `claude`", async () => {
	const real = claudeSession();
	await real.start();
	cacheFile(Date.now(), 100);
	await assert.rejects(
		real.toolCall("delegate", { agent: "claude", task: "t" }),
		/usage-limited .*Claude 5h window at 100%/s,
	);
	assert.equal(readFileSync(argsFile, "utf8"), "");
});

test("a stale Claude cache runs `claude -p /usage` once within 5 minutes", async () => {
	const real = claudeSession();
	await real.start();
	cacheFile(Date.now() - 6 * 60_000, 10);
	await real.toolCall("delegate", { agent: "claude", task: "t" });
	await real.toolCall("delegate", { agent: "claude", task: "t" });
	for (let i = 0; i < 50 && readFileSync(argsFile, "utf8") === ""; i++) await new Promise((r) => setTimeout(r, 50));
	await new Promise((r) => setTimeout(r, 200));
	assert.equal(readFileSync(argsFile, "utf8"), "-p /usage --no-session-persistence\n");
});

test("a missing Claude cache fails open, and a missing `claude` binary is silent", async () => {
	process.env.PATH = join(tmp, "empty"); // no `claude` on it: spawn reports ENOENT
	const real = claudeSession();
	await real.start();
	const result = await real.toolCall("delegate", { agent: "claude", task: "t" });
	assert.match(result.content[0].text, /Could not read anthropic quota: cache unreadable/);
});
