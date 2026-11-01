// Event-derived presentation only. No transcript replay, intent or task state.
import { stripVTControlCharacters } from "node:util";

export type Activity = { kind: "tools" | "response"; text: string };
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

type Call = { name: string; parent?: string };
const LABELS: ReadonlyMap<string, string> = new Map([
	["read", "reading…"],
	["edit", "editing…"],
	["write", "writing…"],
	["bash", "command call…"],
]);

export class ActivityCollector {
	private readonly calls = new Map<string, Call>();
	private text = "";
	private message = false;
	private suppressed = false;

	clear(): void {
		this.calls.clear();
		this.text = "";
		this.message = false;
		this.suppressed = false;
	}

	start(id: string, name: string, parent?: string): void {
		this.text = "";
		if (this.calls.has(id) || this.suppressed) return;
		if (this.calls.size >= MAX_CALLS || !this.validId(id) || (parent !== undefined && !this.validId(parent))) {
			this.suppressed = true;
			this.calls.clear();
			return;
		}
		this.calls.set(id, { name: activityText(name, 128), parent });
	}

	end(id: string): void {
		this.calls.delete(id);
	}

	messageStart(): void {
		this.text = "";
		this.message = true;
	}

	delta(text: string): void {
		if (this.message && !this.suppressed) this.text = byteTail(this.text + byteTail(text, BUFFER_BYTES), BUFFER_BYTES);
	}

	messageEnd(): void {
		this.text = "";
		this.message = false;
	}

	snapshot(): Activity | undefined {
		if (this.suppressed) return;
		if (this.calls.size) {
			const parents = new Set([...this.calls.values()].map((call) => call.parent));
			const leaves: Call[] = [...this.calls].filter(([id]) => !parents.has(id)).map(([, call]) => call);
			const labels: string[] = [
				...new Set(leaves.reverse().map((call) => LABELS.get(call.name) ?? `using ${call.name || "tool"}…`)),
			];
			return { kind: "tools", text: activityText(labels.slice(0, 2).join(" · ")) };
		}
		const text: string = activityText(this.text);
		if (text) return { kind: "response", text };
		return;
	}

	private validId(id: string): boolean {
		return id.length > 0 && Buffer.byteLength(id) <= 512;
	}
}
