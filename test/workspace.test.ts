// `cwd` launches a delegate in an existing directory: both entry points
// resolve it to a real directory, keep the task bytes, leave existing
// checkouts untouched, and decide project trust in the parent. These tests
// drive the extension through its registration function, with the fake tmux,
// the scripted UI, Pi's real trust store under the harness agent directory
// and real temporary Git repositories.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { devNull } from "node:os";
import { join, resolve } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";

import { hasTrustRequiringProjectResources, ProjectTrustStore } from "@earendil-works/pi-coding-agent";

import { agentDir, agentFile, cleanup, resetRoot, root, session, writeAgent } from "./harness.ts";

// Neither the fixtures nor the extension's own Git calls read the user's Git configuration.
const savedEnv = { HOME: process.env.HOME, PATH: process.env.PATH };
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = devNull;
const home = join(root, "home");
mkdirSync(home, { recursive: true });
process.env.HOME = home;

const SCOUT = agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" });

// Runs before every subtest too, so each table row starts with no saved trust.
beforeEach(() => {
	resetRoot();
	writeAgent("scout", SCOUT);
});
/** A fresh real directory for one test's fixtures; each test sets it first. */
let base: string;
const fresh = (): string => realpathSync(mkdtempSync(join(root, "case-")));
afterEach(() => {
	process.env.PATH = savedEnv.PATH;
});
after(() => {
	process.env.HOME = savedEnv.HOME;
	cleanup();
});

const gitEnv = (): NodeJS.ProcessEnv => ({
	...process.env,
	GIT_AUTHOR_NAME: "Fixture",
	GIT_AUTHOR_EMAIL: "fixture@example.invalid",
	GIT_COMMITTER_NAME: "Fixture",
	GIT_COMMITTER_EMAIL: "fixture@example.invalid",
});
const git = (cwd: string, ...args: string[]): string =>
	execFileSync("git", args, { cwd, env: gitEnv(), stdio: ["ignore", "pipe", "pipe"] })
		.toString()
		.trim();

/** A main checkout at `dir` with one commit holding `sentinel.txt` and an `AGENTS.md`. */
function repo(dir: string): string {
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q", "-b", "main");
	writeFileSync(join(dir, "sentinel.txt"), "committed\n");
	writeFileSync(join(dir, "AGENTS.md"), `marker ${dir}\n`);
	git(dir, "add", ".");
	git(dir, "commit", "-q", "-m", "first");
	return realpathSync(dir);
}

/** A directory with a project setting Pi gates behind trust. */
function protect(dir: string): void {
	mkdirSync(join(dir, ".pi"), { recursive: true });
	writeFileSync(join(dir, ".pi", "settings.json"), "{}\n");
}

/** Recorded and structured data, read loosely: the assertions check its shape. */
// biome-ignore lint/suspicious/noExplicitAny: test data whose shape the assertions themselves check
type Data = Record<string, any>;

const flags = (argv: readonly string[]): string[] => argv.filter((x) => x === "--approve" || x === "--no-approve");
const startRecord = (s: ReturnType<typeof session>) =>
	s.entries.find((item) => typeof item.data.windowId === "string")?.data as Data | undefined;
const call = (s: ReturnType<typeof session>, cwd: unknown, task = "inspect") =>
	s.toolCall("delegate", { agent: "scout", task, cwd });

async function started(options: Parameters<typeof session>[0] = {}) {
	const s = session({ cwd: base, ...options });
	await s.start();
	return s;
}

// ---------------------------------------------------------------------------
// Directory resolution

