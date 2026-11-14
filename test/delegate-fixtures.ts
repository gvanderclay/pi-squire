import type { Agent } from "../src/agents.ts";

/** A complete agent without roster IO or extension registration. */
export function testAgent(overrides: Partial<Agent> = {}): Agent {
	return {
		name: "worker",
		description: "Test worker",
		autoExit: true,
		skills: true,
		contextFiles: true,
		toolsExcept: [],
		fallback: [],
		locked: [],
		promptMode: "append",
		prompt: "Do the task.",
		path: "/agents/worker.md",
		...overrides,
	};
}
