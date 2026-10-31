// Actual released provider, isolated roots, fake Pi lifecycle only. Uses the
// tree-process IPC protocol so tests can pause a live owner outside a lock.
import { join } from "node:path";
import { mailSession, scan } from "../mail-harness.ts";

process.env.PI_CODING_AGENT_DIR = process.env.SQUIRE_TEST_AGENT_DIR;
process.env.XDG_STATE_HOME = join(process.env.SQUIRE_TEST_AGENT_DIR!, "mail-state");
type Instance = ReturnType<typeof mailSession>;
let instance: Instance | undefined;
let release: (() => void) | undefined;
process.on(
	"message",
	(input: {
		key: number;
		op: string;
		session?: string;
		last?: boolean;
		gated?: boolean;
		to?: string;
		reply?: string;
	}) => {
		void execute(input).then(
			(result) => process.send?.({ key: input.key, result }),
			(error: unknown) => process.send?.({ key: input.key, error: String(error) }),
		);
	},
);
async function execute(input: {
	op: string;
	session?: string;
	last?: boolean;
	gated?: boolean;
	to?: string;
	reply?: string;
}): Promise<unknown> {
	if (input.op === "boot") {
		instance = mailSession({
			parent: input.session,
			hasUI: false,
			mailProviderLast: input.last,
			beforeSquire: (pi) => {
				if (input.gated)
					pi.on(
						"session_start",
						() =>
							new Promise<void>((resolve) => {
								release = resolve;
								process.send?.({ key: 0, gated: true });
							}),
					);
			},
		});
		await instance.start();
		return snapshot();
	}
	if (input.op === "release") {
		release?.();
		return true;
	}
	if (!instance) throw new Error("not booted");
	if (input.op === "scan") {
		scan(instance);
		return snapshot();
	}
	if (input.op === "snapshot") return snapshot();
	if (input.op === "fail-injection") {
		instance.pi.sendMessage = () => {
			throw new Error("injected display failure");
		};
		return true;
	}
	if (input.op === "run") {
		await instance.run();
		return snapshot();
	}
	if (input.op === "shutdown") {
		await instance.shutdown();
		return true;
	}
	if (input.op === "request") {
		const payload = { to: input.to, body: "coordinator task" };
		instance.events.emit("message:send", payload);
		return payload;
	}
	if (input.op === "reply") {
		const payload = { to: input.to, inReplyTo: [input.reply], body: "worker report", status: "done" };
		instance.events.emit("message:reply", payload);
		return payload;
	}
	throw new Error("unknown operation");
}
function snapshot(): unknown {
	return {
		sent: instance?.sent,
		prompts: instance?.userMessages,
		entries: instance?.entries,
		errors: instance?.errors,
		shutdowns: instance?.shutdowns(),
	};
}
process.send?.({ ready: true });
