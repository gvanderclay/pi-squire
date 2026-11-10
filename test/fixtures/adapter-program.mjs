// A real program for adapter conformance: screen output is not a result.
// With a report path as its first argument it records what it was started
// with (argv, working directory and SQUIRE_CONTRACT_* environment) there.
import { renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const report = process.argv[2];
if (report) {
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("SQUIRE_CONTRACT_")));
	writeFileSync(`${report}.next`, JSON.stringify({ argv: process.argv, cwd: process.cwd(), env }));
	renameSync(`${report}.next`, report);
}
console.log("SQUIRE-ADAPTER-SCREEN");
createInterface({ input: process.stdin }).on("line", (line) => {
	if (line === "exit") process.exit(0);
});