test("cwd resolves real paths and preserves existing checkout data", async (t) => {
	base = fresh();
	// Wrong cwd, a rewritten index or a switched branch in someone's existing checkout is what this catches.
	const main = repo(join(base, "main"));
	const linked = join(base, "linked worktree");
	git(main, "worktree", "add", "-q", "-b", "review/topic", linked);
	const detached = join(base, "detached");
	git(main, "worktree", "add", "-q", "--detach", detached);
	const plain = join(base, "plain dir with spaces");
	mkdirSync(plain);
	const homeTarget = join(home, "home target");
	mkdirSync(homeTarget, { recursive: true });
	symlinkSync(linked, join(base, "link"));
	const parent = join(base, "parent");
	mkdirSync(parent);
	// Dirty work in the linked checkout must survive: a staged edit, an unstaged edit and an untracked file.
	writeFileSync(join(linked, "staged.txt"), "staged\n");
	git(linked, "add", "staged.txt");
	writeFileSync(join(linked, "sentinel.txt"), "unstaged edit\n");
	writeFileSync(join(linked, "untracked.txt"), "untracked\n");
	const indexPath = resolve(linked, git(linked, "rev-parse", "--git-path", "index"));
	const rows = [
		{ name: "absolute non-Git", input: plain, real: realpathSync(plain), kind: "non-git" },
		{ name: "../relative with spaces", input: "../plain dir with spaces", real: realpathSync(plain), kind: "non-git" },
		{ name: "~/", input: "~/home target", real: realpathSync(homeTarget), kind: "non-git" },
		{ name: "symlink to a linked worktree", input: join(base, "link"), real: realpathSync(linked), kind: "git" },
		{ name: "detached checkout", input: detached, real: realpathSync(detached), kind: "git" },
	];
	for (const row of rows) {
		await t.test(row.name, async () => {
			const indexBefore = readFileSync(indexPath);
			const sentinelBefore = readFileSync(join(linked, "sentinel.txt"));
			const s = await started({ cwd: parent });
			const result = await call(s, row.input);
			const d = startRecord(s);
			assert.ok(d);
			assert.equal(s.tmux.opened[0].cwd, row.real);
			assert.equal(d.cwd, row.real);
			assert.equal(d.workspace.mode, "existing");
			assert.equal(d.workspace.cwd, row.real);
			assert.deepEqual((result.structuredContent as Data).workspace, d.workspace);
			assert.equal((result.structuredContent as Data).cwd, row.real);
			assert.ok(result.content[0].text.includes(row.real), "a changed cwd is visible in the start text");
			const status = await s.toolCall("delegation_status", {});
			const item = (status.structuredContent as Data).delegations[0];
			assert.equal(item.workspace.git.kind, row.kind);
			assert.deepEqual(item.workspace, d.workspace);
			assert.deepEqual(readFileSync(indexPath), indexBefore);
			assert.deepEqual(readFileSync(join(linked, "sentinel.txt")), sentinelBefore);
			assert.equal(git(linked, "symbolic-ref", "--short", "HEAD"), "review/topic");
			assert.equal(readFileSync(join(linked, "untracked.txt"), "utf8"), "untracked\n");
		});
	}
	await t.test("linked and detached Git facts", async () => {
		const s = await started({ cwd: parent });
		await call(s, join(base, "link"));
		await call(s, detached);
		const [linkedRecord, detachedRecord] = s.entries
			.filter((item) => typeof item.data.windowId === "string")
			.map((item) => item.data as Data);
		const head = git(main, "rev-parse", "HEAD");
		assert.deepEqual(linkedRecord.workspace.git, {
			kind: "git",
			identity: { mainRoot: main, commonDir: realpathSync(join(main, ".git")), checkoutRoot: realpathSync(linked) },
			position: { branch: "review/topic", detached: false },
			head,
			baseline: head,
		});
		assert.deepEqual(detachedRecord.workspace.git.position, { branch: null, detached: true });
		assert.equal(detachedRecord.workspace.git.baseline, head);
	});
});

