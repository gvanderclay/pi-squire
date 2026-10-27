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
		await assert.rejects(createTmuxClient().openWindow({ name: "x", cwd: dir, env: {}, argv: ["pi"] }, "current"), {
			certainty: "unknown",
		});
	} finally {
		process.env.PATH = oldPath;
		process.env.TMUX = oldTmux;
		rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * Run `body` with a stub `tmux` first on PATH that logs each call, answers
 * `new-window` only once a marker exists, and answers `new-session` as `mode`
 * says: `ok`, `duplicate` (another launch won; the session now exists), `dupgone` (it won, then
 * vanished) or `full`; `made` starts with the session there. A `new-window` whose target is not
 * the exact `=<companion>:` stands for tmux's prefix matching onto another session, `@99`.
 */
async function withStub(
	mode: string,
	body: (log: () => string[]) => Promise<void>,
	parent = "work",
	marked = false,
): Promise<void> {
	const companion = marked ? parent : `${parent}-squire`;
	const dir = mkdtempSync(join(tmpdir(), "squire-tmux-companion-"));
	const saved = { path: process.env.PATH, tmux: process.env.TMUX, pane: process.env.TMUX_PANE };
	try {
		const script = [
			"#!/bin/sh",
			`echo "$*" >> '${dir}/log'`,
			'case "$1" in',
			'-V) echo "tmux 3.7b";;',
			`display-message) printf '$1\\t${marked ? "1" : ""}\\t${parent}\\n';;`,
			"list-windows) printf '@1\\t0\\twork-squire\\ta\\tb\\n@2\\t1\\twork\\tplain\\n';;",
			`new-window) case "$*" in *'-t $1 '*) echo @8;; *"-t =${companion}: "*) if [ -f '${dir}/made' ]; then echo @8; else echo "can't find session: x" >&2; exit 1; fi;; *) echo @99;; esac;;`,
			`new-session) case '${mode}' in ok) touch '${dir}/made'; echo @7;; duplicate) touch '${dir}/made'; echo "duplicate session: x" >&2; exit 1;; dupgone) echo "duplicate session: x" >&2; exit 1;; *) echo "no space" >&2; exit 1;; esac;;`,
			"esac",
		].join("\n");
		writeFileSync(join(dir, "tmux"), `${script}\n`);
		chmodSync(join(dir, "tmux"), 0o755);
		process.env.PATH = `${dir}:${saved.path}`;
		process.env.TMUX = "present";
		process.env.TMUX_PANE = "%1";
		if (mode === "made") writeFileSync(join(dir, "made"), "");
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

test("a companion window falls back to one new-session that also sets detach-on-destroy on it alone", async () => {
	await withStub("ok", async (log) => {
		assert.deepEqual(await createTmuxClient().openWindow(SPEC, "companion"), { id: "@7", session: "work-squire" });
		const [, window, session] = log();
		assert.match(window, /^new-window -d .* -t =work-squire: -- pi --x$/);
		assert.equal(
			session,
			"new-session -d -s work-squire -n scout-x -c /work -e A=1 -P -F #{window_id} -- pi --x ; set-option -t =work-squire: detach-on-destroy off ; set-option -t =work-squire: @squire-companion 1",
		);
		assert.equal(log().length, 3);
	});
});

test("a companion window that loses the new-session race retries new-window once", async () => {
	await withStub("duplicate", async (log) => {
		assert.deepEqual(await createTmuxClient().openWindow(SPEC, "companion"), { id: "@8", session: "work-squire" });
		assert.deepEqual(
			log().map((line) => line.split(" ")[0]),
			["display-message", "new-window", "new-session", "new-window"],
		);
	});
});

test("a failed new-session is unknown, since tmux may have created the window", async () => {
	await withStub("full", async () => {
		await assert.rejects(createTmuxClient().openWindow(SPEC, "companion"), {
			certainty: "unknown",
			message: /no space/,
		});
	});
});

test("current placement runs the one new-window it always did, aimed at the pane's session id", async () => {
	await withStub("made", async (log) => {
		assert.deepEqual(await createTmuxClient().openWindow(SPEC, "current"), { id: "@8", session: "work" });
		assert.equal(log().length, 2);
		assert.match(log()[1], /^new-window -d -P -F #\{window_id\} -n scout-x -c \/work -e A=1 -t \$1 -- pi --x$/);
	});
});

test("the tmux version is parsed from tmux -V and asked once", async () => {
	await withStub("ok", async (log) => {
		const client = createTmuxClient();
		const [first, second] = await Promise.all([client.version(), client.version()]);
		assert.deepEqual(first, { text: "tmux 3.7b", major: 3, minor: 7 });
		assert.equal(second, first);
		await client.version();
		assert.deepEqual(log(), ["-V"], "concurrent and later calls share one ask");
	});
});

test("a parent session name keeps its trailing space, so its companion is not the one of its trimmed twin", async () => {
	await withStub(
		"ok",
		async (log) => {
			assert.deepEqual(await createTmuxClient().openWindow(SPEC, "companion"), { id: "@7", session: "work -squire" });
			const [, window, session] = log();
			assert.match(window, / -t =work -squire: -- pi --x$/);
			assert.match(session, /^new-session -d -s work -squire -n /);
			assert.match(
				session,
				/ set-option -t =work -squire: detach-on-destroy off ; set-option -t =work -squire: @squire-companion 1$/,
			);
		},
		"work ",
	);
	await withStub(
		"made",
		async () => {
			assert.deepEqual(await createTmuxClient().openWindow(SPEC, "current"), { id: "@8", session: "work " });
		},
		"work ",
	);
});

test("a parent named pi-squire without the mark gets pi-squire-squire; one in a marked session uses its own", async () => {
	await withStub(
		"ok",
		async () => {
			assert.deepEqual(await createTmuxClient().openWindow(SPEC, "companion"), {
				id: "@7",
				session: "pi-squire-squire",
			});
		},
		"pi-squire",
	);
	await withStub(
		"made",
		async (log) => {
			assert.deepEqual(await createTmuxClient().openWindow(SPEC, "companion"), {
				id: "@8",
				session: "pi-squire-squire",
			});
			assert.deepEqual(
				log().map((line) => line.split(" ")[0]),
				["display-message", "new-window"],
			);
		},
		"pi-squire-squire",
		true,
	);
});

test("a companion target is the exact =name: even when another session's name starts with it", async () => {
	// The stub answers any other target as if tmux had prefix-matched `work-squire-old`.
	await withStub("ok", async (log) => {
		assert.deepEqual(await createTmuxClient().openWindow(SPEC, "companion"), { id: "@7", session: "work-squire" });
		const targets = log().flatMap((line) => line.match(/ -t (\S+)/)?.[1] ?? []);
		assert.deepEqual(targets.slice(1), ["=work-squire:", "=work-squire:"]);
	});
});

test("a failed retry after losing the new-session race is unknown", async () => {
	await withStub("dupgone", async (log) => {
		await assert.rejects(createTmuxClient().openWindow(SPEC, "companion"), { certainty: "unknown" });
		assert.deepEqual(
			log().map((line) => line.split(" ")[0]),
			["display-message", "new-window", "new-session", "new-window"],
		);
	});
});

test("listed windows carry their session, and a tab in a window name stays in the name", async () => {
	await withStub("ok", async () => {
		assert.deepEqual(await createTmuxClient().listWindows(), [
			{ id: "@1", session: "work-squire", name: "a\tb", exited: false },
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
