#!/usr/bin/env node
// Drives a real Pi + pi-squire (this checkout) + pi-session-mail in a private
// tmux server with a scratch agent directory, for verification runs.
// Usage: node .pi/skills/verify-pi-squire/scripts/squire-verify.mjs <command> [options]
// Every command prints one JSON object; ok:false means the command failed.
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const SCRATCH = join(REPO, ".scratch", "verify-pi-squire");
const PI = join(REPO, "node_modules", ".bin", "pi");
const MAIL = join(REPO, "node_modules", "pi-session-mail");
const MODEL = process.env.SQUIRE_VERIFY_MODEL ?? "opencode-go/deepseek-v4.1-flash";
const THINKING = process.env.SQUIRE_VERIFY_THINKING ?? "low";

const HELP = [
	"squire-verify <command> [options]   (every command prints JSON)",
	"",
	"  launch [--run <id>] [--herdr [--herdr-integration]]",
	"                               Create a run and start the root Pi in a private tmux server, or with",
	"                               --herdr in a private named Herdr session hosted by that tmux server.",
	"                               --herdr-integration copies your Herdr Pi integration into the run.",
	"  doctor --run <id>            Read-only health check of a run.",
	"  type --run <id> --text <t>   Type one line into the root Pi and press Enter.",
	"  delegate --run <id> --label <label> [--no-auto-exit] [--task <text>]",
	"                               Type '/delegate verifier ...' into the root. Without --task the",
	"                               task asks the delegate to reply with a fresh nonce.",
	"  ask --run <id> --tool <name> --text <prompt> [--timeout <s>]",
	"                               Type a prompt asking the root model to call one Squire tool, wait for",
	"                               that tool's next result in the root session, save it as evidence.",
	"  wait-result --run <id> --nonce <n> [--timeout <s>]",
	"                               Wait for a delegate result holding the nonce in the root session.",
	"  windows --run <id>           List the run's tmux windows.",
	"  capture --run <id> --name <n>  Save every window's pane text into the run's evidence folder.",
	"  herdr --run <id> --args <a>  Herdr runs only: run 'herdr --session <run session> <a>' (space-split).",
	"  herdr-restart --run <id>     Herdr runs only: stop and restart the run's Herdr session (restores tabs).",
	"  cleanup --run <id>           Stop/delete only this run's Herdr session (if any) and kill only its",
	"                               tmux server. Evidence stays.",
	"",
	"Needs OPENCODE_API_KEY in the environment, or an API key for the model's provider in your",
	"Pi auth.json. SQUIRE_VERIFY_MODEL and",
	"SQUIRE_VERIFY_THINKING override the defaults " + MODEL + " / " + THINKING + ".",
].join("\n");