test("cwd boundary errors have no mail window or cleanup side effects", async (t) => {
	base = fresh();
	// A bad value turned into a path, or a failed launch that cleans the target, is what this catches.
	const file = join(base, "file.txt");
	writeFileSync(file, "not a directory\n");
	const target = join(base, "target");
	mkdirSync(target);
	const sentinelPath = join(target, "sentinel.txt");
	writeFileSync(sentinelPath, "keep me\n");
	const locked = join(base, "locked");
	mkdirSync(join(locked, "inner"), { recursive: true });
	const invalid: [string, unknown][] = [
		["false", false],
		["42", 42],
		["{}", {}],
		["[]", []],
		["a file", file],
		["a missing path", join(base, "missing")],
		["a traversal failure", join(locked, "inner")],
	];
	for (const [name, value] of invalid) {
		await t.test(name, async (tt) => {
			const sentinelBefore = readFileSync(sentinelPath);
			if (name === "a traversal failure") {
				if (process.getuid?.() === 0) return tt.skip("a privileged user traverses any directory");
				chmodSync(locked, 0o000);
			}
			try {
				const s = await started();
				await assert.rejects(call(s, value), /cwd|directory|access/i);
				assert.deepEqual(s.sendCalls, []);
				assert.deepEqual(s.tmux.opened, []);
				assert.deepEqual(readFileSync(sentinelPath), sentinelBefore);
			} finally {
				chmodSync(locked, 0o755);
			}
		});
	}
	await t.test("a window that fails to open leaves the target alone", async () => {
		const s = await started();
		s.tmux.failOpen = "no server running";
		await assert.rejects(call(s, target), /no server running/);
		assert.equal(readFileSync(sentinelPath, "utf8"), "keep me\n");
	});
	for (const placeholder of [null, undefined, "", "null", "none", "false", "undefined"]) {
		await t.test(`placeholder ${JSON.stringify(placeholder)} is omitted`, async () => {
			const placeholderSession = await started();
			await call(placeholderSession, placeholder);
			assert.equal(placeholderSession.tmux.opened[0].cwd, base);
			assert.equal(startRecord(placeholderSession)?.workspace.mode, "inherited");
		});
	}
});

test("inherited launches need no usable Git and keep the parent's cwd", async () => {
	base = fresh();
	// Requiring Git for an ordinary launch, or relocating it, is what this catches.
	const emptyBin = join(base, "bin");
	mkdirSync(emptyBin);
	process.env.PATH = emptyBin;
	const s = await started();
	await s.delegate("scout inspect");
	await call(s, undefined);
	const plain = join(base, "plain");
	mkdirSync(plain);
	await call(s, plain);
	const records = s.entries.filter((item) => typeof item.data.windowId === "string").map((item) => item.data as Data);
	assert.deepEqual(
		s.tmux.opened.map((item) => item.cwd),
		[base, base, plain],
	);
	assert.deepEqual(
		records.map((record) => [record.workspace.mode, record.workspace.git.kind]),
		[
			["inherited", "unknown"],
			["inherited", "unknown"],
			["existing", "unknown"],
		],
	);
	assert.match(records[2].workspace.git.reason, /git/i);
});

// ---------------------------------------------------------------------------
// Command parsing

test("quoted cwd parsing preserves the task substring", async (t) => {
	base = fresh();
	// A parser that rewrites the task's quotes or whitespace, or launches after a malformed flag, is what this catches.
	mkdirSync(join(base, "space dir"));
	const odd = 'quo"te\\dir';
	mkdirSync(join(base, odd));
	await t.test("quoted value with spaces", async () => {
		const s = await started();
		await s.delegate('scout --cwd "space dir" inspect "a b"  \\path');
		assert.deepEqual(s.errors, []);
		assert.equal(s.tmux.opened[0].cwd, join(base, "space dir"));
		assert.equal(s.sendCalls[0].body, 'inspect "a b"  \\path');
	});
	await t.test("escaped quote and backslash in a flag value", async () => {
		const s = await started();
		await s.delegate('scout --label x1 --cwd "quo\\"te\\\\dir"   "quoted task" \\"kept\\"  ');
		assert.deepEqual(s.errors, []);
		assert.equal(s.tmux.opened[0].cwd, join(base, odd));
		assert.equal(s.sendCalls[0].body, '"quoted task" \\"kept\\"');
	});
	await t.test("unquoted values and no shell expansion", async () => {
		const s = await started();
		await s.delegate("scout --cwd $HOME inspect");
		assert.equal(s.errors.length, 1);
		assert.match(s.errors[0], /\$HOME/);
		assert.deepEqual(s.tmux.opened, []);
	});
	for (const malformed of ['scout --cwd "space dir inspect', "scout --cwd", 'scout --cwd "space dir"x inspect']) {
		await t.test(`malformed: ${malformed}`, async () => {
			const s = await started();
			await s.delegate(malformed);
			assert.equal(s.errors.length, 1);
			assert.deepEqual(s.sendCalls, []);
			assert.deepEqual(s.tmux.opened, []);
		});
	}
	await t.test("a task that starts with an unterminated quote is still a task", async () => {
		const s = await started();
		await s.delegate('scout "it is  open');
		assert.deepEqual(s.errors, []);
		assert.equal(s.sendCalls[0].body, '"it is  open');
	});
	await t.test("--cwd is offered in completions", async () => {
		const s = await started();
		assert.ok((await s.completions("scout --c"))?.some((item) => item.label === "--cwd"));
	});
});

