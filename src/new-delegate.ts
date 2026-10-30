// The new-delegate form behind `/delegate` with no arguments: pick an agent,
// write the task, name it, then a settings screen for model, thinking,
// auto-exit, working directory and worktree. It collects choices and hands
// them to the same launch the command uses (`start` in `NewDelegateDeps`);
// it opens no window and sends no mail itself.
import {
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type Model,
	type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	fuzzyFilter,
	getKeybindings,
	Input,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	type SettingsListTheme,
} from "@earendil-works/pi-tui";

import { type Agent, isThinking, type Roster, THINKING_LEVELS } from "./agents.ts";
import { resolveDirectory } from "./workspace.ts";

/** What the form asks `/delegate` to start; the fields after `task` are set only when the user changed them. */
export type NewRequest = {
	agent: string;
	task: string;
	label?: string;
	model?: string;
	thinking?: string;
	autoExit?: boolean;
	cwd?: string;
	worktree?: string;
};

/** What the settings screen returns: only the rows the user changed from the defaults. */
export type FormResult = Pick<NewRequest, "model" | "thinking" | "autoExit" | "cwd" | "worktree">;

/** What the form reads from the launch path in `index.ts`. */
export type NewDelegateDeps = {
	/** Why a delegate cannot start now (not inside tmux), or undefined. */
	unavailable(): string | undefined;
	roster(ctx: ExtensionContext): Roster;
	/** The refusal text for an empty roster. */
	noAgents(): string;
	/** The model and thinking `agent` runs on when the request names none: its own, else the parent's. */
	defaults(agent: Agent, ctx: ExtensionContext): { model?: string; thinking: string };
	/** Why `value` is not a usable label, or undefined; the check `--label` gets. */
	labelProblem(value: string): string | undefined;
	/** Start the delegate as `/delegate` would, notifying the start or the refusal. */
	start(request: NewRequest, ctx: ExtensionContext): Promise<void>;
};

type Style = Pick<Theme, "fg">;

type SubmenuDone = (selectedValue?: string) => void;

/** The row ids, in the order shown. */
const START = "start";
const MODEL = "model";
const THINKING = "thinking";
const AUTO_EXIT = "auto-exit";
const CWD = "cwd";
const WORKTREE = "worktree";
const NONE = "(none)";

const ON = "on";
const OFF = "off";

/** Rows the settings list shows at once. */
const VISIBLE = 8;

/** One line of text input with a title, for the directory and the branch. */
class TextPrompt implements Component {
	private readonly input = new Input();
	private readonly title: string;
	private readonly style: Style;

	constructor(title: string, value: string, style: Style, done: (value?: string) => void) {
		this.title = title;
		this.style = style;
		this.input.setValue(value);
		this.input.handleInput("\x05"); // the cursor starts at the end of the value
		this.input.focused = true;
		this.input.onSubmit = (text: string): void => done(text.trim());
		this.input.onEscape = (): void => done(undefined);
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
	}

	invalidate(): void {
		this.input.invalidate();
	}

	render(width: number): string[] {
		return [
			this.style.fg("accent", this.title),
			"",
			...this.input.render(width),
			"",
			this.style.fg("dim", "  Enter to set · Esc to keep the current value"),
		];
	}
}

/** A filter box over a list of models; typing narrows it. */
class ModelPicker implements Component {
	private readonly input = new Input();
	private readonly style: Style;
	private readonly items: SelectItem[];
	private readonly done: (value?: string) => void;
	private list: SelectList;

	constructor(items: SelectItem[], current: string, style: Style, done: (value?: string) => void) {
		this.style = style;
		this.items = items;
		this.done = done;
		this.input.focused = true;
		this.list = this.listOf(items, current);
	}