function fail(message, extra = {}) {
	console.log(JSON.stringify({ ok: false, error: message, ...extra }, null, 2));
	process.exit(1);
}
function done(value) {
	console.log(JSON.stringify({ ok: true, ...value }, null, 2));
}
function parse(argv) {
	const out = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) {
			out._.push(a);
			continue;
		}
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) out[a.slice(2)] = true;
		else {
			out[a.slice(2)] = next;
			i++;
		}
	}
	return out;
}
function sleep(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function paths(run) {
	const dir = join(SCRATCH, run);
	return {
		run,
		dir,
		agent: join(dir, "agent"),
		work: join(dir, "work"),
		evidence: join(dir, "evidence"),
		socket: "squire-verify-" + run,
		herdrSession: "squire-verify-" + run,
		herdrConfig: join(dir, "herdr.toml"),
		meta: join(dir, "run.json"),
	};
}
/** Herdr runs keep their root in pane w1:p1 of a named session no other tool uses. */
function isHerdr(p) {
	return existsSync(p.meta) && readMeta(p).multiplexer === "herdr";
}
function herdr(p, args, allowFail = false) {
	const r = spawnSync("herdr", ["--session", p.herdrSession, ...args], { encoding: "utf8", env: herdrEnv(p), timeout: 30_000 });
	if (r.status !== 0 && !allowFail) fail("herdr " + args.join(" ") + " failed", { stderr: r.stderr, stdout: r.stdout });
	return r;
}
/** Never the user's config or default session: a private config file and no inherited routing. */
function herdrEnv(p) {
	const env = cleanEnv(p);
	for (const k of Object.keys(env)) if (k.startsWith("HERDR")) delete env[k];
	env.HERDR_CONFIG_PATH = p.herdrConfig;
	return env;
}
function startHerdr(p) {
	// env -u: the Herdr server must not inherit the host tmux pane's routing.
	tmux(p, ["new-session", "-d", "-s", "host", "-n", "herdr", "-x", "200", "-y", "50", "-c", p.work, "env", "-u", "TMUX", "-u", "TMUX_PANE", "HERDR_CONFIG_PATH=" + p.herdrConfig, "herdr", "--session", p.herdrSession]);
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		sleep(1000);
		const r = herdr(p, ["status", "server", "--json"], true);
		try {
			if (JSON.parse(r.stdout).running === true) return;
		} catch {}
	}
	fail("the run's Herdr session did not start within 30s", { session: p.herdrSession });
}
function requireRun(opts) {
	if (typeof opts.run !== "string") fail("--run <id> is required");
	const p = paths(opts.run);
	if (!existsSync(p.meta)) fail("no such run: " + p.dir);
	return p;
}
let key;
/** The run's agent dir is scratch, so a key saved with /login must be read from the user's own auth.json. */
function opencodeKey() {
	if (key !== undefined) return key || undefined;
	key = process.env.OPENCODE_API_KEY ?? "";
	const file = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "auth.json");
	if (key || !existsSync(file)) return key || undefined;
	const saved = JSON.parse(readFileSync(file, "utf8"))[MODEL.split("/")[0]];
	if (saved?.type !== "api_key" || typeof saved.key !== "string") return undefined;
	key = saved.key.startsWith("!")
		? execSync(saved.key.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
		: saved.key;
	return key || undefined;
}
function cleanEnv(p) {
	const env = {};
	for (const [k, v] of Object.entries(process.env))
		if (!k.startsWith("PI_") && k !== "TMUX" && k !== "TMUX_PANE") env[k] = v;
	env.PI_CODING_AGENT_DIR = p.agent;
	// Keep the run's mailboxes and Squire's prompt files inside the run. Only
	// pi-session-mail's own root moves: redirecting XDG_STATE_HOME would also move
	// the state of every tool the tmux server starts, such as the user's tmux
	// config, which then rebuilds that state and can repoint the user's files at it.
	env.PI_SESSION_MAIL_ROOT = join(p.dir, "state", "pi-session-mail");
	env.TMPDIR = join(p.dir, "tmp");
	env.PI_SKIP_VERSION_CHECK = "1";
	const opencode = opencodeKey();
	if (opencode) env.OPENCODE_API_KEY = opencode;
	return env;
}
function tmux(p, list, allowFail = false) {
	const r = spawnSync("tmux", ["-L", p.socket, ...list], { encoding: "utf8", env: cleanEnv(p) });
	if (r.status !== 0 && !allowFail) fail("tmux " + list.join(" ") + " failed", { stderr: r.stderr });
	return r;
}
function listWindows(p) {
	const r = tmux(p, ["list-windows", "-a", "-F", "#{session_name}:#{window_id}\t#{window_name}\t#{pane_current_command}\t#{pane_dead}"], true);
	if (r.status !== 0) return undefined;
	return r.stdout
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [target, name, command, dead] = line.split("\t");
			return { target, name, command, dead: dead === "1" };
		});
}
function capture(p, target) {
	return tmux(p, ["capture-pane", "-p", "-J", "-t", target], true).stdout ?? "";
}
function sessionFiles(p) {
	const root = join(p.agent, "sessions");
	if (!existsSync(root)) return [];
	return readdirSync(root, { recursive: true })
		.map(String)
		.filter((name) => name.endsWith(".jsonl"))
		.map((name) => join(root, name))
		.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
}
function readMeta(p) {
	return JSON.parse(readFileSync(p.meta, "utf8"));
}
/** The root's session file: Pi writes it with the first entry, so find it lazily. Delegates have identity files; the root does not. */
function rootSession(p) {
	const meta = readMeta(p);
	if (meta.rootSession && existsSync(meta.rootSession)) return meta.rootSession;
	const identityDir = join(p.agent, "squire", "identity");
	const delegates = new Set(existsSync(identityDir) ? readdirSync(identityDir).map((f) => f.replace(/\.json$/, "")) : []);
	const found = sessionFiles(p).find((f) => !delegates.has(f.match(/_([0-9a-f-]{36})\.jsonl$/)?.[1] ?? ""));
	if (found) {
		meta.rootSession = found;
		writeFileSync(p.meta, JSON.stringify(meta, null, 2) + "\n");
	}
	return found;
}

