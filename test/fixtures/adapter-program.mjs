// A real program for adapter conformance: screen output is not a result.
import { createInterface } from "node:readline";

console.log("SQUIRE-ADAPTER-SCREEN");
createInterface({ input: process.stdin }).on("line", (line) => {
	if (line === "exit") process.exit(0);
});