// ---------------------------------------------------------------------------
// Project trust

test("same repository uses current trust but unrelated targets use saved scope", async (t) => {
	base = fresh();
	// Parent session-only trust leaking into another repository, or a linked worktree missing its repository's decision.
	const parentMain = repo(join(base, "parent"));
	const sameLinked = join(base, "parent-worktrees", "same");
	git(parentMain, "worktree", "add", "-q", "-b", "same", sameLinked);
	protect(sameLinked);
	const linkedMain = repo(join(base, "other"));
	const otherLinked = join(base, "elsewhere", "other-linked");
	git(linkedMain, "worktree", "add", "-q", "-b", "topic", otherLinked);
	protect(otherLinked);
	const ordinaryParent = join(base, "folder");
	const ordinaryTarget = join(ordinaryParent, "target");
	mkdirSync(ordinaryTarget, { recursive: true });
	protect(ordinaryTarget);
	const free = join(base, "free");
	mkdirSync(free);
	const store = new ProjectTrustStore(agentDir);

	await t.test("same repository: a session-only false beats a saved true", async () => {
		store.set(parentMain, true);
		const same = await started({ cwd: parentMain, projectTrusted: false });
		await call(same, sameLinked);
		assert.deepEqual(flags(same.tmux.opened[0].argv), ["--no-approve"]);
		assert.equal(same.selects.length, 0);
	});
	await t.test("same repository: a current true beats a saved false", async () => {
		store.set(parentMain, false);
		const same = await started({ cwd: parentMain, projectTrusted: true });
		await call(same, sameLinked);
		assert.deepEqual(flags(same.tmux.opened[0].argv), ["--approve"]);
		assert.equal(same.selects.length, 0);
	});
	await t.test("unrelated linked worktree: the main repository's saved false beats a trusted parent", async () => {
		store.set(linkedMain, false);
		const other = await started({ cwd: parentMain, projectTrusted: true });
		await call(other, otherLinked);
		assert.deepEqual(flags(other.tmux.opened[0].argv), ["--no-approve"]);
		assert.equal(other.selects.length, 0);
		assert.equal(store.getEntry(linkedMain)?.path, linkedMain);
	});
	await t.test("unrelated linked worktree outside its repository uses the main repository's saved true", async () => {
		store.set(linkedMain, true);
		const other = await started({ cwd: parentMain, projectTrusted: false });
		await call(other, otherLinked);
		assert.deepEqual(flags(other.tmux.opened[0].argv), ["--approve"]);
		assert.equal(other.selects.length, 0);
	});
	await t.test("ordinary directory: a saved ancestor true applies", async () => {
		store.set(ordinaryParent, true);
		const ordinary = await started();
		await call(ordinary, ordinaryTarget);
		assert.deepEqual(flags(ordinary.tmux.opened[0].argv), ["--approve"]);
		assert.equal(ordinary.selects.length, 0);
		assert.equal(store.getEntry(ordinaryTarget)?.path, ordinaryParent);
	});
	await t.test("ordinary directory: a closer saved false beats the ancestor", async () => {
		store.setMany([
			{ path: ordinaryParent, decision: true },
			{ path: ordinaryTarget, decision: false },
		]);
		const ordinary = await started({ projectTrusted: true });
		await call(ordinary, ordinaryTarget);
		assert.deepEqual(flags(ordinary.tmux.opened[0].argv), ["--no-approve"]);
		assert.equal(ordinary.selects.length, 0);
	});
	await t.test("unknown resource-free target launches untrusted without a dialog", async () => {
		const freeSession = await started({ projectTrusted: true });
		await call(freeSession, free);
		assert.deepEqual(flags(freeSession.tmux.opened[0].argv), ["--no-approve"]);
		assert.equal(freeSession.selects.length, 0);
	});
});

