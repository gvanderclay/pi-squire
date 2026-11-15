// Import the shared harness as an IPC fixture, not as a node:test file.
import { cleanup } from "../harness.ts";

await cleanup();
process.stdout.write("harness fixture cleaned up\n");
