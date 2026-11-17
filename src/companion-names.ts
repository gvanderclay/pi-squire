// Shared companion naming: a project's preferred base plus numbered
// alternatives. tmux and Rex select from it, but each proves ownership its own
// way (tmux's session option, Rex's creation receipts); a name is never proof.

/** The name a companion candidate number takes: base, base-2, base-3, ... */
export function companionLabel(base: string, number: number): string {
	return number === 1 ? base : `${base}-${number}`;
}

/** The candidate number a name takes under this base, or undefined when it is not a candidate. */
export function companionNumber(base: string, name: string): number | undefined {
	if (name === base) return 1;
	if (!name.startsWith(`${base}-`)) return undefined;
	const rest = name.slice(base.length + 1);
	return /^[2-9]$|^[1-9][0-9]+$/.test(rest) ? Number(rest) : undefined;
}

/** Pick a managed candidate before any free name, in numeric candidate order. */
export function companionCandidate(base: string, sessions: ReadonlyMap<string, boolean>): string {
	const candidates = [...sessions.keys()]
		.filter((name) => companionNumber(base, name) !== undefined)
		.sort((a, b) => (companionNumber(base, a) ?? 0) - (companionNumber(base, b) ?? 0));
	const managed = candidates.find((name) => sessions.get(name) === true);
	if (managed !== undefined) return managed;
	let number = 1;
	while (sessions.has(companionLabel(base, number))) number++;
	return companionLabel(base, number);
}
