// Herdr pane/tab ids survive restoration; terminal_id is the incarnation fence.
export type HerdrLocator = {
	adapter: "herdr";
	version: 1;
	kind: "window";
	session: string;
	socket: string;
	workspace: string;
	tab: string;
	pane: string;
	terminal: string;
	name: string;
	launchFile: string;
};
const bounded = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 4096;
export function herdrLocator(value: unknown): HerdrLocator | undefined {
	if (!value || typeof value !== "object") return undefined;
	const own = value as Partial<HerdrLocator>;
	return own.adapter === "herdr" &&
		own.version === 1 &&
		own.kind === "window" &&
		[own.session, own.socket, own.workspace, own.tab, own.pane, own.terminal, own.name, own.launchFile].every(bounded)
		? (own as HerdrLocator)
		: undefined;
}
export function sameHerdrLocator(a: HerdrLocator, b: HerdrLocator): boolean {
	return (
		a.session === b.session &&
		a.socket === b.socket &&
		a.workspace === b.workspace &&
		a.tab === b.tab &&
		a.pane === b.pane &&
		a.terminal === b.terminal &&
		a.launchFile === b.launchFile
	);
}