function launch(opts) {
	if (!opencodeKey()) fail("no OpenCode key: set OPENCODE_API_KEY, or /login to " + MODEL.split("/")[0] + " in your own Pi");
	if (!existsSync(PI) || !existsSync(MAIL)) fail("node_modules/.bin/pi or pi-session-mail is missing; run pnpm install");
	const run = typeof opts.run === "string" ? opts.run : "v" + new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
	const p = paths(run);
	if (existsSync(p.dir)) fail("run already exists: " + p.dir);
	for (const d of [join(p.agent, "agents"), join(p.agent, "squire"), p.work, p.evidence, join(p.dir, "state"), join(p.dir, "tmp")]) mkdirSync(d, { recursive: true });
	const settings = {
		packages: [MAIL, REPO],
		defaultProvider: MODEL.split("/")[0],
		defaultModel: MODEL.split("/").slice(1).join("/"),
		defaultThinkingLevel: THINKING,
		defaultProjectTrust: "never",
		quietStartup: true,
	};
	writeFileSync(join(p.agent, "settings.json"), JSON.stringify(settings, null, 2) + "\n");
	if (opts["herdr-integration"]) {
		// A read-only copy of Herdr's own Pi integration, so the run's Pis report
		// agent sessions (and Herdr restores them) as an integrated user's would.
		const source = join(homedir(), ".pi", "agent", "extensions", "herdr-agent-state.ts");
		if (!existsSync(source)) fail("no Herdr Pi integration at " + source + "; run 'herdr integration install pi' yourself first");
		mkdirSync(join(p.agent, "extensions"), { recursive: true });
		copyFileSync(source, join(p.agent, "extensions", "herdr-agent-state.ts"));
	}
	writeFileSync(
		join(p.agent, "agents", "verifier.md"),
		[
			"---",
			"description: Verification delegate; does exactly what the task says and answers in one message",
			"model: " + MODEL,
			"thinking: " + THINKING,
			"tools: read, ls",
			"---",
			"",
			"Do exactly what the task asks. Answer with only the text it asks for.",
			"",
		].join("\n"),
	);
	writeFileSync(join(p.work, "README.md"), "Scratch project for a pi-squire verification run.\n");
	const git = (a) => execFileSync("git", a, { cwd: p.work, stdio: "pipe" });
	git(["init", "-q", "-b", "main"]);
	git(["add", "README.md"]);
	git(["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", "scratch"]);
	const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
	const dirty = execFileSync("git", ["status", "--porcelain", "--", "src"], { cwd: REPO, encoding: "utf8" }).trim() !== "";
	const multiplexer = opts.herdr ? "herdr" : "tmux";
	writeFileSync(p.meta, JSON.stringify({ run, repo: REPO, commit, srcDirty: dirty, model: MODEL, thinking: THINKING, socket: p.socket, multiplexer, ...(opts.herdr ? { herdrSession: p.herdrSession } : {}) }, null, 2) + "\n");
	// The root model only needs Squire's and mail's tools; no bash/edit/write in the scratch run.
	const tools = "read,ls,delegate,delegation_*,session_mail_*";
	const argv = [PI, "--model", MODEL, "--thinking", THINKING, "--tools", tools];
	if (opts.herdr) {
		// Private config: no onboarding or network checks; agent restore stays at Herdr's default (on).
		writeFileSync(p.herdrConfig, "onboarding = false\n[update]\nversion_check = false\nmanifest_check = false\n[server]\nheadless_cols = 200\nheadless_rows = 50\n");
		startHerdr(p);
		const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
		herdr(p, ["pane", "run", "w1:p1", "cd " + quote(p.work) + " && " + argv.map(quote).join(" ")]);
	} else tmux(p, ["new-session", "-d", "-s", "root", "-n", "root", "-x", "200", "-y", "50", "-c", p.work, ...argv]);
	const deadline = Date.now() + 60_000;
	let pane = "";
	while (Date.now() < deadline) {
		sleep(1000);
		pane = rootPane(p);
		if (READY.test(pane)) break;
	}
	writeFileSync(join(p.evidence, "launch-pane.txt"), pane);
	if (!READY.test(pane)) fail("root Pi did not become ready within 60s", { pane: pane.split("\n").slice(-20).join("\n"), ...p });
	done({ ...p, commit, srcDirty: dirty });
}
// The footer shows "<model id> • <thinking>" once the TUI is up with its model.
const READY = new RegExp(escape(MODEL.split("/").slice(1).join("/")) + " • " + THINKING);
function escape(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, (c) => "\\" + c);
}