	/** A list of `items` with `current` selected when it is among them. */
	private listOf(items: SelectItem[], current: string | undefined): SelectList {
		const list = new SelectList(items, 10, {
			selectedPrefix: (text: string): string => this.style.fg("accent", text),
			selectedText: (text: string): string => this.style.fg("accent", text),
			description: (text: string): string => this.style.fg("muted", text),
			scrollInfo: (text: string): string => this.style.fg("dim", text),
			noMatch: (text: string): string => this.style.fg("warning", text),
		});
		const at = items.findIndex((item) => item.value === current);
		if (at >= 0) list.setSelectedIndex(at);
		list.onSelect = (item: SelectItem): void => this.done(item.value);
		list.onCancel = (): void => this.done(undefined);
		return list;
	}

	handleInput(data: string): void {
		const keys = getKeybindings();
		if (
			keys.matches(data, "tui.select.up") ||
			keys.matches(data, "tui.select.down") ||
			keys.matches(data, "tui.select.confirm") ||
			keys.matches(data, "tui.select.cancel")
		) {
			this.list.handleInput(data);
			return;
		}
		this.input.handleInput(data);
		// Fuzzy over the whole id: `SelectList.setFilter` matches the start of the value only.
		this.list = this.listOf(
			fuzzyFilter(this.items, this.input.getValue(), (item) => item.label),
			undefined,
		);
	}

	invalidate(): void {
		this.list.invalidate();
	}

	render(width: number): string[] {
		return [
			this.style.fg("accent", "Model"),
			...this.input.render(width),
			"",
			...this.list.render(width),
			this.style.fg("dim", "  Type to filter · Enter to pick · Esc to keep the current model"),
		];
	}
}

/** The settings screen's own choices; what the user sees and what Start returns. */
export type FormOptions = {
	agent: Agent;
	/** The registry's available models; the agent's default is selected even when it is not among them. */
	models: readonly Model<never>[];
	/** The parent's working directory, which the directory row starts at. */
	cwd: string;
	style: Style;
	/** Why `value` is not a usable working directory, or undefined; the check `--cwd` gets. */
	cwdProblem(value: string): string | undefined;
	done(result: FormResult | undefined): void;
};

/**
 * The settings screen: Start, then a row for each choice, all at the agent's
 * defaults. Start returns the rows the user changed; the rest stay unset, so a
 * form start and a typed `/delegate` with those flags are the same request.
 */
export class SettingsForm implements Component {
	private readonly list: SettingsList;
	private readonly items: SettingItem[];
	private readonly byId = new Map<string, Model<never>>();
	private model: string;
	private thinking: string;
	private autoExit: boolean;
	private cwd: string;
	private worktree = "";
	private status = "";
	private readonly options: FormOptions;

	constructor(options: FormOptions) {
		this.options = options;
		const { agent, models, style } = options;
		for (const model of models) this.byId.set(`${model.provider}/${model.id}`, model);
		this.model = agent.model ?? "";
		this.thinking = agent.thinking ?? "";
		this.autoExit = agent.autoExit;
		this.cwd = options.cwd;
		this.clampInitialThinking();
		const modelItems: SelectItem[] = [...new Set([this.model, ...this.byId.keys()])].map((value) => ({
			value,
			label: value,
		}));
		this.items = [
			{ id: START, label: "Start", currentValue: "▶ launch", values: ["▶ launch"] },
			{
				id: MODEL,
				label: "Model",
				currentValue: this.model,
				description: "Filterable list of the available models.",
				submenu: (current: string, done: SubmenuDone): Component => new ModelPicker(modelItems, current, style, done),
			},
			{
				id: THINKING,
				label: "Thinking",
				currentValue: this.thinking,
				values: this.levels(),
				description: "Only the levels the selected model supports.",
			},
			{
				id: AUTO_EXIT,
				label: "Auto-exit",
				currentValue: this.autoExit ? ON : OFF,
				values: [ON, OFF],
				description: "Close the window once the delegate finishes.",
			},
			{
				id: CWD,
				label: "Working directory",
				currentValue: this.cwd,
				description: "An existing directory. Not with a worktree.",
				submenu: (current: string, done: SubmenuDone): Component =>
					new TextPrompt("Working directory", current, style, done),
			},
			{
				id: WORKTREE,
				label: "Worktree",
				currentValue: NONE,
				description: "A new branch name for a managed worktree; empty for none. Not with another working directory.",
				submenu: (current: string, done: SubmenuDone): Component =>
					new TextPrompt("Worktree branch (empty for none)", current === NONE ? "" : current, style, (value) => {
						if (value === undefined) done(undefined);
						else done(value === "" ? NONE : value);
					}),
			},
		];
		this.list = new SettingsList(
			this.items,
			VISIBLE,
			settingsTheme(style),
			(id: string, value: string): void => this.changed(id, value),
			(): void => options.done(undefined),
		);
	}

