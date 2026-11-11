import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { createPaseoApi } from "../src/paseo-api.ts";

/** Throwaway homes under .scratch/tmp, removed when this file finishes. */
const DIRS: string[] = [];

after(() => {
	for (const dir of DIRS) rmSync(dir, { recursive: true, force: true });
});

/** An empty Paseo home: no pid file, so no daemon either. */
function emptyHome(): string {
	mkdirSync(".scratch/tmp", { recursive: true });
	const dir = mkdtempSync(join(process.cwd(), ".scratch/tmp/paseo-api-"));
	DIRS.push(dir);
	return dir;
}

test("a home with no daemon is refused by the pid file's name, without contacting anything", async () => {
	const home = emptyHome();
	const refusal = await createPaseoApi(home).unavailable();
	assert.ok(refusal !== undefined);
	assert.ok(refusal.includes(join(home, "paseo.pid")), refusal);
	assert.match(refusal, /Paseo is not running/);
});
