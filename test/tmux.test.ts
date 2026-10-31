import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTmuxClient, parseTmuxVersion, requireTmuxVersion } from "../src/tmux.ts";

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
		await assert.rejects(createTmuxClient().openWindow({ name: "x", cwd: dir, env: {}, argv: ["pi"] }, "current", ""), {
			certainty: "unknown",
		});
	} finally {
		process.env.PATH = oldPath;
		process.env.TMUX = oldTmux;
		rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * A real-client argument stub. The file created by new-session changes the
 * next ownership read, including managed and unmarked race winners.
 */
async function withStub(mode: string, body: (log: () => string[]) => Promise<void>, parent = "work"): Promise<void> {
	const base = "project-delegate-session";
	const dir = mkdtempSync(join(tmpdir(), "squire-tmux-companion-"));
	const saved = { path: process.env.PATH, tmux: process.env.TMUX, pane: process.env.TMUX_PANE };
	try {
		const script = [
			"#!/bin/sh",
			`echo "$*" >> '${dir}/log'`,
			'case "$1" in',
			'-V) echo "tmux 3.7b";;',
			`display-message) printf '$1\\t${parent}\\n';;`,
			"list-windows) printf '@1\\t0\\tlegacy-squire\\ta\\tb\\n@2\\t1\\twork\\tplain\\n';;",
			`list-sessions) if [ -f '${dir}/gone' ] && [ '${mode}' = window-gone-read-error ]; then echo "server gone" >&2; exit 1; fi; if [ -f '${dir}/made' ] && [ '${mode}' = duplicate-read-error ]; then echo "server gone" >&2; exit 1; fi; printf '$1\\t\\twork\\n'; if [ -f '${dir}/made' ]; then case '${mode}' in unmarked|duplicate-unmarked) printf '$2\\t\\t${base}\\n';; *) printf '$2\\t1\\t${base}\\n';; esac; fi;;`,
			`new-window) case '${mode}' in window-gone|window-gone-read-error) rm '${dir}/made'; touch '${dir}/gone'; echo "can't find session: $2" >&2; exit 1;; window-full) echo "no space" >&2; exit 1;; window-malformed) printf 'warning\\n@8\\n'; exit 0;; esac; case "$*" in *'-t $1 '*) echo @8;; *'-t $2 '*) echo @8;; *) echo @99;; esac;;`,
			`new-session) case '${mode}' in full) echo "no space" >&2; exit 1;; malformed) printf 'warning\\n@7\\n';; duplicate|duplicate-unmarked|duplicate-read-error) if [ -f '${dir}/made' ]; then echo @7; else touch '${dir}/made'; echo "duplicate session: x" >&2; exit 1; fi;; *) touch '${dir}/made'; echo @7;; esac;;`,
			"esac",
		].join("\n");
		writeFileSync(join(dir, "tmux"), `${script}\n`);
		chmodSync(join(dir, "tmux"), 0o755);
		process.env.PATH = `${dir}:${saved.path}`;
		process.env.TMUX = "present";
		process.env.TMUX_PANE = "%1";
		if (mode === "made" || mode === "unmarked" || mode.startsWith("window-")) writeFileSync(join(dir, "made"), "");
		await body(() => readFileSync(join(dir, "log"), "utf8").trim().split("\n"));
	} finally {
		process.env.PATH = saved.path;
		process.env.TMUX = saved.tmux;
		if (saved.pane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = saved.pane;
		rmSync(dir, { recursive: true, force: true });
	}
}

const SPEC = { name: "scout-x", cwd: "/work", env: { A: "1" }, argv: ["pi", "--x"] };
const BASE = "project-delegate-session";

test("a fresh companion is created and marked in one command queue, with exact option targets", async () => {
	await withStub("ok", async (log) => {
		assert.deepEqual(await createTmuxClient().openWindow(SPEC, "companion", BASE), { id: "@7", session: BASE });
		assert.deepEqual(
			log().map((line) => line.split(" ")[0]),
			["display-message", "list-sessions", "new-session"],
		);
		assert.equal(
			log()[2],
			"new-session -d -s project-delegate-session -n scout-x -c /work -e A=1 -P -F #{window_id} -- pi --x ; set-option -t =project-delegate-session: @squire-companion 1 ; set-option -t =project-delegate-session: detach-on-destroy off",
		);
	});
});

test("a managed companion is opened by its verified session id, not a prefix or the invoking session", async () => {
	await withStub(
		"made",
		async (log) => {
			assert.deepEqual(await createTmuxClient().openWindow(SPEC, "companion", BASE), { id: "@8", session: BASE });
			assert.match(log()[2], / -t \$2 -- pi --x$/);
			assert.equal(
				log().some((line) => line.startsWith("set-option")),
				false,
			);
		},
		"unrelated ",
	);
});

test("a managed companion that vanishes before new-window is reselected and created once", async () => {
	await withStub("window-gone", async (log) => {
		assert.deepEqual(await createTmuxClient().openWindow(SPEC, "companion", BASE), { id: "@7", session: BASE });
		assert.deepEqual(
			log().map((line) => line.split(" ")[0]),
			["display-message", "list-sessions", "new-window", "list-sessions", "new-session"],
		);
		assert.equal(log().filter((line) => line.startsWith("new-session")).length, 1);
	});
});

test("a definite missing managed target leaves a failed recheck known not-opened", async () => {
	await withStub("window-gone-read-error", async (log) => {
		await assert.rejects(createTmuxClient().openWindow(SPEC, "companion", BASE), {
			certainty: "not-opened",
			message: /server gone/,
		});
		assert.deepEqual(
			log().map((line) => line.split(" ")[0]),
			["display-message", "list-sessions", "new-window", "list-sessions"],
		);
	});
});

test("ambiguous managed new-window errors and malformed answers never retry", async () => {
	for (const mode of ["window-full", "window-malformed"]) {
		await withStub(mode, async (log) => {
			await assert.rejects(createTmuxClient().openWindow(SPEC, "companion", BASE), { certainty: "unknown" });
			assert.deepEqual(
				log().map((line) => line.split(" ")[0]),
				["display-message", "list-sessions", "new-window"],
			);
		});
	}
});

test("an unmarked occupied name is not adopted or configured", async () => {
	await withStub("unmarked", async (log) => {
		assert.deepEqual(await createTmuxClient().openWindow(SPEC, "companion", BASE), { id: "@7", session: `${BASE}-2` });
		assert.ok(log()[2].startsWith(`new-session -d -s ${BASE}-2 `));
		assert.equal(
			log().some((line) => line.startsWith("new-window")),
			false,
		);
	});
});

test("a duplicate creation rechecks ownership and opens only the managed winner", async () => {
	await withStub("duplicate", async (log) => {
		assert.deepEqual(await createTmuxClient().openWindow(SPEC, "companion", BASE), { id: "@8", session: BASE });
		assert.deepEqual(
			log().map((line) => line.split(" ")[0]),
			["display-message", "list-sessions", "new-session", "list-sessions", "new-window"],
		);
	});
});

test("a failed ownership recheck after a dispatched creation retains unknown certainty", async () => {
	await withStub("duplicate-read-error", async (log) => {
		await assert.rejects(createTmuxClient().openWindow(SPEC, "companion", BASE), {
			certainty: "unknown",
			message: /server gone/,
		});
		assert.equal(log().filter((line) => line.startsWith("new-session")).length, 1);
	});
});

test("a duplicate creation by a user selects another name without opening in the winner", async () => {
	await withStub("duplicate-unmarked", async (log) => {
		assert.deepEqual(await createTmuxClient().openWindow(SPEC, "companion", BASE), { id: "@7", session: `${BASE}-2` });
		assert.deepEqual(
			log().map((line) => line.split(" ")[0]),
			["display-message", "list-sessions", "new-session", "list-sessions", "new-session"],
		);
	});
});

test("an ambiguous create error or malformed answer never retries the task", async () => {
	for (const mode of ["full", "malformed"]) {
		await withStub(mode, async (log) => {
			await assert.rejects(createTmuxClient().openWindow(SPEC, "companion", BASE), { certainty: "unknown" });
			assert.equal(log().filter((line) => line.startsWith("new-session")).length, 1);
			assert.equal(
				log().some((line) => line.startsWith("new-window")),
				false,
			);
		});
	}
});

test("current placement still targets the pane's own session id, preserving trailing spaces", async () => {
	await withStub(
		"made",
		async (log) => {
			assert.deepEqual(await createTmuxClient().openWindow(SPEC, "current", ""), { id: "@8", session: "work " });
			assert.equal(log().length, 2);
			assert.match(log()[1], / -t \$1 -- pi --x$/);
		},
		"work ",
	);
});

test("the tmux version is parsed from tmux -V and asked once", async () => {
	await withStub("ok", async (log) => {
		const client = createTmuxClient();
		const [first, second] = await Promise.all([client.version(), client.version()]);
		assert.deepEqual(first, { text: "tmux 3.7b", major: 3, minor: 7 });
		assert.equal(second, first);
		await client.version();
		assert.deepEqual(log(), ["-V"]);
	});
});

test("listed windows carry their actual session and preserve tabs in names", async () => {
	await withStub("ok", async () => {
		assert.deepEqual(await createTmuxClient().listWindows(), [
			{ id: "@1", session: "legacy-squire", name: "a\tb", exited: false },
			{ id: "@2", session: "work", name: "plain", exited: true },
		]);
	});
});

test("tmux versions parse, and only those below 3.2 are refused", async () => {
	const cases: [string, number, number, boolean][] = [
		["tmux 3.2", 3, 2, true],
		["tmux 3.2a", 3, 2, true],
		["tmux 3.10", 3, 10, true],
		["tmux 3.1c", 3, 1, false],
		["tmux 3.0a", 3, 0, false],
		["tmux 2.9", 2, 9, false],
		["tmux next-3.4", 3, 4, true],
		["tmux 4.0", 4, 0, true],
	];
	for (const [text, major, minor, accepted] of cases) {
		const version = parseTmuxVersion(`${text}\n`);
		assert.deepEqual([version.text, version.major, version.minor], [text, major, minor]);
		const check = requireTmuxVersion({ version: async () => version });
		if (accepted) await check;
		else await assert.rejects(check, new RegExp(`tmux 3\\.2 or later; this is ${text.replace(".", "\\.")}`));
	}
});

/** Run `body` with a stub `tmux` first on PATH that logs each call and answers the navigation commands. */
async function withNavigationStub(body: (log: () => string[]) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "squire-tmux-nav-"));
	const oldPath = process.env.PATH;
	try {
		const script = [
			"#!/bin/sh",
			`printf '%s\\n' "$*" >> '${dir}/log'`,
			'case "$1" in',
			"list-clients) printf '100\\told\\n900\\tnew\\n500\\tmid\\n';;",
			"display-message) echo '$7';;",
			"capture-pane) echo 'pane text';;",
			"esac",
			"",
		].join("\n");
		writeFileSync(join(dir, "tmux"), script);
		chmodSync(join(dir, "tmux"), 0o755);
		process.env.PATH = `${dir}:${oldPath}`;
		await body(() => readFileSync(join(dir, "log"), "utf8").split("\n").filter(Boolean));
	} finally {
		process.env.PATH = oldPath;
		rmSync(dir, { recursive: true, force: true });
	}
}

test("clientFor asks for the exact session's clients and picks the most recently active", async () => {
	await withNavigationStub(async (log) => {
		assert.equal(await createTmuxClient().clientFor("work"), "new");
		assert.deepEqual(log(), ["list-clients -t =work: -F #{client_activity}\t#{client_name}"]);
	});
});

test("switchTo and capture run their tmux commands", async () => {
	await withNavigationStub(async (log) => {
		const tmux = createTmuxClient();
		await tmux.switchTo("c1", "@4");
		assert.equal(await tmux.capture("@4"), "pane text\n");
		assert.deepEqual(log(), ["switch-client -c c1 -t @4", "capture-pane -p -t @4"]);
	});
});
