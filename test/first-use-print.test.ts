import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("real Pi print/JSON command diagnostics use stderr without messages or a model run", { timeout: 90_000 }, () => {
	const home = mkdtempSync(join(tmpdir(), "squire-first-print-"));
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PI_|TMUX|HERDR|PASEO_)/.test(key)));
	const agent = join(home, "agent");
	mkdirSync(agent);
	try {
		for (const mode of ["text", "json"]) {
			for (const scenario of ["empty", "form", "host", "mail", "settings", "doctor", "resume", "open", "cleanup"]) {
				const command =
					(
						{
							doctor: "/delegate-doctor",
							form: "/delegate",
							resume: "/delegate-resume missing follow-up",
							open: "/delegate-open missing",
							cleanup: "/delegate-cleanup",
						} as Record<string, string>
					)[scenario] ?? "/delegate scout hello";
				mkdirSync(join(agent, "agents"), { recursive: true });
				const scout = join(agent, "agents", "scout.md");
				if (scenario === "empty" || scenario === "form" || scenario === "doctor") rmSync(scout, { force: true });
				else writeFileSync(scout, "---\nmodel: first-use-test-alias\n---\n");
				const settings = join(agent, "squire", "settings.json");
				rmSync(settings, { force: true });
				if (scenario === "settings") {
					mkdirSync(join(agent, "squire"), { recursive: true });
					writeFileSync(settings, "{broken");
				}
				const extension =
					scenario === "host" || scenario === "doctor" ? "src/index.ts" : "test/fixtures/first-use-print.ts";
				const run = spawnSync(
					resolve("node_modules/.bin/pi"),
					[
						"--print",
						"--mode",
						mode,
						"--session-dir",
						join(home, "sessions"),
						"-ne",
						"-e",
						resolve(extension),
						command,
					],
					{
						encoding: "utf8",
						timeout: 30_000,
						cwd: home,
						env: { ...env, HOME: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1" },
					},
				);
				assert.equal(run.error, undefined);
				assert.equal(run.status, 0, run.stderr);
				if (command === "/delegate-doctor") {
					assert.match(run.stderr, /delegate-doctor.*read-only/);
					assert.match(run.stderr, /Roster: 0 usable/);
					assert.match(run.stderr, /message:send: no handler answered/);
					assert.match(run.stderr, /Session directory:/);
				} else if (scenario === "empty" || scenario === "form")
					assert.match(run.stderr, /no agents are defined.*no reload needed/);
				else if (scenario === "host") assert.match(run.stderr, /Host prerequisite:.*tmux new-session/);
				else if (scenario === "mail") assert.match(run.stderr, /message:\*.*pi install npm:pi-session-mail.*\/reload/);
				else if (scenario === "resume") assert.match(run.stderr, /delegate:.*(?:no delegation|unknown|record|found)/);
				else if (scenario === "open") assert.match(run.stderr, /delegate: no open delegate/);
				else if (scenario === "cleanup") assert.match(run.stderr, /delegate-cleanup needs an interactive session/);
				else assert.match(run.stderr, /could not read squire settings.*settings.json/);
				if (mode === "text") assert.equal(run.stdout, "");
				else {
					const records = run.stdout
						.trim()
						.split("\n")
						.filter(Boolean)
						.map((line) => JSON.parse(line));
					assert.ok(
						records.every((record) => record.type === "session"),
						run.stdout,
					);
				}
			}
		}
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
