import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTmuxClient } from "../src/tmux.ts";

test("a tmux call that outlasts the timeout rejects naming the subcommand", async () => {
	const dir = mkdtempSync(join(tmpdir(), "squire-tmux-"));
	const oldPath = process.env.PATH;
	try {
		writeFileSync(join(dir, "tmux"), "#!/bin/sh\nexec sleep 5\n");
		chmodSync(join(dir, "tmux"), 0o755);
		process.env.PATH = `${dir}:${oldPath}`;
		await assert.rejects(createTmuxClient({ timeoutMs: 100 }).listWindows(), {
			message: "tmux list-windows timed out after 0.1 s",
		});
	} finally {
		process.env.PATH = oldPath;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an invalid whole tmux window-id response is unknown", async () => {
	const dir = mkdtempSync(join(tmpdir(), "squire-tmux-id-"));
	const oldPath = process.env.PATH;
	const oldTmux = process.env.TMUX;
	try {
		writeFileSync(
			join(dir, "tmux"),
			'#!/bin/sh\nif [ "$1" = display-message ]; then echo "$1"; else printf "warning\\n@42\\n"; fi\n',
		);
		chmodSync(join(dir, "tmux"), 0o755);
		process.env.PATH = `${dir}:${oldPath}`;
		process.env.TMUX = "present";
		await assert.rejects(createTmuxClient().openWindow({ name: "x", cwd: dir, env: {}, argv: ["pi"] }), {
			certainty: "unknown",
		});
	} finally {
		process.env.PATH = oldPath;
		process.env.TMUX = oldTmux;
		rmSync(dir, { recursive: true, force: true });
	}
});