function entries(file) {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			try {
				return [JSON.parse(line)];
			} catch {
				return [];
			}
		});
}
function textOf(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((part) => (part && typeof part.text === "string" ? part.text : "")).join("\n");
	return "";
}
function typeLine(p, text) {
	if (isHerdr(p)) {
		herdr(p, ["pane", "send-text", "w1:p1", text]);
		herdr(p, ["pane", "send-keys", "w1:p1", "Enter"]);
		return;
	}
	tmux(p, ["send-keys", "-t", "root:root", "-l", text]);
	tmux(p, ["send-keys", "-t", "root:root", "Enter"]);
}
function rootPane(p) {
	return isHerdr(p) ? (herdr(p, ["pane", "read", "w1:p1", "--source", "visible"], true).stdout ?? "") : capture(p, "root:root");
}
/** Herdr panes as tabs, from one snapshot; tmux windows otherwise. */
function herdrTabs(p) {
	const r = herdr(p, ["api", "snapshot"], true);
	try {
		const snap = JSON.parse(r.stdout).result.snapshot;
		return snap.panes.map((pane) => ({
			target: pane.pane_id,
			tab: pane.tab_id,
			name: snap.tabs?.find((t) => t.tab_id === pane.tab_id)?.label ?? pane.tab_id,
			terminal: pane.terminal_id,
			agent: pane.agent ?? null,
			agentSession: pane.agent_session?.value ?? null,
		}));
	} catch {
		return undefined;
	}
}

function doctor(p) {
	const meta = readMeta(p);
	const checks = [];
	const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
	check("OpenCode key found", opencodeKey(), "from OPENCODE_API_KEY or your auth.json; the run's Pi sessions read it from the tmux server environment");
	const wins = listWindows(p);
	check("tmux server up", wins !== undefined, p.socket);
	const herdrRun = meta.multiplexer === "herdr";
	const root = herdrRun ? herdrTabs(p)?.find((w) => w.target === "w1:p1") : wins?.find((w) => w.target.startsWith("root:") && w.name === "root");
	check(herdrRun ? "Herdr session answers and root pane w1:p1 exists" : "root window alive", root && !root.dead, root);
	const pane = root ? rootPane(p) : "";
	check("root shows model footer", READY.test(pane), MODEL + " • " + THINKING);
	const rootFile = rootSession(p);
	check("root session file", true, rootFile ?? "not written yet; Pi writes it with the session's first entry");
	const settings = JSON.parse(readFileSync(join(p.agent, "settings.json"), "utf8"));
	check("loads this checkout and pi-session-mail", settings.packages?.includes(REPO) && settings.packages?.includes(MAIL), settings.packages);
	const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
	check("checkout still at the launch commit", head === meta.commit, { launch: meta.commit, now: head });
	const ok = checks.every((c) => c.ok);
	console.log(JSON.stringify({ ok, run: p.run, checks }, null, 2));
	process.exit(ok ? 0 : 1);
}

