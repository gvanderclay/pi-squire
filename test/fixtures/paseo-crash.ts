// A real opener process killed after its progress sink durably writes a receipt.
// All daemon operations are fake; never connect to an owner's Paseo daemon.
import { createPaseoHost } from "../../src/paseo.ts";
import type { PaseoApi } from "../../src/paseo-api.ts";
import type { PaseoReceipt } from "../../src/worktree.ts";
import { session } from "../harness.ts";
import { FakePaseo } from "../paseo-fixture.ts";

process.env.PI_CODING_AGENT_DIR = process.env.SQUIRE_TEST_AGENT_DIR;
type Command = { key: number; parent: string; source: string; receipt: PaseoReceipt };
process.on("message", (command: Command) => {
	void launch(command).catch((error: unknown) => process.send?.({ key: command.key, error: String(error) }));
});
async function launch(command: Command): Promise<void> {
	const api: PaseoApi = new FakePaseo();
	const host = createPaseoHost(api, { PASEO_AGENT_ID: "11111111-1111-4111-8111-111111111111" });
	const s = session({ parent: command.parent, cwd: command.source, multiplexer: host });
	api.create = async (input, progress) => {
		progress?.({
			paseo: { ...command.receipt, directory: input.cwd },
			agentId: input.agentId,
			sessionId: "crash-assigned-session",
		});
		// Reply only after both attempt and tree progress have been persisted.
		process.send?.({ key: command.key, result: { entries: s.entries, cwd: input.cwd, id: input.agentId } });
		return new Promise<Awaited<ReturnType<PaseoApi["create"]>>>(() => {});
	};
	await s.start();
	await s.toolCall("delegate", { agent: "scout", task: "work", worktree: "crash-progress" });
	throw new Error("crash fixture unexpectedly completed");
}
process.send?.({ key: 0, ready: true });
