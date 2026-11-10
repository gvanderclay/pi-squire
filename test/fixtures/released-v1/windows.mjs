// Frozen executable v0.20.2 (c27b082d19662bdca37f5d4fb02e94b3037ed4ac) src/windows.ts.
// Type annotations stripped; only import paths relocated. See README.md.
// Reading tmux's window list against the delegation records.

/** Every window on the server, asked once; a failed ask is `undefined`, never an empty list. */
export async function listWindows(tmux) {
	try {
		return await tmux.listWindows();
	} catch {
		return undefined;
	}
}

export async function listPanes(tmux) {
	try {
		return await tmux.listPanes();
	} catch {
		return undefined;
	}
}

/** The window a delegation owns: one with both its recorded id and its recorded name, since ids restart with every tmux server. */
export function ownWindow(windows, record) {
	return windows.find((window) => window.id === record.windowId && window.name === record.windowName);
}

/** What the listing says about a delegation's window; a matching window whose program exited counts as gone. */
export function windowState(windows, record) {
	if (windows === undefined) return "unknown";
	const own = ownWindow(windows, record);
	return own !== undefined && !own.exited ? "open" : "gone";
}