test("checkout paths containing newlines are read as data", async () => {
	// Splitting Git's output on newlines would misname the repository, break the trust key or call the checkout unknown.
	base = fresh();
	const main = repo(join(base, "main\nrepo"));
	const linked = join(base, "linked\nwt");
	git(main, "worktree", "add", "-q", "-b", "topic", linked);
	protect(linked);
	const store = new ProjectTrustStore(agentDir);
	store.set(main, true);
	const s = await started();
	await call(s, linked);
	const d = startRecord(s);
	assert.deepEqual(d?.workspace.git.identity, {
		mainRoot: main,
		commonDir: realpathSync(join(main, ".git")),
		checkoutRoot: realpathSync(linked),
	});
	assert.deepEqual(d?.workspace.git.position, { branch: "topic", detached: false });
	assert.deepEqual(flags(s.tmux.opened[0].argv), ["--approve"], "the main repository's saved decision applies");
	assert.equal(s.selects.length, 0);
});

test("ordinary main-checkout subdirectory preserves nearer denial and saved scope", async (t) => {
	base = fresh();
	// Keying an ordinary checkout's subdirectory by its repository root would replace a nearer denial with the root's approval.
	const otherMainRoot = repo(join(base, "other"));
	const restrictedTarget = join(otherMainRoot, "restricted");
	mkdirSync(restrictedTarget);
	protect(restrictedTarget);
	await t.test("a nearer saved false wins", async () => {
		const store = new ProjectTrustStore(agentDir);
		store.setMany([
			{ path: otherMainRoot, decision: true },
			{ path: restrictedTarget, decision: false },
		]);
		const restrictedSession = await started();
		await call(restrictedSession, restrictedTarget);
		assert.deepEqual(flags(restrictedSession.tmux.opened[0].argv), ["--no-approve"]);
		assert.equal(restrictedSession.selects.length, 0);
		assert.equal(store.getEntry(restrictedTarget)?.path, restrictedTarget);
	});
	await t.test("an unresolved subdirectory saves its own decision", async () => {
		const approvedStore = new ProjectTrustStore(agentDir);
		const s = await started({ ui: { select: ["Trust"] } });
		await call(s, restrictedTarget);
		assert.equal(s.selects.length, 1);
		assert.deepEqual(flags(s.tmux.opened[0].argv), ["--approve"]);
		assert.equal(approvedStore.getEntry(restrictedTarget)?.path, restrictedTarget);
		assert.equal(approvedStore.get(restrictedTarget), true);
		assert.equal(approvedStore.get(otherMainRoot), null);
	});
});

