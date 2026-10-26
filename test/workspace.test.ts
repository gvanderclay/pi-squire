// `cwd` launches a delegate in an existing directory: both entry points
// resolve it to a real directory, keep the task bytes, leave existing
// checkouts untouched, and decide project trust in the parent. These tests
// drive the extension through its registration function, with the fake tmux,
// the scripted UI, Pi's real trust store under the harness agent directory
// and real temporary Git repositories.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { devNull } from "node:os";
import { join, resolve } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";

import {
	hasTrustRequiringProjectResources,
	initTheme,
	ProjectTrustStore,
	type Theme,
} from "@earendil-works/pi-coding-agent";

import { inspectGit } from "../src/git.ts";
import { renderMessage } from "../src/render.ts";
import { trustPlannedWorktree, type WorktreePlan } from "../src/workspace.ts";

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
	await t.test("workspace flags are offered in completions", async () => {
		const s = await started();
		assert.ok((await s.completions("scout --c"))?.some((item) => item.label === "--cwd"));
		assert.ok((await s.completions("scout --w"))?.some((item) => item.label === "--worktree"));
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

test("a main checkout with a separate Git directory keeps its own trust key", async (t) => {
	// Treating the administrative directory as the main root would let a saved true there override the checkout's denial.
	base = fresh();
	const admin = join(base, "admin.git");
	const checkout = join(base, "checkout");
	mkdirSync(checkout);
	git(checkout, "init", "-q", "-b", "main", "--separate-git-dir", admin);
	writeFileSync(join(checkout, "f.txt"), "x\n");
	git(checkout, "add", ".");
	git(checkout, "commit", "-q", "-m", "first");
	const real = realpathSync(checkout);
	protect(real);
	await t.test("a saved denial at the checkout wins over an approval at its Git directory", async () => {
		const store = new ProjectTrustStore(agentDir);
		store.setMany([
			{ path: real, decision: false },
			{ path: realpathSync(admin), decision: true },
		]);
		const s = await started();
		await call(s, real);
		assert.deepEqual(flags(s.tmux.opened[0].argv), ["--no-approve"]);
		assert.equal(s.selects.length, 0);
		assert.deepEqual(startRecord(s)?.workspace.git.identity, {
			mainRoot: real,
			commonDir: realpathSync(admin),
			checkoutRoot: real,
		});
	});
	await t.test("its linked worktree is unknown rather than keyed by the Git directory", async () => {
		const linked = join(base, "linked");
		git(real, "worktree", "add", "-q", "-b", "topic", linked);
		protect(linked);
		const store = new ProjectTrustStore(agentDir);
		store.setMany([
			{ path: realpathSync(linked), decision: false },
			{ path: realpathSync(admin), decision: true },
		]);
		const s = await started();
		await call(s, linked);
		assert.deepEqual(flags(s.tmux.opened[0].argv), ["--no-approve"]);
		assert.equal(startRecord(s)?.workspace.git.kind, "unknown");
	});
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
	await t.test("an aborted queued launch starts nothing when another answer settles its target", async () => {
		// A queued call skipping the dialog because an answer arrived would otherwise launch after its abort.
		let settle: (value: string | undefined) => void = () => {};
		const first = new Promise<string | undefined>((resolve) => {
			settle = resolve;
		});
		const s = await started({ ui: { select: [first] } });
		const firstCall = call(s, target);
		const controller = new AbortController();
		const secondCall = s.toolCall("delegate", { agent: "scout", task: "inspect", cwd: target }, controller.signal);
		await new Promise((resolve) => setTimeout(resolve, 20));
		controller.abort();
		// It is released at once, not after the open question is answered.
		const stillWaiting = new Promise((_, reject) => setTimeout(() => reject(new Error("still queued")), 500));
		await assert.rejects(Promise.race([secondCall, stillWaiting]), /abort/i);
		settle("Trust");
		await secondCall.catch(() => undefined);
		await firstCall;
		assert.equal(s.sendCalls.length, 1);
		assert.equal(s.tmux.opened.length, 1);
		assert.equal(s.selects.length, 1);
	});
	await t.test("an answer that arrives after the abort saves and starts nothing", async () => {
		// A dialog that still returns an answer after the operation was aborted must not persist it or launch.
		let settle: (value: string | undefined) => void = () => {};
		const answer = new Promise<string | undefined>((resolve) => {
			settle = resolve;
		});
		const s = await started({ ui: { select: [answer] } });
		const controller = new AbortController();
		const launching = s.toolCall("delegate", { agent: "scout", task: "inspect", cwd: target }, controller.signal);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(s.selects.length, 1);
		controller.abort();
		settle("Trust");
		await assert.rejects(launching, /abort/i);
		assert.deepEqual(s.sendCalls, []);
		assert.deepEqual(s.tmux.opened, []);
		assert.equal(new ProjectTrustStore(agentDir).get(target), null);
	});
	await t.test("an aborted launch asks nothing and starts nothing", async () => {
		const controller = new AbortController();
		controller.abort();
		const s = await started({ ui: { select: ["Trust"] } });
		await assert.rejects(
			s.toolCall("delegate", { agent: "scout", task: "inspect", cwd: target }, controller.signal),
			/abort/i,
		);
		assert.equal(s.selects.length, 0);
		assert.deepEqual(s.sendCalls, []);
		assert.deepEqual(s.tmux.opened, []);
		assert.equal(new ProjectTrustStore(agentDir).get(target), null);
	});
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

// ---------------------------------------------------------------------------
// Workspace snapshots: the checkout when a result arrives, and fresh on each status

const records = (s: ReturnType<typeof session>): Data[] =>
	s.entries.filter((item) => typeof item.data.windowId === "string").map((item) => item.data as Data);
const statusOf = async (s: ReturnType<typeof session>) => {
	const result = await s.toolCall("delegation_status", {});
	return { text: result.content[0].text, items: (result.structuredContent as Data).delegations as Data[] };
};
const itemFor = (items: Data[], record: Data): Data => {
	const found = items.find((item) => item.id === record.id);
	assert.ok(found, `status lists ${record.id}`);
	return found;
};
const delegateMessages = (s: ReturnType<typeof session>) => s.sent.filter((x) => x.message.customType === "delegate");

/** A reply to `record`'s task, shaped like the provider's `message:inbound` payload (`test/delegate.test.ts`). */
function replyTo(s: ReturnType<typeof session>, record: Data, replyId = "reply"): Data {
	return {
		envelope: {
			id: replyId,
			from: record.id,
			to: s.parent,
			in_reply_to: [record.requestId],
			status: "done",
			ts: "2026-09-29T00:00:00.000Z",
			body: "The answer.",
		},
		path: join(agentDir, "mailbox", s.parent, "cur", `000000000000002-${replyId}.json`),
		requests: [
			{
				envelope: {
					id: record.requestId,
					from: s.parent,
					to: record.id,
					in_reply_to: [],
					status: "",
					ts: "2026-09-29T00:00:00.000Z",
					body: "inspect",
				},
				path: join(agentDir, "mailbox", s.parent, "sent", `000000000000001-${record.requestId}.json`),
			},
		],
		handled: false,
	};
}

const realGit = execFileSync("sh", ["-c", "command -v git"]).toString().trim();

/**
 * Put a scripted `git` first on PATH: in `checkout` (by its real path) it runs
 * `action` for the subcommands in `only` (every one when empty), and anywhere
 * else it is the real Git. `afterEach` restores PATH.
 */
function scriptGit(checkout: string, action: string, only: string[] = []): void {
	const bin = mkdtempSync(join(base, "bin-"));
	const match = only.length === 0 ? "true" : only.map((sub) => `[ "$1" = ${JSON.stringify(sub)} ]`).join(" || ");
	writeFileSync(
		join(bin, "git"),
		`#!/bin/sh\nif [ "$(pwd -P)" = ${JSON.stringify(checkout)} ] && { ${match}; }; then\n${action}\nfi\nexec ${JSON.stringify(realGit)} "$@"\n`,
	);
	chmodSync(join(bin, "git"), 0o755);
	process.env.PATH = `${bin}:${savedEnv.PATH}`;
}

const theme = {
	fg: (_token: string, text: string) => text,
	bg: (_token: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

/** The expanded view of a delegate message, as plain text. */
function expandedView(message: unknown): string {
	initTheme("dark");
	const view = renderMessage(
		{ role: "custom", timestamp: 0, ...(message as object) } as Parameters<typeof renderMessage>[0],
		{ expanded: true, outputPad: 1 },
		theme,
	);
	// biome-ignore lint/suspicious/noControlCharactersInRegex: strips the real theme's ANSI from the expand hint
	return (view?.render(2000) ?? []).map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
}

test("status separates clean committed changes from pending conflicts", async () => {
	base = fresh();
	// A clean checkout with new commits read as unchanged, a conflict read as clean, or a status that rewrites the index.
	const cleanMain = repo(join(base, "clean"));
	const dirty = repo(join(base, "dirty"));
	writeFileSync(join(dirty, "conflict.txt"), "base\n");
	writeFileSync(join(dirty, "unstaged.txt"), "base\n");
	git(dirty, "add", ".");
	git(dirty, "commit", "-q", "-m", "fixtures");
	git(dirty, "switch", "-q", "-c", "other");
	writeFileSync(join(dirty, "conflict.txt"), "other\n");
	git(dirty, "commit", "-q", "-a", "-m", "other side");
	git(dirty, "switch", "-q", "main");
	const detached = join(base, "detached");
	git(cleanMain, "worktree", "add", "-q", "--detach", detached);
	const s = await started();
	await call(s, cleanMain);
	await call(s, dirty);
	await call(s, detached);
	const [cleanRecord, launchRecord, detachedRecord] = records(s);
	const baseline = launchRecord.workspace.git.baseline;

	// After launch: one clean new commit in one checkout; committed, staged, unstaged, untracked and conflicted work in another.
	writeFileSync(join(cleanMain, "committed.txt"), "new\n");
	git(cleanMain, "add", "committed.txt");
	git(cleanMain, "commit", "-q", "-m", "clean commit");
	const committedHead = git(cleanMain, "rev-parse", "HEAD");
	writeFileSync(join(dirty, "committed.txt"), "new\n");
	git(dirty, "add", "committed.txt");
	git(dirty, "commit", "-q", "-m", "committed");
	writeFileSync(join(dirty, "conflict.txt"), "main\n");
	git(dirty, "commit", "-q", "-a", "-m", "main side");
	assert.throws(() => git(dirty, "merge", "-q", "other"), "the merge stops on a conflict");
	writeFileSync(join(dirty, "staged.txt"), "staged\n");
	git(dirty, "add", "staged.txt");
	writeFileSync(join(dirty, "unstaged.txt"), "changed\n");
	writeFileSync(join(dirty, "untracked.txt"), "new\n");
	// Same content, new stat: a status allowed to refresh the index would rewrite it here.
	const later = new Date(Date.now() + 60_000);
	utimesSync(join(dirty, "sentinel.txt"), later, later);
	const indexPath = join(dirty, ".git", "index");
	const indexBeforeInspection = readFileSync(indexPath);

	const { text, items } = await statusOf(s);
	const cleanSnap = itemFor(items, cleanRecord).workspaceSnapshot;
	const snap = itemFor(items, launchRecord).workspaceSnapshot;
	const detachedSnap = itemFor(items, detachedRecord).workspaceSnapshot;
	assert.equal(cleanSnap.kind, "git");
	assert.equal(cleanSnap.workingState, "clean");
	assert.equal(cleanSnap.baseline, cleanRecord.workspace.git.baseline);
	assert.equal(cleanSnap.head, committedHead);
	assert.equal(cleanSnap.ahead, 1);
	assert.deepEqual(cleanSnap.committed.paths, ["committed.txt"]);
	assert.deepEqual(cleanSnap.pending.untracked.paths, []);
	assert.deepEqual(cleanSnap.position, { branch: "main", detached: false });
	assert.equal(snap.kind, "git");
	assert.equal(snap.baseline, baseline);
	assert.equal(snap.ahead, 2);
	assert.equal(snap.workingState, "dirty");
	assert.deepEqual([...snap.committed.paths].sort(), ["committed.txt", "conflict.txt"]);
	assert.ok(snap.pending.staged.paths.includes("staged.txt"));
	assert.ok(snap.pending.unstaged.paths.includes("unstaged.txt"));
	assert.ok(snap.pending.untracked.paths.includes("untracked.txt"));
	assert.ok(snap.pending.conflicted.paths.includes("conflict.txt"));
	assert.equal(snap.pending.staged.paths.includes("conflict.txt"), false, "a conflict is not also staged");
	assert.deepEqual(readFileSync(indexPath), indexBeforeInspection);
	assert.equal(detachedSnap.kind, "git");
	assert.deepEqual(detachedSnap.position, { branch: null, detached: true });
	assert.equal(detachedSnap.ahead, 0);
	assert.equal(detachedSnap.workingState, "clean");
	// The launch facts stay as recorded beside the fresh observation.
	assert.deepEqual(itemFor(items, launchRecord).workspace, launchRecord.workspace);
	assert.ok(text.includes('"conflict.txt"'), text);
	assert.ok(text.includes('"untracked.txt"'), text);
});

test("completion snapshot stays historical while fresh status changes", async () => {
	base = fresh();
	// A status that rewrites the recorded result, or a result whose message and record disagree.
	const main = repo(join(base, "main"));
	const s = await started();
	await call(s, main);
	const [launchRecord] = records(s);
	writeFileSync(join(main, "first.txt"), "before the result\n");
	const payload = replyTo(s, launchRecord);
	s.events.emit("message:inbound", payload);
	assert.equal(payload.handled, true);
	const recordedResult = s.entries.find((item) => item.data.result !== undefined)?.data.result as Data;
	assert.ok(recordedResult);
	const resultMessage = s.sent[0].message as unknown as { content: string; details: Data };
	const historical = structuredClone(recordedResult.workspaceSnapshot);
	assert.equal(historical.kind, "git");
	assert.ok(historical.pending.untracked.paths.includes("first.txt"));

	writeFileSync(join(main, "late.txt"), "after the result\n");
	const { text, items } = await statusOf(s);
	const freshSnapshot = itemFor(items, launchRecord).workspaceSnapshot;
	assert.deepEqual(resultMessage.details.workspaceSnapshot, historical);
	assert.deepEqual(recordedResult.workspaceSnapshot, historical);
	assert.ok(freshSnapshot.pending.untracked.paths.includes("late.txt"));
	assert.equal(historical.pending.untracked.paths.includes("late.txt"), false);

	// Text and the expanded view carry the same observation as the details, beside the recorded cwd.
	assert.ok(resultMessage.content.includes('"first.txt"'), resultMessage.content);
	assert.equal(resultMessage.content.includes("late.txt"), false);
	assert.ok(resultMessage.content.includes(historical.head), resultMessage.content);
	assert.ok(text.includes('"late.txt"'), text);
	const expanded = expandedView(resultMessage);
	assert.ok(expanded.includes('"first.txt"'), expanded);
	assert.ok(expanded.includes(`cwd ${main}`), expanded);
	assert.ok(expanded.includes(historical.head), expanded);

	// A resume keeps the recorded snapshot and still observes afresh.
	const resumed = session({ cwd: base, entries: structuredClone(s.entries) });
	await resumed.start();
	const again = await statusOf(resumed);
	assert.ok(itemFor(again.items, launchRecord).workspaceSnapshot.pending.untracked.paths.includes("late.txt"));
	const restoredResult = resumed.entries.find((item) => item.data.result !== undefined)?.data.result as Data;
	assert.deepEqual(restoredResult.workspaceSnapshot, historical);

	// Records and results from before workspaces were kept restore, and report unknown rather than the parent's checkout.
	const legacy = structuredClone(s.entries);
	for (const entry of legacy) {
		delete entry.data.workspace;
		delete (entry.data.result as Data | undefined)?.workspaceSnapshot;
	}
	const old = session({ cwd: main, entries: legacy });
	await old.start();
	const legacyItem = itemFor((await statusOf(old)).items, launchRecord);
	assert.equal(legacyItem.state, "done");
	assert.equal(legacyItem.workspaceSnapshot.kind, "unknown");
	assert.ok(legacyItem.workspaceSnapshot.reason.length > 0);
	const { workspaceSnapshot: _dropped, ...legacyDetails } = resultMessage.details;
	assert.equal(expandedView({ ...resultMessage, details: legacyDetails }).includes('"first.txt"'), false);
});

test("inspection failure cannot lose duplicate or late replies or other status", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	base = fresh();
	// A Git failure that swallows a reply, lets the provider inject it again, or fails every delegation's status.
	const healthy = repo(join(base, "healthy"));
	const bad = repo(join(base, "bad"));
	const late = repo(join(base, "late"));
	const replacedRoot = repo(join(base, "replaced"));
	const replaced = join(replacedRoot, "sub");
	mkdirSync(replaced);
	const plain = join(base, "plain");
	mkdirSync(plain);
	const plainGone = join(base, "plain gone");
	mkdirSync(plainGone);
	const s = await started();
	let providerFallbackCount = 0;
	s.events.on("message:inbound", (data) => {
		if ((data as Data).handled !== true) providerFallbackCount++;
	});
	for (const dir of [healthy, bad, plain, late, replaced, plainGone]) await call(s, dir);
	const [healthyRecord, badRecord, nonGitRecord, lateRecord, replacedRecord, plainGoneRecord] = records(s);
	rmSync(plainGone, { recursive: true, force: true });
	// The launch subdirectory now holds its own clone: the launch commit exists, but the checkout root moved.
	rmSync(replaced, { recursive: true, force: true });
	git(base, "clone", "-q", replacedRoot, replaced);

	rmSync(bad, { recursive: true, force: true });
	const payload = replyTo(s, badRecord);
	s.events.emit("message:inbound", payload);
	assert.equal(payload.handled, true);
	const duplicatePayload = replyTo(s, badRecord);
	s.events.emit("message:inbound", duplicatePayload);
	assert.equal(duplicatePayload.handled, true);
	assert.equal(delegateMessages(s).length, 1);
	const resultMessage = delegateMessages(s)[0].message as unknown as { content: string; details: Data };
	assert.equal(resultMessage.details.workspaceSnapshot.kind, "unknown");
	assert.ok(resultMessage.details.workspaceSnapshot.reason.length > 0);

	// The late delegation's window goes, the poll records it gone, then its reply arrives while Git hangs there.
	s.tmux.windows.delete(lateRecord.windowId);
	t.mock.timers.tick(5000);
	for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
	assert.equal(s.sent.filter((x) => /closed without a result/.test(String(x.message.content))).length, 1);
	// It ignores SIGTERM, so only a kill that cannot be refused ends it within the limit.
	scriptGit(late, "trap '' TERM; exec sleep 10", ["status"]);
	const lateReply = replyTo(s, lateRecord, "late-reply");
	const before = Date.now();
	s.events.emit("message:inbound", lateReply);
	assert.ok(
		Date.now() - before < 4500,
		`a hung Git command is cut off at its 2 s limit, took ${Date.now() - before} ms`,
	);
	assert.equal(lateReply.handled, true);
	const lateMessage = delegateMessages(s).at(-1)?.message as unknown as { content: string; details: Data };
	assert.match(lateMessage.content, /^\[delegate\] Result from/);
	assert.equal(lateMessage.details.workspaceSnapshot.kind, "unknown");
	assert.match(lateMessage.details.workspaceSnapshot.reason, /time|limit/i);

	const { items } = await statusOf(s);
	const badItem = itemFor(items, badRecord);
	const healthyItem = itemFor(items, healthyRecord);
	const nonGitItem = itemFor(items, nonGitRecord);
	const lateItem = itemFor(items, lateRecord);
	assert.equal(badItem.workspaceSnapshot.kind, "unknown");
	assert.equal(healthyItem.workspaceSnapshot.kind, "git");
	assert.equal(nonGitItem.workspaceSnapshot.kind, "non-git");
	assert.equal(lateItem.state, "done");
	assert.equal(itemFor(items, replacedRecord).workspaceSnapshot.kind, "unknown");
	assert.equal(itemFor(items, plainGoneRecord).workspaceSnapshot.kind, "unknown", "a deleted directory is not non-Git");
	assert.equal(providerFallbackCount, 0);

	// A checkout whose launch Git state was unknown stays unknown, never the parent's checkout.
	process.env.PATH = savedEnv.PATH;
	const parentRepo = repo(join(base, "parent"));
	const emptyBin = join(base, "empty-bin");
	mkdirSync(emptyBin);
	process.env.PATH = emptyBin;
	const noGit = await started({ cwd: parentRepo });
	await noGit.delegate("scout inspect");
	process.env.PATH = savedEnv.PATH;
	const [noGitRecord] = records(noGit);
	assert.equal(noGitRecord.workspace.git.kind, "unknown");
	const noGitItem = itemFor((await statusOf(noGit)).items, noGitRecord);
	assert.equal(noGitItem.workspaceSnapshot.kind, "unknown");
});

test("Git paths remain filename safe bounded and index read only", async () => {
	base = fresh();
	// Paths split on spaces or newlines, an unbounded list, a rewritten index, or a hung or flooding Git.
	const main = repo(join(base, "main"));
	writeFileSync(join(main, "old name.txt"), "rename me\n");
	git(main, "add", ".");
	git(main, "commit", "-q", "-m", "to rename");
	const many = repo(join(base, "many"));
	const wide = repo(join(base, "wide"));
	const timedOut = repo(join(base, "timed out"));
	const flooded = repo(join(base, "flooded"));
	const slow = repo(join(base, "slow"));
	const noisy = repo(join(base, "noisy"));
	const s = await started();
	for (const dir of [main, many, wide, timedOut, flooded, slow, noisy]) await call(s, dir);
	const [mainRecord, manyRecord, wideRecord, timedOutRecord, floodedRecord, slowRecord, noisyRecord] = records(s);

	git(main, "mv", "old name.txt", "renamed\nfile.txt");
	git(main, "commit", "-q", "-m", "renamed");
	writeFileSync(join(main, "space name.txt"), "x\n");
	writeFileSync(join(main, "雪\nline.txt"), "x\n");
	for (let i = 0; i < 101; i++) writeFileSync(join(many, `file-${i}.txt`), "x\n");
	// 101 names of 200 bytes: the 16 KiB byte cap applies before the 100-path cap.
	for (let i = 0; i < 101; i++) writeFileSync(join(wide, `${String(i).padStart(3, "0")}${"w".repeat(193)}.txt`), "x\n");
	const later = new Date(Date.now() + 60_000);
	utimesSync(join(main, "sentinel.txt"), later, later);
	const indexPath = join(main, ".git", "index");
	const indexBeforeInspection = readFileSync(indexPath);
	scriptGit(timedOut, "trap '' TERM; exec sleep 10", ["status"]);
	const hungStart = Date.now();
	const { items: hungItems } = await statusOf(s);
	const hungTook = Date.now() - hungStart;
	// 600,000 bytes of stderr before every command: no single stream is over 4 MiB, but together they are.
	scriptGit(noisy, "head -c 600000 /dev/zero >&2");
	const { items: noisyItems } = await statusOf(s);
	scriptGit(flooded, "exec head -c 5000000 /dev/zero", ["status"]);
	const { items: floodedItems } = await statusOf(s);
	scriptGit(slow, "sleep 1.5");
	const slowStart = Date.now();
	const { items } = await statusOf(s);
	const slowTook = Date.now() - slowStart;

	const snap = itemFor(items, mainRecord).workspaceSnapshot;
	const renameSnap = snap;
	const manySnap = itemFor(items, manyRecord).workspaceSnapshot;
	const wideSnap = itemFor(items, wideRecord).workspaceSnapshot;
	assert.equal(snap.kind, "git");
	assert.ok(snap.pending.untracked.paths.includes("space name.txt"));
	assert.ok(snap.pending.untracked.paths.includes("雪\nline.txt"));
	assert.ok(renameSnap.committed.paths.includes("renamed\nfile.txt"));
	assert.ok(renameSnap.committed.paths.includes("old name.txt"));
	assert.equal(manySnap.pending.untracked.total, 101);
	assert.equal(manySnap.pending.untracked.truncated, true);
	assert.equal(manySnap.pending.untracked.paths.length, 100);
	assert.ok(manySnap.pending.untracked.paths.length <= 100);
	assert.equal(wideSnap.pending.untracked.total, 101);
	assert.equal(wideSnap.pending.untracked.truncated, true);
	assert.ok(wideSnap.pending.untracked.paths.length < 100);
	assert.ok(Buffer.byteLength(wideSnap.pending.untracked.paths.join(""), "utf8") <= 16 * 1024);
	assert.ok(Buffer.byteLength(manySnap.pending.untracked.paths.join(""), "utf8") <= 16 * 1024);
	assert.deepEqual(readFileSync(indexPath), indexBeforeInspection);
	const timedOutItem = itemFor(hungItems, timedOutRecord);
	assert.equal(timedOutItem.workspaceSnapshot.kind, "unknown");
	assert.match(timedOutItem.workspaceSnapshot.reason, /time|bound|limit/i);
	assert.ok(hungTook < 4500, `a Git that ignores SIGTERM is still stopped at 2 s, took ${hungTook} ms`);
	const noisyItem = itemFor(noisyItems, noisyRecord);
	assert.equal(noisyItem.workspaceSnapshot.kind, "unknown", "stderr counts toward the 4 MiB capture limit");
	assert.match(noisyItem.workspaceSnapshot.reason, /limit/i);
	assert.equal(itemFor(hungItems, mainRecord).workspaceSnapshot.kind, "git", "one hung checkout fails only itself");
	const floodedItem = itemFor(floodedItems, floodedRecord);
	assert.equal(floodedItem.workspaceSnapshot.kind, "unknown");
	assert.match(floodedItem.workspaceSnapshot.reason, /limit/i);
	const slowItem = itemFor(items, slowRecord);
	assert.equal(slowItem.workspaceSnapshot.kind, "unknown");
	assert.match(slowItem.workspaceSnapshot.reason, /time|limit/i);
	assert.ok(slowTook < 8000, `the whole inspection of one checkout is bounded, took ${slowTook} ms`);
});

test("committed paths ignore diff.relative and stay repository-relative from a subdirectory", async () => {
	base = fresh();
	// A user's diff.relative hiding commits outside the launch subdirectory, or rooting paths unlike status.
	const main = repo(join(base, "main"));
	const sub = join(main, "sub");
	mkdirSync(sub);
	const s = await started();
	await call(s, sub);
	const [record] = records(s);
	writeFileSync(join(main, "outside.txt"), "x\n");
	writeFileSync(join(sub, "inside.txt"), "x\n");
	git(main, "add", ".");
	git(main, "commit", "-q", "-m", "both");
	git(main, "config", "diff.relative", "true");
	writeFileSync(join(main, "pending-outside.txt"), "x\n");
	const snap = itemFor((await statusOf(s)).items, record).workspaceSnapshot;
	assert.equal(snap.kind, "git");
	assert.deepEqual([...snap.committed.paths].sort(), ["outside.txt", "sub/inside.txt"]);
	assert.equal(snap.committed.total, 2);
	assert.ok(snap.pending.untracked.paths.includes("pending-outside.txt"));
});

test("a repository replaced at the same location is observed against the recorded baseline", async () => {
	base = fresh();
	// A same-path clone reported as unknown, or compared with anything but the recorded launch commit.
	const main = repo(join(base, "main"));
	const s = await started();
	await call(s, main);
	const [record] = records(s);
	renameSync(main, join(base, "moved away"));
	git(base, "clone", "-q", join(base, "moved away"), main);
	writeFileSync(join(main, "after replacement.txt"), "x\n");
	git(main, "add", ".");
	git(main, "commit", "-q", "-m", "after replacement");
	const snap = itemFor((await statusOf(s)).items, record).workspaceSnapshot;
	assert.equal(snap.kind, "git");
	assert.equal(snap.baseline, record.workspace.git.baseline);
	assert.equal(snap.head, git(main, "rev-parse", "HEAD"));
	assert.equal(snap.ahead, 1);
	assert.deepEqual(snap.committed.paths, ["after replacement.txt"]);
	assert.equal(snap.workingState, "clean");
});

test("same-repository trust change while queued refuses before second mail or creation", async () => {
	base = fresh();
	const options = { cwd: repo(join(base, "main")), projectTrusted: true };
	const s = await started(options);
	let entered!: () => void;
	let release!: () => void;
	const atOpen = new Promise<void>((resolve) => (entered = resolve));
	const gate = new Promise<void>((resolve) => (release = resolve));
	const open = s.tmux.openWindow.bind(s.tmux);
	let first = true;
	s.tmux.openWindow = async (spec, placement) => {
		if (first) {
			first = false;
			entered();
			await gate;
		}
		return open(spec, placement);
	};
	const params = (branch: string) => ({ agent: "scout", task: "inspect", worktree: branch });
	const firstLaunch = s.toolCall("delegate", params("queue/first"));
	await atOpen;
	const secondLaunch = s.toolCall("delegate", params("queue/second"));
	await new Promise((resolve) => setImmediate(resolve));
	s.context.isProjectTrusted = () => false;
	release();
	const [firstResult, secondResult] = await Promise.allSettled([firstLaunch, secondLaunch]);
	assert.equal(firstResult.status, "fulfilled", "the in-flight first launch remains valid");
	assert.equal(secondResult.status, "rejected", "the changed queued preflight refuses");
	assert.equal(s.sendCalls.length, 1, "the refused queued attempt sends no task");
	assert.equal(s.tmux.opened.length, 1, "the refused queued attempt creates no window");
	assert.equal(git(options.cwd, "worktree", "list", "--porcelain").includes("queue/second"), false);
});

test("a saved unrelated-source denial appearing while queued refuses before mail", async () => {
	base = fresh();
	const parent = repo(join(base, "parent"));
	const source = repo(join(base, "source"));
	const store = new ProjectTrustStore(agentDir);
	store.set(source, true);
	const s = await started({ cwd: parent, projectTrusted: true });
	let entered!: () => void;
	let release!: () => void;
	const atOpen = new Promise<void>((resolve) => (entered = resolve));
	const gate = new Promise<void>((resolve) => (release = resolve));
	const open = s.tmux.openWindow.bind(s.tmux);
	let first = true;
	s.tmux.openWindow = async (spec, placement) => {
		if (first) {
			first = false;
			entered();
			await gate;
		}
		return open(spec, placement);
	};
	const params = (branch: string) => ({ agent: "scout", task: "inspect", worktree: branch, worktree_source: source });
	const firstLaunch = s.toolCall("delegate", params("saved/first"));
	await atOpen;
	const secondLaunch = s.toolCall("delegate", params("saved/second"));
	await new Promise((resolve) => setImmediate(resolve));
	store.set(source, false);
	release();
	const [firstResult, secondResult] = await Promise.allSettled([firstLaunch, secondLaunch]);
	assert.equal(firstResult.status, "fulfilled");
	assert.equal(secondResult.status, "rejected");
	assert.equal(s.sendCalls.length, 1);
	assert.equal(s.tmux.opened.length, 1);
});

test("parent-context abort during managed trust selection cannot save or launch after Trust", async () => {
	base = fresh();
	const parent = repo(join(base, "parent"));
	const source = repo(join(base, "source"));
	protect(source);
	git(source, "add", ".");
	git(source, "commit", "-q", "-m", "protected base");
	let answer!: (value: string) => void;
	const selection = new Promise<string>((resolve) => (answer = resolve));
	const s = await started({ cwd: parent, ui: { select: [selection] } });
	const controller = new AbortController();
	Object.defineProperty(s.context, "signal", { get: () => controller.signal });
	const launch = s.toolCall("delegate", {
		agent: "scout",
		task: "inspect",
		worktree: "cancel/topic",
		worktree_source: source,
	});
	for (let i = 0; i < 20 && s.selects.length === 0; i++) await new Promise((resolve) => setImmediate(resolve));
	assert.equal(s.selects.length, 1);
	controller.abort();
	answer("Trust");
	await assert.rejects(launch, /abort|cancel/i);
	assert.equal(new ProjectTrustStore(agentDir).get(source), null);
	assert.equal(s.sendCalls.length, 0);
	assert.equal(s.tmux.opened.length, 0);
	assert.equal(git(source, "worktree", "list", "--porcelain").includes("cancel/topic"), false);
});

test("planned trust follows Pi's cwd resource rules for symlinked, global, and ancestor resources", async () => {
	base = fresh();
	const parent = repo(join(base, "parent"));
	const source = repo(join(base, "source"));
	const identity = inspectGit(source);
	assert.equal(identity.kind, "git");
	if (identity.kind !== "git") throw new Error("fixture must be a Git repository");
	const s = await started({ cwd: parent, hasUI: false });
	const plan = (destination: string): WorktreePlan => ({
		sourceCwd: source,
		source: identity.identity,
		destination,
		branch: "planned/topic",
		requestedBase: "HEAD",
		baseCommit: git(source, "rev-parse", "HEAD"),
		sourceDirty: { paths: [], total: 0, truncated: false },
		trusted: false,
	});
	const externalSkills = join(base, "outside skills");
	mkdirSync(externalSkills);
	writeFileSync(join(externalSkills, "AGENTS.md"), "external skill\n");
	const linkedParent = join(base, "linked-project");
	mkdirSync(join(linkedParent, ".agents"), { recursive: true });
	symlinkSync(externalSkills, join(linkedParent, ".agents", "skills"));
	await assert.rejects(
		trustPlannedWorktree(plan(join(linkedParent, "managed")), s.context as never, agentDir),
		/exposes project resources/,
	);
	const globalProject = home;
	rmSync(join(home, ".pi"), { recursive: true, force: true });
	mkdirSync(join(home, ".agents", "skills"), { recursive: true });
	assert.equal(hasTrustRequiringProjectResources(globalProject), false, "global skills are excluded by Pi");
	await assert.doesNotReject(trustPlannedWorktree(plan(globalProject), s.context as never, agentDir));
	const piOnly = join(base, "pi-only");
	mkdirSync(join(piOnly, ".pi"), { recursive: true });
	writeFileSync(join(piOnly, ".pi", "settings.json"), "{}\n");
	await assert.doesNotReject(trustPlannedWorktree(plan(join(piOnly, "managed")), s.context as never, agentDir));

	const protectedSource = repo(join(base, "protected-source"));
	protect(protectedSource);
	git(protectedSource, "add", ".");
	git(protectedSource, "commit", "-q", "-m", "protected");
	const protectedIdentity = inspectGit(protectedSource);
	assert.equal(protectedIdentity.kind, "git");
	if (protectedIdentity.kind !== "git") throw new Error("fixture must be a Git repository");
	const chooser = await started({ cwd: parent, ui: { select: ["Trust (this session only)"] } });
	const exposurePlan = {
		...plan(join(base, "exposure", "managed")),
		sourceCwd: protectedSource,
		source: protectedIdentity.identity,
		baseCommit: git(protectedSource, "rev-parse", "HEAD"),
	};
	const preflight = await trustPlannedWorktree(exposurePlan, chooser.context as never, agentDir);
	mkdirSync(join(base, "exposure", ".agents", "skills"), { recursive: true });
	assert.throws(preflight.revalidate, /resources changed while waiting/);
});

test("managed worktree can select an unrelated source checkout and its frozen base", async () => {
	base = fresh();
	const parent = repo(join(base, "parent"));
	const source = repo(join(base, "other repository"));
	protect(source);
	git(source, "add", ".");
	git(source, "commit", "-q", "-m", "protected base");
	const sourceHead = git(source, "rev-parse", "HEAD");
	const s = await started({ cwd: parent, projectTrusted: true, ui: { select: ["Do not trust (this session only)"] } });
	const result = await s.toolCall("delegate", {
		agent: "scout",
		task: "inspect",
		worktree: "source/topic",
		worktree_source: source,
	});
	const data = result.structuredContent as Data;
	assert.equal(data.workspace.sourceCwd, source);
	assert.equal(data.workspace.source.mainRoot, source);
	assert.equal(data.workspace.baseCommit, sourceHead);
	const planned = s.entries.find((entry) => entry.data.kind === "workspace-attempt")?.data as Data | undefined;
	assert.equal(planned?.plan.trusted, false, "the journal records the resolved launch trust decision");
	assert.equal(s.selects.length, 1, "unrelated protected base asks before creation despite parent's trust");
	assert.equal(s.tmux.opened[0].cwd, data.cwd);
	assert.equal(git(data.cwd, "rev-parse", "HEAD"), sourceHead);
	assert.equal(git(parent, "rev-parse", "HEAD"), git(parent, "rev-parse", "main"));
});
