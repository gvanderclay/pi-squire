// The verify-pi-squire helper must not carry the driver's own Pi, tmux or Herdr
// routing into a private run, nor let its Herdr passthrough leave the run's session.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

const helper = join(import.meta.dirname, "..", ".pi", "skills", "verify-pi-squire", "scripts", "squire-verify.mjs");

test("verify helper strips every PASEO_* variable unless explicitly opted in", () => {
	for (const optIn of [undefined, "0", "1"]) {
		const env = {
			...process.env,
			PASEO_AGENT_ID: "driver-agent",
			PASEO_AGENT_CWD: "/driver/cwd",
			PASEO_OTHER: "future-routing",
			SQUIRE_VERIFY_KEEP_PASEO: optIn,
		};
		if (optIn === undefined) delete env.SQUIRE_VERIFY_KEEP_PASEO;
		const run = spawnSync(process.execPath, [helper, "self-test"], { encoding: "utf8", env });
		assert.equal(run.status, 0, run.stdout + run.stderr);
		const report = JSON.parse(run.stdout) as { paseoOptIn: boolean; defaultPaseoKeys: string[] };
		assert.equal(report.paseoOptIn, true);
		assert.deepEqual(
			report.defaultPaseoKeys.sort(),
			optIn === "1"
				? Object.keys(env)
						.filter((k) => k.startsWith("PASEO_"))
						.sort()
				: [],
		);
	}
});

test("verify helper strips driver HERDR/TMUX/PI context and rejects scope-changing Herdr probes", () => {
	const run = spawnSync(process.execPath, [helper, "self-test"], {
		encoding: "utf8",
		env: {
			...process.env,
			HERDR_ENV: "1",
			HERDR_SESSION: "default",
			HERDR_PANE_ID: "w9:p9",
			HERDR_TAB_ID: "w9:t9",
			HERDR_WORKSPACE_ID: "w9",
			HERDR_SOCKET_PATH: "/driver/herdr.sock",
			TMUX: "/driver/tmux,1,0",
			TMUX_PANE: "%9",
			PI_DELEGATE_ROOT: "driver-root",
		},
	});
	assert.equal(run.status, 0, run.stdout + run.stderr);
	const report = JSON.parse(run.stdout) as { ok: boolean; leaked: string[]; rejected: number };
	assert.deepEqual(report.leaked, []);
	assert.equal(report.rejected, 11);
});