test("trust choices preserve saved launch-only parent and cancellation scopes", async (t) => {
	base = fresh();
	// A dialog answer saved at the wrong scope, or a launch-only answer that persists, is what this catches.
	const keyParent = join(base, "projects");
	const key = join(keyParent, "target");
	mkdirSync(key, { recursive: true });
	protect(key);
	const rows: [string, boolean | null, string][] = [
		["Trust", true, "--approve"],
		[`Trust parent folder (${keyParent})`, true, "--approve"],
		["Trust (this session only)", null, "--approve"],
		["Do not trust", false, "--no-approve"],
		["Do not trust (this session only)", null, "--no-approve"],
	];
	for (const [label, expectedSavedDecision, expectedFlag] of rows) {
		await t.test(label, async () => {
			const store = new ProjectTrustStore(agentDir);
			const s = await started({ ui: { select: [label] } });
			await call(s, key);
			assert.deepEqual(s.selects[0].options, [
				"Trust",
				`Trust parent folder (${keyParent})`,
				"Trust (this session only)",
				"Do not trust",
				"Do not trust (this session only)",
			]);
			assert.ok(s.selects[0].title.includes(key), s.selects[0].title);
			assert.equal(store.get(key), expectedSavedDecision);
			assert.deepEqual(flags(s.tmux.opened[0].argv), [expectedFlag]);
			if (label.startsWith("Trust parent folder")) {
				assert.equal(store.getEntry(key)?.path, keyParent);
				assert.equal(store.getEntry(key)?.decision, true);
			}
		});
	}
	await t.test("a linked worktree's dialog names and saves its main repository", async () => {
		const main = repo(join(base, "repo"));
		const linked = join(base, "repo-worktrees", "topic");
		git(main, "worktree", "add", "-q", "-b", "topic", linked);
		protect(linked);
		const store = new ProjectTrustStore(agentDir);
		const s = await started({ ui: { select: ["Trust"] } });
		await call(s, linked);
		assert.ok(s.selects[0].title.includes(main), s.selects[0].title);
		assert.ok(s.selects[0].options.includes(`Trust parent folder (${base})`));
		assert.equal(store.getEntry(main)?.path, main);
		assert.equal(store.getEntry(realpathSync(linked)), null);
	});
	await t.test("cancellation launches nothing", async () => {
		const cancelled = await started({ ui: { select: [undefined] } });
		await assert.rejects(call(cancelled, key), /trust|cancel/i);
		assert.deepEqual(cancelled.sendCalls, []);
		assert.deepEqual(cancelled.tmux.opened, []);
		assert.equal(new ProjectTrustStore(agentDir).get(key), null);
	});
	await t.test("the filesystem root offers no parent folder", async (tt) => {
		if (!hasTrustRequiringProjectResources("/") || new ProjectTrustStore(agentDir).get("/") !== null) {
			return tt.skip("the filesystem root exposes no protected resources here; review checks this omission");
		}
		const rootSession = await started({ ui: { select: [undefined] } });
		await assert.rejects(call(rootSession, "/"));
		assert.equal(
			rootSession.selects[0].options.some((x) => x.startsWith("Trust parent folder")),
			false,
		);
	});
});

test("unresolved no UI store errors and serialized dialogs fail closed", async (t) => {
	base = fresh();
	// A missing dialog, a broken store or an answer applied to another target granting trust is what this catches.
	const target = join(base, "target");
	mkdirSync(target);
	protect(target);
	const second = join(base, "second");
	mkdirSync(second);
	protect(second);
	await t.test("no UI refuses, whatever Pi's global default", async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
		const noUi = await started({ hasUI: false, projectTrusted: true });
		await assert.rejects(call(noUi, target), /trust/i);
		assert.deepEqual(noUi.sendCalls, []);
		assert.deepEqual(noUi.tmux.opened, []);
	});
	await t.test("a malformed store refuses", async () => {
		writeFileSync(join(agentDir, "trust.json"), "{ not json");
		const badStore = await started({ ui: { select: ["Trust"] } });
		await assert.rejects(call(badStore, target), /trust/i);
		assert.deepEqual(badStore.sendCalls, []);
		assert.deepEqual(badStore.tmux.opened, []);
		assert.equal(badStore.selects.length, 0);
		assert.equal(readFileSync(join(agentDir, "trust.json"), "utf8"), "{ not json");
	});
	await t.test("a store that cannot be written refuses", async (tt) => {
		if (process.getuid?.() === 0) return tt.skip("a privileged user writes a read-only file");
		const trustPath = join(agentDir, "trust.json");
		writeFileSync(trustPath, "{}\n");
		chmodSync(trustPath, 0o444);
		try {
			const badStore = await started({ ui: { select: ["Trust"] } });
			await assert.rejects(call(badStore, target), /trust/i);
			assert.deepEqual(badStore.sendCalls, []);
			assert.deepEqual(badStore.tmux.opened, []);
		} finally {
			chmodSync(trustPath, 0o644);
		}
	});
	for (const ending of ["answer", "cancel", "error"] as const) {
		await t.test(`dialogs are serialized and released after an ${ending}`, async () => {
			let settle: (value: string | undefined) => void = () => {};
			let fail: (err: Error) => void = () => {};
			const first = new Promise<string | undefined>((resolve, reject) => {
				settle = resolve;
				fail = reject;
			});
			const s = await started({ ui: { select: [first, "Do not trust"] } });
			const firstCall = call(s, target);
			const secondCall = call(s, second);
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.equal(s.selects.length, 1);
			if (ending === "answer") settle("Trust");
			else if (ending === "cancel") settle(undefined);
			else fail(new Error("dialog broke"));
			if (ending === "answer") await firstCall;
			else await assert.rejects(firstCall);
			await secondCall;
			const store = new ProjectTrustStore(agentDir);
			assert.equal(store.get(target), ending === "answer" ? true : null);
			assert.equal(store.get(second), false);
			assert.equal(s.selects.length, 2);
			assert.ok(s.selects[1].title.includes(second), s.selects[1].title);
		});
	}
	await t.test("a queued question rereads the answer saved before it", async () => {
		let settle: (value: string | undefined) => void = () => {};
		const first = new Promise<string | undefined>((resolve) => {
			settle = resolve;
		});
		const s = await started({ ui: { select: [first, "Do not trust"] } });
		const calls = [call(s, target), call(s, target)];
		await new Promise((resolve) => setTimeout(resolve, 20));
		settle("Trust");
		await Promise.all(calls);
		assert.equal(s.selects.length, 1);
		assert.deepEqual(
			s.tmux.opened.map((item) => flags(item.argv)),
			[["--approve"], ["--approve"]],
		);
	});
});