	/** The agent's default level, when its default model does not support it: clamped, visibly, and so submitted as an override. */
	private clampInitialThinking(): void {
		const model = this.byId.get(this.model);
		if (model === undefined || !isThinking(this.thinking) || this.levels().includes(this.thinking)) return;
		const clamped = clampThinkingLevel(model, this.thinking as ModelThinkingLevel);
		this.status = `thinking ${this.thinking} is not supported by ${this.model}; now ${clamped}`;
		this.thinking = clamped;
	}

	/** The levels the selected model supports; every level when the model is not in the registry. */
	levels(): string[] {
		const model = this.byId.get(this.model);
		return model === undefined ? [...THINKING_LEVELS] : getSupportedThinkingLevels(model);
	}

	private row(id: string): SettingItem {
		const item = this.items.find((candidate) => candidate.id === id);
		if (item === undefined) throw new Error(`no row ${id}`);
		return item;
	}

	private set(id: string, value: string): void {
		this.row(id).currentValue = value;
		this.list.updateValue(id, value);
	}

	/** Refuse a change: put the row back and say why. */
	private refuse(id: string, value: string, why: string): void {
		this.set(id, value);
		this.status = why;
	}

	private changed(id: string, value: string): void {
		this.status = "";
		if (id === START) this.submit();
		else if (id === MODEL) this.pickModel(value);
		else if (id === THINKING) this.thinking = value;
		else if (id === AUTO_EXIT) this.autoExit = value === ON;
		else if (id === CWD) this.pickCwd(value);
		else if (id === WORKTREE) this.pickWorktree(value === NONE ? "" : value);
	}

	/** A new model narrows the thinking levels; a level it does not support is clamped, and the screen says so. */
	private pickModel(value: string): void {
		this.model = value;
		const model = this.byId.get(value);
		const levels = this.levels();
		this.row(THINKING).values = levels;
		if (model !== undefined && isThinking(this.thinking) && !levels.includes(this.thinking)) {
			const clamped = clampThinkingLevel(model, this.thinking as ModelThinkingLevel);
			this.status = `thinking ${this.thinking} is not supported by ${value}; now ${clamped}`;
			this.thinking = clamped;
			this.set(THINKING, clamped);
		}
	}

	private pickCwd(value: string): void {
		if (value !== this.options.cwd && this.worktree !== "") {
			this.refuse(CWD, this.cwd, "a working directory and a worktree are mutually exclusive; clear the worktree first");
			return;
		}
		const problem = value === this.options.cwd ? undefined : this.options.cwdProblem(value);
		if (problem !== undefined) {
			this.refuse(CWD, this.cwd, problem);
			return;
		}
		this.cwd = value;
	}

	private pickWorktree(value: string): void {
		if (value !== "" && this.cwd !== this.options.cwd) {
			this.refuse(
				WORKTREE,
				this.worktree === "" ? NONE : this.worktree,
				"a worktree and a changed working directory are mutually exclusive; reset the working directory first",
			);
			return;
		}
		this.worktree = value;
	}