function delegate(p, opts) {
	if (typeof opts.label !== "string") fail("--label <label> is required");
	const nonce = "SQUIRE-" + opts.label + "-" + Math.random().toString(36).slice(2, 8).toUpperCase();
	const task = typeof opts.task === "string" ? opts.task : "Reply with exactly the text " + nonce + " and nothing else.";
	const line = "/delegate verifier --label " + opts.label + (opts["no-auto-exit"] ? " --no-auto-exit" : "") + " " + task;
	const label = escape(opts.label);
	// tmux: "in window <name> in session <s>"; Herdr: "in tab <name> (<tab id>) in workspace <w>".
	const notice = new RegExp("delegate: verifier ([0-9a-f-]{36}) started in (?:window|tab) (verifier-" + label + ")(?: \\((\\S+)\\))? in (?:session|workspace) (\\S+)", "g");
	// Earlier notices with the same label stay on screen; only an id not seen before counts.
	const seen = new Set([...rootPane(p).matchAll(notice)].map((m) => m[1]));
	typeLine(p, line);
	const deadline = Date.now() + 30_000;
	let match;
	let pane = "";
	while (Date.now() < deadline && !match) {
		sleep(1000);
		pane = rootPane(p);
		match = [...pane.matchAll(notice)].find((m) => !seen.has(m[1]));
	}
	if (!match) fail("no 'started in window/tab' notice within 30s", { typed: line, pane: pane.split("\n").slice(-20).join("\n") });
	done({ typed: line, nonce: typeof opts.task === "string" ? undefined : nonce, id: match[1], window: match[2], ...(match[3] ? { tab: match[3] } : {}), session: match[4] });
}

function toolResults(p, tool) {
	const file = rootSession(p);
	if (!file) return [];
	return entries(file).filter((e) => e.type === "message" && e.message?.role === "toolResult" && e.message.toolName === tool);
}
function ask(p, opts) {
	if (typeof opts.tool !== "string" || typeof opts.text !== "string") fail("--tool <name> and --text <prompt> are required");
	const before = toolResults(p, opts.tool).length;
	typeLine(p, opts.text);
	const timeout = Number(opts.timeout ?? 120) * 1000;
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		sleep(2000);
		const results = toolResults(p, opts.tool);
		if (results.length > before) {
			const hit = results[before];
			const file = join(p.evidence, "tool-" + opts.tool + "-" + hit.id + ".json");
			writeFileSync(file, JSON.stringify(hit, null, 2) + "\n");
			done({ tool: opts.tool, isError: hit.message.isError, text: textOf(hit.message.content), details: hit.message.details, evidence: file });
			return;
		}
	}
	fail("the root model made no new " + opts.tool + " call within " + timeout / 1000 + "s", { typed: opts.text });
}

function waitResult(p, opts) {
	if (typeof opts.nonce !== "string") fail("--nonce <nonce> is required");
	const timeout = Number(opts.timeout ?? 180) * 1000;
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const file = rootSession(p);
		const hit = file && entries(file).find(
			(e) => e.type === "custom_message" && e.customType === "delegate" && textOf(e.content).includes(opts.nonce),
		);
		if (hit) {
			const text = textOf(hit.content);
			const saved = join(p.evidence, "result-" + opts.nonce + ".json");
			writeFileSync(saved, JSON.stringify(hit, null, 2) + "\n");
			const id = text.match(/delegation ([0-9a-f-]{36})/)?.[1];
			// A resumed delegation keeps the session it resumed, so find the delegate by its answer, not by id.
			const lastAnswer = (f) =>
				entries(f)
					.filter((e) => e.type === "message" && e.message?.role === "assistant")
					.map((e) => ({ model: e.message.provider + "/" + e.message.model, text: textOf(e.message.content) }))
					.filter((a) => a.text.includes(opts.nonce))
					.at(-1);
			const child = sessionFiles(p).find((f) => f !== file && lastAnswer(f));
			const answer = child ? lastAnswer(child) : undefined;
			done({
				nonce: opts.nonce,
				id,
				status: text.match(/Status: (\w+)/)?.[1],
				resultEntry: saved,
				delegateSession: child,
				delegateAnswer: answer,
				windows: isHerdr(p) ? herdrTabs(p) : listWindows(p),
			});
			return;
		}
		sleep(2000);
	}
	fail("no delegate result with " + opts.nonce + " in the root session within " + timeout / 1000 + "s", { rootSession: rootSession(p) });
}

