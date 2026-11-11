// A Paseo delegate takes no Pi command line: its host reads the launch argv
// as agent fields and environment variables instead.
import { WindowOpenError, type WindowSpec } from "./host.ts";
import { PASEO_TOOLS_ENV, PASEO_TRUST_ENV } from "./paseo-child.ts";

/** What the host creates a Paseo agent from, read from the argv `launchPayload` builds. */
export type PaseoLaunch = {
	agentId: string;
	title: string;
	model: string;
	thinking: string;
	promptFile: string;
	env: Record<string, string>;
};

/** Flags whose value is the next argv entry. */
const VALUE_FLAGS = new Set([
	"--session-id",
	"--name",
	"--model",
	"--thinking",
	"--append-system-prompt",
	"--session-dir",
]);
/** Resume and fork need a Pi session file, which Paseo has no field for. */
const REFUSED_FLAGS = new Set(["--session", "--fork"]);
/** Marker keys: the tools and trust flags share one, so the last one given wins. */
const TOOLS = "tools";
const TRUST = "trust";

const refuse = (message: string): WindowOpenError => new WindowOpenError(message, "not-opened");

const textOf = (flags: Map<string, string>, name: string): string | undefined => flags.get(name);

/** The next argv entry, refused by name when a flag with a value has none. */
function nextValue(argv: readonly string[], index: number): string {
	const value = argv[index + 1];
	if (value === undefined || value.startsWith("--")) {
		throw refuse(`the delegate flag ${argv[index]} needs a value`);
	}
	return value;
}

type ParsedFlag = { key: string; value: string; consumed: number };

/** One flag, its marker key and value, and how many argv entries it used. */
function flagAt(argv: readonly string[], index: number): ParsedFlag {
	const arg = argv[index];
	if (REFUSED_FLAGS.has(arg)) throw refuse("Paseo cannot resume or fork a delegate yet");
	if (!arg.startsWith("-")) throw refuse(`Paseo cannot pass this stray argument to a delegate: ${arg}`);
	if (arg === "--no-tools") return { key: TOOLS, value: "", consumed: 1 };
	if (arg === "--approve") return { key: TRUST, value: "yes", consumed: 1 };
	if (arg === "--no-approve") return { key: TRUST, value: "no", consumed: 1 };
	if (arg === "--tools" || VALUE_FLAGS.has(arg)) {
		return { key: arg === "--tools" ? TOOLS : arg, value: nextValue(argv, index), consumed: 2 };
	}
	throw refuse(`Paseo cannot pass the delegate flag ${arg}`);
}

/** The flags of one delegate launch; the leading Pi command has no flag marker. */
function flagsOf(argv: readonly string[]): Map<string, string> {
	const flags = new Map<string, string>();
	let index = 0;
	while (index < argv.length && !argv[index].startsWith("-")) index++;
	while (index < argv.length) {
		const flag = flagAt(argv, index);
		flags.set(flag.key, flag.value);
		index += flag.consumed;
	}
	return flags;
}

/** The delegate's environment: the spec's own copy plus what the flags say. */
function environmentOf(flags: Map<string, string>, base: Readonly<Record<string, string>>): Record<string, string> {
	const env = { ...base };
	const sessionDir = textOf(flags, "--session-dir");
	if (sessionDir !== undefined) env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
	const tools = flags.get(TOOLS);
	if (tools !== undefined) env[PASEO_TOOLS_ENV] = tools;
	const trust = flags.get(TRUST);
	if (trust !== undefined) env[PASEO_TRUST_ENV] = trust;
	return env;
}

const required = (flags: Map<string, string>, flag: string): string => {
	const value = textOf(flags, flag);
	if (value === undefined) throw refuse(`the delegate start gave no ${flag}`);
	return value;
};

/** The agent fields one launch spec asks for; nothing is created until the caller asks. */
export function paseoLaunch(spec: WindowSpec): PaseoLaunch {
	const flags = flagsOf(spec.argv);
	const agentId = required(flags, "--session-id");
	const model = required(flags, "--model");
	const thinking = required(flags, "--thinking");
	const promptFile = required(flags, "--append-system-prompt");
	return {
		agentId,
		title: textOf(flags, "--name") ?? "",
		model,
		thinking,
		promptFile,
		env: environmentOf(flags, spec.env),
	};
}
