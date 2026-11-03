// Event-derived presentation only. No transcript replay, intent or task state.
import { stripVTControlCharacters } from "node:util";

export type Activity = { text: string; target?: string };
export const ACTIVITY_TEXT_BYTES = 512;
const BUFFER_BYTES = 2048;
const MAX_CALLS = 256;

export function byteTail(value: string, max: number): string {
	const characters: string[] = [...value.slice(-max * 2)];
	let bytes = 0;
	let first = characters.length;
	while (first > 0) {
		const size: number = Buffer.byteLength(characters[first - 1]);
		if (bytes + size > max) break;
		bytes += size;
		first--;
	}
	return characters.slice(first).join("");
}

/** Also applied at the reader/render boundary; foreign text never supplies terminal controls. */
export function activityText(value: string, max = ACTIVITY_TEXT_BYTES): string {
	const bounded: string = byteTail(value, BUFFER_BYTES);
	const clean: string = [...stripVTControlCharacters(bounded)]
		.map((character) => {
			const code: number = character.codePointAt(0) ?? 0;
			return code < 32 || (code >= 127 && code <= 159) ? " " : character;
		})
		.join("")
		.replace(/\s+/g, " ")
		.trim();
	return byteTail(clean, max);
}

type Call = { name: string; parent?: string; target?: string };
const TARGET_KEYS: ReadonlyMap<string, string> = new Map([
	["read", "path"],
	["edit", "path"],
	["write", "path"],
]);

function toolTarget(name: string, args: unknown): string | undefined {
	const key = TARGET_KEYS.get(name);
	if (!key || !args || typeof args !== "object" || Array.isArray(args)) return;
	const value: unknown = (args as Record<string, unknown>)[key];
	if (typeof value !== "string") return;
	return activityText(value, 120) || undefined;
}
const LABELS: ReadonlyMap<string, string> = new Map([
	["read", "reading…"],
	["edit", "editing…"],
	["write", "writing…"],
	["bash", "running…"],
]);

export class ActivityCollector {
	private readonly calls = new Map<string, Call>();
	private composing = false;
	private suppressed = false;

	clear(): void {
		this.calls.clear();
		this.composing = false;
		this.suppressed = false;
	}

	start(id: string, name: string, parent?: string, args?: unknown): void {
		if (this.calls.has(id) || this.suppressed) return;
		if (this.calls.size >= MAX_CALLS || !this.validId(id) || (parent !== undefined && !this.validId(parent))) {
			this.suppressed = true;
			this.calls.clear();
			return;
		}
		this.calls.set(id, { name: activityText(name, 128), parent, target: toolTarget(name, args) });
	}

	end(id: string): void {
		this.calls.delete(id);
	}

	messageStart(): void {
		this.composing = true;
	}

	snapshot(): Activity | undefined {
		if (this.suppressed) return;
		if (this.calls.size) {
			const parents = new Set([...this.calls.values()].map((call) => call.parent));
			const leaves: Call[] = [...this.calls].filter(([id]) => !parents.has(id)).map(([, call]) => call);
			const call = leaves.at(-1);
			if (call) return { text: LABELS.get(call.name) ?? `using ${call.name || "tool"}…`, target: call.target };
		}
		if (this.composing) return { text: "thinking…" };
		return;
	}

	private validId(id: string): boolean {
		return id.length > 0 && Buffer.byteLength(id) <= 512;
	}
}
