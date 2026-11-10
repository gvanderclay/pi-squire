import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, beforeEach, test } from "node:test";
import { cleanup, resetRoot } from "./harness.ts";
import { captureStartBytes } from "./start-bytes.ts";

beforeEach(resetRoot);
after(cleanup);

test("launch, resume and fork preserve registry v2, child-task v2 and start-v2 serialization bytes", async () => {
	assert.equal(await captureStartBytes(), readFileSync(new URL("./fixtures/start-bytes.txt", import.meta.url), "utf8"));
});
