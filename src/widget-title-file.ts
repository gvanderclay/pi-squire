// Read foreign native metadata without opening (and potentially migrating) a SessionManager.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

type Title = { name: string | undefined; modified: number };
type Cursor = {
	ino: number;
	size: number;
	modified: number;
	offset: number;
	pending: Buffer;
	skipLine: boolean;
	header: boolean;
	valid: boolean;
	name: string | undefined;
};
const CHUNK_BYTES = 64 * 1024;
const SCAN_BYTES = 1024 * 1024;

/** Bounded incremental reader. Replacement, truncation and same-size edits restart the scan. */
export class WidgetTitleFiles {
	private readonly files = new Map<string, Cursor>();

	clear(): void {
		this.files.clear();
	}

	read(path: string | undefined, sessionId: string): Title | undefined {
		if (!path) return undefined;
		let fd: number;
		try {
			fd = openSync(path, "r");
		} catch {
			this.files.delete(path);
			return undefined;
		}
		try {
			if (!this.matchesHeader(fd, sessionId)) {
				this.files.delete(path);
				return undefined;
			}
			const stat = fstatSync(fd);
			let cursor: Cursor | undefined = this.files.get(path);
			if (
				!cursor ||
				cursor.ino !== stat.ino ||
				stat.size < cursor.size ||
				(stat.size === cursor.size && stat.mtimeMs !== cursor.modified)
			) {
				cursor = {
					ino: stat.ino,
					size: stat.size,
					modified: stat.mtimeMs,
					offset: 0,
					pending: Buffer.alloc(0),
					skipLine: false,
					header: false,
					valid: false,
					name: undefined,
				};
				this.files.set(path, cursor);
			}
			cursor.size = stat.size;
			cursor.modified = stat.mtimeMs;
			this.scan(fd, cursor, sessionId);
			return cursor.valid ? { name: cursor.name, modified: cursor.modified } : undefined;
		} catch {
			this.files.delete(path);
			return undefined;
		} finally {
			closeSync(fd);
		}
	}

	private matchesHeader(fd: number, sessionId: string): boolean {
		const buffer: Buffer = Buffer.alloc(CHUNK_BYTES);
		const count: number = readSync(fd, buffer, 0, buffer.length, 0);
		const newline: number = buffer.subarray(0, count).indexOf(10);
		if (newline < 0) return false;
		const header: { type?: unknown; id?: unknown } = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
		return header?.type === "session" && header.id === sessionId;
	}

	private scan(fd: number, cursor: Cursor, sessionId: string): void {
		let budget: number = SCAN_BYTES;
		while (cursor.offset < cursor.size && budget > 0) {
			const buffer: Buffer = Buffer.alloc(Math.min(CHUNK_BYTES, cursor.size - cursor.offset, budget));
			const count: number = readSync(fd, buffer, 0, buffer.length, cursor.offset);
			if (!count) return;
			cursor.offset += count;
			budget -= count;
			this.consume(cursor, buffer.subarray(0, count), sessionId);
		}
	}

	private consume(cursor: Cursor, bytes: Buffer, sessionId: string): void {
		const combined: Buffer = Buffer.concat([cursor.pending, bytes]);
		let start = 0;
		for (let end: number = combined.indexOf(10); end !== -1; end = combined.indexOf(10, start)) {
			if (!cursor.skipLine && end - start <= CHUNK_BYTES)
				this.line(cursor, combined.subarray(start, end).toString("utf8"), sessionId);
			cursor.skipLine = false;
			start = end + 1;
		}
		cursor.pending = combined.subarray(start);
		if (cursor.pending.length > CHUNK_BYTES) {
			cursor.pending = Buffer.alloc(0);
			cursor.skipLine = true;
		}
	}

	private line(cursor: Cursor, text: string, sessionId: string): void {
		if (cursor.header && !text.includes('"session_info"')) return;
		let entry: { type?: unknown; id?: unknown; name?: unknown };
		try {
			entry = JSON.parse(text);
		} catch {
			return;
		}
		if (!entry || typeof entry !== "object") return;
		if (!cursor.header) {
			cursor.header = true;
			cursor.valid = entry.type === "session" && entry.id === sessionId;
		} else if (cursor.valid && entry.type === "session_info" && typeof entry.name === "string") {
			cursor.name = entry.name;
		}
	}
}
