// The tools an agent's own `extensions` register, for a delegate that gets the
// parent's tools (no `tools` field, or only `-name` entries): those tools
// exist only in the child, so the parent's active tools cannot name them, and
// the child's `--tools` list would otherwise leave them out.
//
// Each extension is loaded with Pi's own loader, `discoverAndLoadExtensions`,
// apart from any session: a fresh module, a throwaway event bus and runtime,
// and an empty folder for discovery, so nothing else is found. Its factory
// runs, which is when an extension registers its tools; Pi's docs ask
// extensions to start long-lived work on `session_start`, which never fires
// here. A tool an extension registers only later is not seen.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

/** An empty folder for the loader's discovery, made once per process. */
let empty: string | undefined;

/** The tool names `paths` register when they load, in order, and one line per extension that would not load. */
export async function extensionTools(paths: readonly string[]): Promise<{ tools: string[]; problems: string[] }> {
	if (paths.length === 0) return { tools: [], problems: [] };
	empty ??= mkdtempSync(join(tmpdir(), "pi-squire-extensions-"));
	let loaded: Awaited<ReturnType<typeof discoverAndLoadExtensions>>;
	try {
		loaded = await discoverAndLoadExtensions([...paths], empty, empty);
	} catch (err) {
		return {
			tools: [],
			problems: [`could not read the tools ${paths.join(", ")} register: ${(err as Error).message}`],
		};
	}
	const tools = loaded.extensions.flatMap((extension) => [...extension.tools.keys()]);
	const problems = loaded.errors.map(({ path, error }) => `could not read the tools ${path} registers: ${error}`);
	return { tools: [...new Set(tools)], problems };
}
