import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import type { ApprovedCheck } from "./delegate-check.ts";

const TIME_LIMIT_MS = 5 * 60_000;
const OUTPUT_LIMIT = 1024 * 1024;
const TAIL_LINES = 20;
const LINE_LIMIT = 200;
const CANCELED = "canceled because the delegation closed";
const FAILURE = /\b(?:fail(?:ed|ure)?|\w*error|not ok|panicked)\b|[✗×]/i;
const FRAME = /^(?:at\s|File ["']|#\d+\s)|\bat\s+\S+:\d+/;
const DEPENDENCY = /(?:^|[\s(/])(?:node_modules|vendor|site-packages|\.venv|deps)[/\\]|\bnode:internal\b/;

export type CheckRun = {
	command: string;
	cwd: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	ms: number;
};
export type CheckResult = {
	status: "pass" | "fail" | "error";
	runs: CheckRun[];
	tail?: string[];
	error?: string;
};

function captureOutput(): { push(data: Buffer): void; text(): string } {
	const buffer = Buffer.allocUnsafe(OUTPUT_LIMIT);
	let offset = 0;
	let full = false;
	return {
		push(data: Buffer): void {
			const chunk = data.subarray(Math.max(0, data.length - OUTPUT_LIMIT));
			const first = chunk.copy(buffer, offset);
			if (first < chunk.length) chunk.copy(buffer, 0, first);
			full ||= offset + chunk.length >= OUTPUT_LIMIT;
			offset = (offset + chunk.length) % OUTPUT_LIMIT;
		},
		text(): string {
			if (!full) return buffer.toString("utf8", 0, offset);
			return Buffer.concat([buffer.subarray(offset), buffer.subarray(0, offset)]).toString("utf8");
		},
	};
}

function clip(text: string, suffix = ""): string {
	const max = LINE_LIMIT - suffix.length;
	return (text.length > max ? `${text.slice(0, max - 1)}…` : text) + suffix;
}

function physicalDirectory(cwd: string): string {
	try {
		return realpathSync.native(cwd);
	} catch {
		return cwd;
	}
}

function projectPathPrefix(cwd: string): RegExp {
	const paths = new Set([cwd, physicalDirectory(cwd)]);
	const alternatives = [...paths]
		.map((path) => path.replace(/\/+$/, "").replace(/[$.*+?^{}()|[\]\\]/g, "\\$&"))
		.join("|");
	return new RegExp(`(^|[\\s("'=:])(?:file://)?(?:${alternatives})/`, "gm");
}

function failureTail(output: string, prefix: RegExp): string[] {
	const lines = stripVTControlCharacters(output)
		.replace(prefix, "$1")
		.split(/\r\n|\n|\r/)
		.map((line) => line.replace(/\p{Cc}/gu, "").trim())
		.filter(Boolean);
	const selected: string[] = [];
	let needFrame = false;
	for (const line of lines) {
		if (FRAME.test(line)) {
			if (needFrame && !DEPENDENCY.test(line)) {
				selected.push(line);
				needFrame = false;
			}
		} else if (FAILURE.test(line)) {
			selected.push(line);
			needFrame = true;
		}
	}
	const unique = new Map<string, { line: string; count: number }>();
	for (const line of selected) {
		const key = line.replace(/\d+/g, "#");
		const item = unique.get(key);
		if (item) item.count++;
		else unique.set(key, { line, count: 1 });
	}
	if (!unique.size) return lines.slice(-TAIL_LINES).map((line) => clip(line));
	return [...unique.values()].slice(-TAIL_LINES).map(({ line, count }) => clip(line, count > 1 ? ` (×${count})` : ""));
}

function startError(cwd: string, error: unknown): string {
	const failure = error as NodeJS.ErrnoException;
	return `could not start in ${cwd}: ${failure.code ?? failure.message ?? String(error)}`;
}

function runCommand(
	command: string,
	cwd: string,
	signal: AbortSignal,
): Promise<{ run: CheckRun; output: string; error?: string }> {
	return new Promise((resolve) => {
		const started = performance.now();
		const output = captureOutput();
		const run = (exitCode: number | null, signal: NodeJS.Signals | null): CheckRun => ({
			command,
			cwd,
			exitCode,
			signal,
			ms: Math.round(performance.now() - started),
		});
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn("/bin/sh", ["-c", command], {
				cwd,
				detached: true,
				env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			resolve({ run: run(null, null), output: "", error: startError(cwd, error) });
			return;
		}
		for (const pipe of [child.stdout, child.stderr]) pipe?.on("data", output.push);
		let problem: string | undefined;
		const killGroup = (reason: string): void => {
			problem ??= reason;
			if (child.pid !== undefined) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch (error) {
					const failure = error as NodeJS.ErrnoException;
					if (failure.code !== "ESRCH") problem += `; could not kill check process group: ${failure.message}`;
				}
			}
			for (const pipe of [child.stdout, child.stderr]) pipe?.destroy();
		};
		const cancel = () => killGroup(CANCELED);
		const timer = setTimeout(() => killGroup("timed out after 5 minutes"), TIME_LIMIT_MS);
		signal.addEventListener("abort", cancel, { once: true });
		let spawnFailed = false;
		child.once("error", (error) => {
			spawnFailed = true;
			problem ??= startError(cwd, error);
		});
		child.once("close", (code, killedBy) => {
			clearTimeout(timer);
			signal.removeEventListener("abort", cancel);
			resolve({
				run: run(spawnFailed ? null : code, killedBy),
				output: output.text(),
				...(problem ? { error: problem } : {}),
			});
		});
		if (signal.aborted) cancel();
	});
}

export async function runChecks(check: ApprovedCheck, signal: AbortSignal): Promise<CheckResult> {
	const runs: CheckRun[] = [];
	const prefix = projectPathPrefix(check.cwd);
	for (const command of check.commands) {
		if (signal.aborted) return { status: "error", runs, error: CANCELED };
		const { run, error, output } = await runCommand(command, check.cwd, signal);
		runs.push(run);
		if (error || run.exitCode !== 0) {
			const tail = failureTail(output, prefix);
			return { status: error ? "error" : "fail", runs, ...(error ? { error } : {}), ...(tail.length ? { tail } : {}) };
		}
	}
	return { status: "pass", runs };
}

export function checkLine(check: CheckResult): string {
	return `check (run by Squire): ${check.status}`;
}

function oneLine(text: string): string {
	return text.replace(/[\p{Cc}\u2028\u2029]/gu, (letter) => JSON.stringify(letter).slice(1, -1));
}

function runLine(run: CheckRun, error: string | undefined): string {
	const command = oneLine(run.command).replaceAll("`", "\\u0060");
	let outcome = "";
	if (error) outcome = `: ${oneLine(error)}`;
	else if (run.signal !== null) outcome = ` signal ${run.signal}`;
	else if (run.exitCode !== 0) outcome = ` exit ${run.exitCode}`;
	return `  \`${command}\`${outcome} (${(run.ms / 1000).toFixed(1)} s)`;
}

export function checkLines(check: CheckResult): string[] {
	return [
		checkLine(check),
		...check.runs.map((run, index) => runLine(run, index === check.runs.length - 1 ? check.error : undefined)),
		...(check.error && !check.runs.length ? [`  ${oneLine(check.error)}`] : []),
		...(check.tail ?? []).map((line) => `    ${line}`),
	];
}
