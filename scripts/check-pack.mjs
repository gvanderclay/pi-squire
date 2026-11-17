// Checks the file list `npm pack` would publish. There is no build step: Pi
// loads the .ts sources as they are. So every .ts file under src/, the README,
// the top-level docs pages, LICENSE, CHANGELOG and package.json must be in it,
// nothing from tests, tooling or a docs subfolder may be, and every relative
// import in a packed .ts file must point at another packed file. Last, it packs
// the real tarball, unpacks it and loads it into the project's own Pi, which
// must register the `delegate` command from inside the unpacked directory.
// Run from the package root, after `pnpm install`: node scripts/check-pack.mjs
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, sep } from "node:path";

// npm 11 prints a list of results, npm 12 an object keyed by package name.
const result = Object.values(
	JSON.parse(
		execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
			encoding: "utf8",
		}),
	),
)[0];
const packed = result.files.map((file) => file.path);
const files = new Set(packed);

// The host a developer runs check-pack from must not reach the Pi that loads
// the bundle: Paseo's agent id overrides terminal host selection, and TMUX and
// HERDR/REX decide which multiplexer a delegate would use. Pi sets PI_CODING_AGENT
// itself and check-pack sets PI_CODING_AGENT_DIR for the throwaway home, so
// neither can prove a leak.
const DRIVER_CONTEXT = /^(PI_|TMUX|HERDR|PASEO_|REX_)/;
const PI_OWNED = new Set(["PI_CODING_AGENT", "PI_CODING_AGENT_DIR"]);

/** A probe extension whose command name reports whether a stripped variable reached Pi. */
function probeSource(stripped) {
	return `export default function probe(pi) {
	const leaked = ${JSON.stringify(stripped)}.filter((key) => process.env[key] !== undefined);
	pi.registerCommand(leaked.length === 0 ? "check-pack-env-clean" : "check-pack-env-leaked", {
		description: leaked.length === 0 ? "no stripped driver context reached Pi" : leaked.join(", "),
		handler: async () => {},
	});
}
`;
}

const problems = [];

const sources = readdirSync("src", { recursive: true })
	.filter((name) => name.endsWith(".ts"))
	.map((name) => `src/${name}`);
// Only the reference pages: docs/plans/ and docs/research/ are internal notes
// and must not reach npm, so this list stays non-recursive.
const docs = readdirSync("docs")
	.filter((name) => name.endsWith(".md"))
	.map((name) => `docs/${name}`);
const REQUIRED = ["package.json", "README.md", "LICENSE", "CHANGELOG.md", ...sources, ...docs];
for (const path of REQUIRED) {
	if (!files.has(path)) problems.push(`missing: ${path}`);
}

const FORBIDDEN = /^(test|scripts|node_modules|\.github)\/|^docs\/[^/]+\/|^\.|\.tgz$|\.test\.ts$/;
for (const path of packed) {
	if (FORBIDDEN.test(path)) problems.push(`should not be packed: ${path}`);
}

const IMPORT = /(?:from\s+|import\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
for (const path of packed.filter((p) => p.endsWith(".ts"))) {
	const source = readFileSync(path, "utf8");
	for (const [, target] of source.matchAll(IMPORT)) {
		const resolved = normalize(join(dirname(path), target));
		if (!files.has(resolved)) {
			problems.push(`${path} imports ${target}, which is not packed`);
		}
	}
}

if (problems.length > 0) {
	console.error(`check-pack: ${problems.length} problem(s)`);
	for (const problem of problems) console.error(`  ${problem}`);
	process.exit(1);
}
console.log(`check-pack: ${packed.length} files, all expected`);

// Load the unpacked bundle in Pi and ask which commands it registered.
async function loadInPi() {
	const temp = mkdtempSync(join(tmpdir(), "check-pack-"));
	let pi;
	try {
		execFileSync("npm", ["pack", "--pack-destination", temp, "--ignore-scripts", "--silent"]);
		const tarball = readdirSync(temp).find((name) => name.endsWith(".tgz"));
		execFileSync("tar", ["-xzf", join(temp, tarball), "-C", temp]);
		const bundle = realpathSync(join(temp, "package"));
		const home = join(temp, "home");
		// Strip the driver's context, then prove with a probe extension that none of
		// it reached the Pi process that loads the bundle.
		const stripped = Object.keys(process.env).filter((key) => DRIVER_CONTEXT.test(key) && !PI_OWNED.has(key));
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !DRIVER_CONTEXT.test(key)));
		const probe = join(temp, "probe.ts");
		writeFileSync(probe, probeSource(stripped));
		pi = spawn("node_modules/.bin/pi", ["--no-session", "--mode", "rpc", "-e", bundle, "-e", probe], {
			env: { ...env, HOME: home, PI_CODING_AGENT_DIR: home },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		pi.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const response = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("timed out after 60s")), 60_000);
			pi.on("error", reject);
			pi.stdin.on("error", reject);
			pi.on("close", (code) => reject(new Error(`Pi exited with code ${code}`)));
			pi.stdout.on("data", (chunk) => {
				stdout += chunk;
				for (const line of stdout.split("\n")) {
					try {
						const message = JSON.parse(line);
						if (message.id === "1") {
							clearTimeout(timer);
							resolve(message);
						}
					} catch {}
				}
			});
			pi.stdin.write('{"type":"get_commands","id":"1"}\n');
		}).catch((error) => {
			throw new Error(`${error.message}\n${stderr.trim()}`);
		});
		if (!response.success) throw new Error(`get_commands failed: ${response.error}`);
		const commands = response.data.commands;
		const delegate = commands.find((command) => command.name === "delegate");
		const path = delegate?.sourceInfo?.path;
		if (!path || !realpathSync(path).startsWith(bundle + sep)) {
			throw new Error(
				`delegate was not registered from the unpacked bundle (source: ${path ?? "none"})\n${stderr.trim()}`,
			);
		}
		const leaked = commands.find((command) => command.name === "check-pack-env-leaked");
		if (leaked) throw new Error(`driver context reached the loaded Pi: ${leaked.description ?? "unknown"}`);
		if (!commands.some((command) => command.name === "check-pack-env-clean"))
			throw new Error(`the environment probe did not load\n${stderr.trim()}`);
		console.log(
			`check-pack: the bundle loaded in Pi and registered delegate; ${stripped.length} driver-context variable(s) stayed out`,
		);
	} finally {
		pi?.kill("SIGKILL");
		rmSync(temp, { recursive: true, force: true });
	}
}

try {
	await loadInPi();
} catch (error) {
	console.error(`check-pack: the bundle did not load in Pi: ${error.message}`);
	process.exit(1);
}
