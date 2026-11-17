// Separate-process driver for Rex companion receipt coordination. No Pi
// session, provider mailbox or real Rex server is opened: the "server" is a
// JSON-lines file every process shares, so contention and crash recovery are
// deterministic. Gates let the parent observe a claim between Rex calls.
import { appendFileSync, readFileSync } from "node:fs";
import { createRexCompanions } from "../../src/rex-companions.ts";

type Command = {
	key: number;
	op: "acquire";
	agentDir: string;
	server: string;
	base: string;
	/** The shared fake server's session file. */
	file: string;
	/** Block inside this Rex call until the parent releases it. */
	gate?: "list" | "create";
};

const waiters = new Map<string, () => void>();

function sessions(file: string): { session_id: string; label: string }[] {
	try {
		return readFileSync(file, "utf8")
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line) as { session_id: string; label: string });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

function gate(name: string): Promise<void> {
	process.send?.({ key: 0, gated: name });
	return new Promise((resolve) => waiters.set(name, resolve));
}

process.send?.({ ready: true });
process.on("message", (message: Command | { release: string }) => {
	if ("release" in message) {
		waiters.get(message.release)?.();
		waiters.delete(message.release);
		return;
	}
	void execute(message).then(
		(result) => process.send?.({ key: message.key, result }),
		(error: unknown) => process.send?.({ key: message.key, error: String(error) }),
	);
});

async function execute(command: Command): Promise<unknown> {
	let calls = 0;
	const companions = createRexCompanions({
		agentDir: () => command.agentDir,
		run: async (route, args) => {
			if (route.server !== command.server) throw new Error("unscoped Rex call");
			calls++;
			const method = args[2];
			if (args[0] === "api" && method === "session.list") {
				if (command.gate === "list" && calls === 1) await gate("list");
				return JSON.stringify({ sessions: sessions(command.file) });
			}
			if (args[0] === "api" && method === "session.create") {
				const input = JSON.parse(args[3] ?? "{}") as { label?: string };
				const session_id = `session:${process.pid}-${calls}`;
				// The session exists before any receipt: a crash here leaks an
				// unproved empty session, which no later acquisition may adopt.
				appendFileSync(command.file, `${JSON.stringify({ session_id, label: input.label ?? "" })}\n`);
				if (command.gate === "create") await gate("create");
				return JSON.stringify({ session_id });
			}
			throw new Error(`unexpected Rex call ${args.join(" ")}`);
		},
	});
	return companions.acquire({ server: command.server }, command.base);
}