	private submit(): void {
		if (this.worktree !== "" && this.cwd !== this.options.cwd) {
			this.status = "a working directory and a worktree are mutually exclusive; name only one";
			return;
		}
		const problem = this.cwd === this.options.cwd ? undefined : this.options.cwdProblem(this.cwd);
		if (problem !== undefined) {
			this.status = problem;
			return;
		}
		this.options.done({
			...(this.model === (this.options.agent.model ?? "") ? {} : { model: this.model }),
			...(this.thinking === (this.options.agent.thinking ?? "") ? {} : { thinking: this.thinking }),
			...(this.autoExit === this.options.agent.autoExit ? {} : { autoExit: this.autoExit }),
			...(this.cwd === this.options.cwd ? {} : { cwd: this.cwd }),
			...(this.worktree === "" ? {} : { worktree: this.worktree }),
		});
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}

	invalidate(): void {
		this.list.invalidate();
	}

	render(width: number): string[] {
		const lines = this.list.render(width);
		return this.status === "" ? lines : [...lines, "", this.options.style.fg("warning", `  ${this.status}`)];
	}
}

/** The list's colours, from the session's theme. */
function settingsTheme(style: Style): SettingsListTheme {
	return {
		label: (text: string, selected: boolean): string => (selected ? style.fg("accent", text) : text),
		value: (text: string, selected: boolean): string => (selected ? style.fg("accent", text) : style.fg("muted", text)),
		description: (text: string): string => style.fg("dim", text),
		cursor: style.fg("accent", "→ "),
		hint: (text: string): string => style.fg("dim", text),
	};
}

/** `value` as a problem message, or undefined when it names a usable existing directory (the `--cwd` check). */
function cwdProblem(value: string, base: string): string | undefined {
	try {
		resolveDirectory(value, base);
		return undefined;
	} catch (err) {
		return (err as Error).message;
	}
}

/** Run the form for `ctx` and start the delegate it describes; a cancelled step ends it quietly. */
export async function startNewDelegate(ctx: ExtensionContext, deps: NewDelegateDeps): Promise<void> {
	const fail = (message: string): void => ctx.ui.notify(`delegate: ${message}`, "error");
	const unavailable = deps.unavailable();
	if (unavailable !== undefined) return fail(unavailable);
	const roster = deps.roster(ctx);
	if (roster.agents.length === 0) return fail(deps.noAgents());
	const options = roster.agents.map(
		(agent) =>
			`${agent.name}${agent.displayName === undefined ? "" : ` (${agent.displayName})`} — ${agent.description}`,
	);
	const picked = await ctx.ui.select("New delegate: agent", options);
	const agent = roster.agents[options.indexOf(picked ?? "")];
	if (agent === undefined) return;
	const task = await ctx.ui.editor(`Task for ${agent.name}`);
	if (task === undefined) return;
	if (task.trim() === "") return fail("a task is required");
	const typed = await ctx.ui.input(
		`Label (optional; empty for ${agent.displayName ?? agent.name}-<id>)`,
		"letters, digits, _ or -",
	);
	if (typed === undefined) return;
	const label = typed.trim() === "" ? undefined : typed.trim();
	const badLabel = label === undefined ? undefined : deps.labelProblem(label);
	if (badLabel !== undefined) return fail(badLabel);
	const chosen = await ctx.ui.custom<FormResult | undefined>(
		(_tui, theme, _keys, done): Component =>
			new SettingsForm({
				// The rows start at what a request naming nothing runs on.
				agent: { ...agent, ...deps.defaults(agent, ctx) } as Agent,
				models: ctx.modelRegistry.getAvailable() as Model<never>[],
				cwd: ctx.cwd,
				style: theme,
				cwdProblem: (value: string): string | undefined => cwdProblem(value, ctx.cwd),
				done,
			}),
	);
	if (chosen === undefined) return;
	await deps.start({ agent: agent.name, task, ...(label === undefined ? {} : { label }), ...chosen }, ctx);
}