const opts = parse(process.argv.slice(2));
const command = opts._[0];
if (!command || opts.help || command === "help") {
	console.log(HELP);
	process.exit(0);
}
if (command === "launch") launch(opts);
else if (command === "doctor") doctor(requireRun(opts));
else if (command === "type") {
	if (typeof opts.text !== "string") fail("--text <text> is required");
	const p = requireRun(opts);
	typeLine(p, opts.text);
	done({ typed: opts.text });
} else if (command === "delegate") delegate(requireRun(opts), opts);
else if (command === "ask") ask(requireRun(opts), opts);
else if (command === "wait-result") waitResult(requireRun(opts), opts);
else if (command === "windows") {
	const p = requireRun(opts);
	done(isHerdr(p) ? { tabs: herdrTabs(p), hostWindows: listWindows(p) } : { windows: listWindows(p) });
} else if (command === "capture") {
	const p = requireRun(opts);
	const name = typeof opts.name === "string" ? opts.name : "capture";
	const saved = [];
	if (isHerdr(p))
		for (const t of herdrTabs(p) ?? []) {
			const file = join(p.evidence, name + "-" + t.name + "-" + t.target.replace(/[^A-Za-z0-9_-]/g, "_") + ".txt");
			writeFileSync(file, herdr(p, ["pane", "read", t.target, "--source", "recent"], true).stdout ?? "");
			saved.push(file);
		}
	else
		for (const w of listWindows(p) ?? []) {
			const file = join(p.evidence, name + "-" + w.name + ".txt");
			writeFileSync(file, capture(p, w.target));
			saved.push(file);
		}
	done({ saved });
} else if (command === "herdr") {
	const p = requireRun(opts);
	if (!isHerdr(p) || typeof opts.args !== "string") fail("a Herdr run and --args are required");
	const r = herdr(p, opts.args.split(" ").filter(Boolean), true);
	done({ status: r.status, stdout: r.stdout, stderr: r.stderr });
} else if (command === "herdr-restart") {
	const p = requireRun(opts);
	if (!isHerdr(p)) fail("not a Herdr run");
	const before = herdrTabs(p);
	spawnSync("herdr", ["session", "stop", p.herdrSession], { encoding: "utf8", env: herdrEnv(p), timeout: 30_000 });
	tmux(p, ["kill-session", "-t", "host"], true);
	startHerdr(p);
	sleep(5000);
	done({ before, after: herdrTabs(p) });
} else if (command === "cleanup") {
	const p = requireRun(opts);
	let herdrStopped;
	if (isHerdr(p)) {
		// Only this run's named session; never the default session or the user's config.
		const stop = spawnSync("herdr", ["session", "stop", p.herdrSession], { encoding: "utf8", env: herdrEnv(p), timeout: 30_000 });
		const del = spawnSync("herdr", ["session", "delete", p.herdrSession], { encoding: "utf8", env: herdrEnv(p), timeout: 30_000 });
		herdrStopped = { stop: stop.status, delete: del.status };
	}
	const r = tmux(p, ["kill-server"], true);
	done({ killed: r.status === 0, herdrStopped, evidence: p.evidence, evidenceFiles: existsSync(p.evidence) ? readdirSync(p.evidence) : [] });
} else fail("unknown command " + command + "; see --help");