// ---------------------------------------------------------------------------
// Reporting and the child's context

test("selected-directory facts reach the child prompt, results, status and resume", async () => {
	base = fresh();
	// A delegate not told where it was placed, or reports that disagree about the workspace, is what this catches.
	const main = repo(join(base, "repo"));
	const inside = join(main, ".git", "info");
	const s = await started();
	await call(s, main);
	await call(s, inside);
	await s.delegate("scout inherited");
	const records = s.entries.filter((item) => typeof item.data.windowId === "string").map((item) => item.data as Data);
	const prompt = (index: number) => {
		const argv = s.tmux.opened[index].argv;
		return readFileSync(argv[argv.indexOf("--append-system-prompt") + 1], "utf8");
	};
	assert.ok(prompt(0).includes(main), "the selected directory is named in the child's prompt");
	assert.ok(!prompt(2).includes(base), "an inherited launch does not repeat its cwd");
	assert.equal(records[1].workspace.git.kind, "unknown", "inspection inside Git metadata is unknown, not non-Git");
	assert.equal(typeof records[1].workspace.git.reason, "string");

	const status = await s.toolCall("delegation_status", {});
	const text = status.content[0].text;
	assert.ok(text.includes(`workspace: existing directory; Git checkout ${main}`), text);
	assert.match(text, /Git state unknown/);
	const items = (status.structuredContent as Data).delegations;
	assert.deepEqual(
		items.map((item: Data) => item.workspace),
		records.map((record) => record.workspace),
	);

	const record = records[0];
	s.events.emit("message:inbound", {
		envelope: {
			id: "reply",
			from: record.id,
			to: s.parent,
			in_reply_to: [record.requestId],
			status: "done",
			ts: "2026-09-29T00:00:00.000Z",
			body: "The answer.",
		},
		path: join(agentDir, "mailbox", s.parent, "cur", "000000000000002-reply.json"),
		requests: [],
		handled: false,
	});
	const message = s.sent[0].message as unknown as { content: string; details: Data };
	assert.deepEqual(message.details.workspace, record.workspace);
	assert.ok(message.content.includes(`Workspace: existing directory; Git checkout ${main}`), message.content);

	const resumed = session({ cwd: base, entries: s.entries });
	await resumed.start();
	const again = await resumed.toolCall("delegation_status", { id: record.id });
	assert.deepEqual((again.structuredContent as Data).delegations[0].workspace, record.workspace);
});
