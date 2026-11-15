import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { globalAgentsDir, projectAgentsDir } from "./agents.ts";

export const STARTER_AGENT = `---
description: Looks things up and answers in one message
tools: read, grep, find, ls
---

Research the task and answer concisely, citing the files you read.
`;

/** No model lookup, trust change, or write until the user approves the exact file. */
export async function bootstrapAgent(ctx: ExtensionContext, agentDir: string): Promise<boolean> {
	if (ctx.mode !== "tui") return false;
	const user = `User — ${globalAgentsDir(agentDir)} (all projects)`;
	const project = `Project — ${projectAgentsDir(ctx.cwd)} (trusted project only; overrides user agents)`;
	const trusted = ctx.isProjectTrusted();
	const scope = await ctx.ui.select(
		`Create a starter scout? Choose scope${trusted ? "" : " (project agents require project trust; user scope only)"}`,
		trusted ? [user, project] : [user],
	);
	if (scope !== user && scope !== project) return false;
	// Recheck the session trust after the dialog: creating a file never grants it.
	if (scope === project && !ctx.isProjectTrusted()) throw new Error("project agent creation needs a trusted project");
	const dir = scope === project ? projectAgentsDir(ctx.cwd) : globalAgentsDir(agentDir);
	const path = join(dir, "scout.md");
	const approved = await ctx.ui.confirm(
		"Create scout.md?",
		`Write this exact file (never overwrite):\n${path}\n\n${STARTER_AGENT}\nModel and thinking inherit this session. Tools limit the scout, but are not a security sandbox.\nCreate it?`,
	);
	if (!approved) return false;
	if (scope === project && !ctx.isProjectTrusted()) throw new Error("project agent creation needs a trusted project");
	mkdirSync(dir, { recursive: true });
	try {
		writeFileSync(path, STARTER_AGENT, { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST")
			throw new Error(
				`starter agent already exists at ${path}; not overwritten. Edit or rename it, then run /delegate again`,
			);
		throw error;
	}
	return true;
}
