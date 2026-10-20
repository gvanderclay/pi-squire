# Persistent delegate indicators in Pi 1.0.0–1.3.0

## Question and short answer

Which extension UI should pi-squire use inside a delegate to show its identity and changing auto-exit setting? **Recommend `ctx.ui.setStatus("pi-squire", "delegate · auto-exit: on/off")`, initialized on every `session_start` and updated when the setting changes.** It composes with other keyed statuses without taking over the editor or footer, and the complete `ExtensionUIContext` declaration is identical in 1.0.0 and 1.3.0. Its limitations are a shared, width-truncated footer line and custom footers that may ignore statuses. A keyed one-line `setWidget` is the more prominent alternative, independent of custom footers. [S1][S2][S3][S4][C1]

Checked **2026-10-20**: published `@earendil-works/pi-coding-agent@1.3.0` (changelog release date 2026-10-15), installed coding-agent **1.0.0**, and `@earendil-works/pi-tui` **1.0.0 and 1.3.0** for editor and terminal details. These are primary published artifacts, not assumptions based on current GitHub `main`. Local pi-squire was at `b721b9e`; no code was changed. [S10][C1][C2]

## 1. `ctx.ui.setStatus(key, text)`

- **Position:** The built-in footer renders the working-directory/session information line first, token/cost/context/model statistics second, and, when the status map is nonempty, **one additional line below both** for all extensions. It is not appended to the model/token line. The editor-area layout is above-editor widgets → editor → below-editor widgets → footer. [S2:246–263][S3:695–699]
- **Ordering:** Entries are sorted by `a.localeCompare(b)` on their **keys**, then their text values are joined with a single space. This is locale-aware alphabetical key ordering, not registration or insertion order. There is no separator other than that space and no automatic extension-name prefix. [S2:253–262]
- **Updating/clearing:** The key indexes a shared `Map`; setting the same key replaces its value; `undefined` deletes it. There is no per-extension namespace isolation, so choose a distinctive key such as `pi-squire`. Each call requests a render; there is no expiration timer. [S4:117–138][S3:1772–1775]
- **Width:** There is no separate per-status character budget or reserved space. The concatenated line is truncated to the footer's supplied width using ANSI-aware `truncateToWidth`, with a dim `...` suffix. Consequently late-sorting statuses can disappear on narrow screens. Newline, carriage return, and tab become spaces; repeated spaces collapse and ends are trimmed. Despite its broader comment, the actual sanitizer does **not** strip every control character. [S2:6–15,253–262]
- **Colors:** ANSI/theme styling is supported, not stripped. The checked official example uses `ctx.ui.theme.fg("accent", "●")`, `fg("dim", ...)`, and `fg("success", ...)` in `setStatus`. Prefer semantic colors, but do not rely on color alone to distinguish on/off. **Theme caveat:** stored ANSI strings do not automatically recolor when the theme changes; the TUI docs advise rebuilding stored themed strings on invalidation. Plain text avoids that concern for this small indicator. [S5:13–30][S6, “Apply themes correctly”]
- **Modes:** In TUI mode this updates the footer data. **RPC is not a no-op:** it emits a fire-and-forget `extension_ui_request` with `method: "setStatus"`, `statusKey`, and `statusText`; the client chooses whether to display it. Print and JSON modes have no UI and use no-op UI methods. `ctx.hasUI` is true in both TUI and RPC; use `ctx.mode === "tui"` if the desired behavior is strictly terminal-only. [S3:2060][S7:101–110][S8][S9:128–146][S11, “UI and modes”]
- **Custom footer caveat:** `setStatus` still records the data, but a replacement footer must explicitly render `footerData.getExtensionStatuses()`. The official custom-footer example receives that provider but does not actually render statuses, demonstrating that visibility is not guaranteed with custom footers. [S1:105–114][S12:24–55]

These status behavior paths and RPC forwarding are unchanged between the two inspected versions; the built-in footer implementation and RPC mode file are byte-identical. [C1]

## 2. Alternatives and coexistence

### `setWidget(key, content, { placement })`

This shows persistent content in the editor area, defaulting to `"aboveEditor"`; `"belowEditor"` places it between the editor and footer. Above-editor widgets have a leading blank spacer; below-editor widgets do not. A string array is wrapped in `Text` components with horizontal padding of one column, or a factory can return a full component. Both forms are supported in the TUI. [S1:46–52,100–104][S3:1853–1888,1930–1953][S13]

Widgets coexist by distinct shared keys, but reusing a key disposes and removes its old widget from **both** placement maps. Within each placement they render in `Map.values()` insertion order, not alphabetical order; updating an existing key removes and reinserts it, moving it to the end. The string-array implementation keeps the first **10 input lines per widget**, then adds a muted `... (widget truncated)` line. The source comment says “Maximum total widget lines,” but the actual code does not enforce a ten-line aggregate limit across widgets or factory components; use the implementation, not that comment, as the behavioral evidence. [S3:1853–1897,1930–1953]

RPC forwards only string arrays and clears; factories are ignored. Print/JSON are no-ops. Replacing a keyed widget affects no other distinct key and does not replace the footer/editor. A widget is therefore the recommendation if prominence and compatibility with arbitrary custom footers outweigh consuming another row. [S7:123–142][S8][S9:143][S3:1853–1897]

### `setFooter(factory | undefined)`

This **replaces the entire footer**, not one slot. The previous custom footer is disposed, the footer container is cleared, and the new component is installed; `undefined` restores the built-in footer, not some earlier extension's custom footer. It is a single global override, so extensions clobber each other. The factory gets `(tui, theme, footerData)` and must itself choose whether to show git branch, other extensions' statuses, token/context/model information, and width handling. RPC, print, and JSON do not support custom footers. Avoid it for a delegate badge. [S1:105–114][S3:1958–1975][S7:137–142][S8][S12]

### `setTitle(title)`

This changes the terminal window/tab title, **not text inside Pi's TUI**. TUI forwarding calls the terminal's `setTitle`, which writes OSC 0 (`ESC ] 0 ; title BEL`). There is one title, no keyed composition, and no `undefined` restore API. Other extensions and Pi itself can overwrite it: Pi updates its normal title on initialization/rebind/reset and `session_info_changed` (for example, session renaming). It can supplement but should not replace an in-TUI indicator. RPC forwards a `setTitle` request; print/JSON are no-ops. Whether a particular tmux/terminal configuration displays that title is **unknown** here; no terminal integration test was run. [S1:118–119][S3:814–823,1607,1919,2073,2818–2821][S7:143–150][S14:455–458][S9:146]

### `setHeader(factory | undefined)`

This replaces the startup header **above the chat transcript**, not a pinned editor-area badge. It is a single global override and disposes a preceding custom header; `undefined` restores the built-in header, not another extension's prior header. It is not supported in RPC/print/JSON. The implementation ignores a call before the built-in header exists, another reason to use `session_start`. Avoid it for constantly visible state near the prompt. [S1:115–117][S3:1979–2013][S7:140–142][S9:145]

### Editor border or label

There is **no `ctx.ui.setEditorLabel` or dedicated editor-border badge method** in either inspected `ExtensionUIContext`. The supported route is `setEditorComponent(factory)`, a global editor replacement; `getEditorComponent()` exposes the current custom factory, and clearing it restores the default, not a stack of prior editors. Pi recommends subclassing exported `CustomEditor` to retain app controls. Replacing it simply to show a label risks overriding another editor extension. [S1:150–203][C1][S6, “Handle keyboard input and focus”][S3:2242–2303]

The underlying `Editor` exposes `borderColor` and protected `renderTopBorder(width, hiddenLineCount)`. A custom subclass could draw a label, but this is custom rendering rather than a composable badge API; Pi copies the default editor border color onto a replacement and updates border colors for bash/thinking modes. `CustomEditor` also has `embedWorkingStatus` and `setWorkingStatusIndicator` for Pi's working/compaction/retry status in the top border, not a separately keyed persistent extension label. The editor declarations and `CustomEditor` declaration are unchanged between the checked versions. [S15][S16][S3:2257–2259,3697–3701][C1]

### Other UI mechanisms and additions in 1.1–1.3

- `setWorkingMessage`, `setWorkingVisible`, and `setWorkingIndicator` customize the shared **during-streaming** working indicator; they are not persistent idle-state indicators and are not keyed. `setHiddenThinkingLabel` changes hidden-thinking text, not session identity. These methods already existed in 1.0.0. [S1:85–99][C1]
- `notify` is non-blocking feedback, not a keyed persistent badge. `custom()` is intended for a temporary interactive screen/overlay and can take input focus; it is unnecessary ownership/lifecycle work for this indicator. [S1:79–82,120–134][S6, “Choose an integration point” and “Use custom screens and overlays”]
- **1.1.0 added OSC 7501 program status reporting**, automatically driven by Pi's working/blocked/done/error/idle state. It is external terminal/dashboard metadata, not an extension API for arbitrary delegate/on-off text. It normally requires terminal support negotiation; the docs say tmux/screen do not forward it, with `PI_PROGRAM_STATUS=1` available to force transmission. [S10:114–137][S17, “Program status”]
- No persistent badge/UI-context API was added in 1.1–1.3: the entire UI interface is byte-identical across the endpoints. The newer tool-renderer API present in 1.3 affects transcript tool calls, not a persistent session indicator. The 1.2 custom-editor compaction-color fix and 1.3 custom-overlay cleanup fix do not provide another badge slot. [C1][S10:100,47][S1:1252–1255]

## 3. Lifecycle and survival

**`session_start` is the correct earliest ordinary session-context hook.** The factory receives `pi`, not an `ExtensionContext`; register handlers there. Pi starts the terminal UI before binding extensions, then applies UI bindings before emitting `session_start`. The official status example initializes there. Other session handlers and command handlers can update UI thereafter, using their supplied current context. [S11, “Respect the runtime lifecycle”][S3:705–706][S18:2630–2653][S5:13–15]

`SessionStartEvent.reason` is already the same in 1.0.0 and 1.3.0:

```typescript
"startup" | "reload" | "new" | "resume" | "fork"
```

`previousSessionFile` is present for new/resume/fork. The initial agent-session event defaults to `startup`; opening an existing session from the CLI still initializes that runtime with `startup`, whereas an in-process session replacement uses resume/new/fork. `/reload` emits `reload`. Do not listen for removed historical `session_switch`/`session_fork` post-transition events; the consolidated `session_start` contract predates 1.0.0. [S1:574–581][S18:200,2999][S19:126–166,195–247][S20:590–591,681][S10:2817][C1]

**UI state does not survive these transitions automatically.** `/reload` calls `resetExtensionUI`, clearing statuses and widgets, restoring default footer/header/editor and resetting the title. `ctx.reload()` uses that same interactive reload handler. New/resume/fork replacement runs the before-invalidate callback, which also resets extension UI. Each new runtime receives `session_start` and should reapply the badge. A cancelled switch does not run the replacement teardown. This behavior also exists in the checked 1.0.0 paths. [S3:366–371,1528–1530,1898–1929,5378][S19:79–112,126–166][C1]

Repainting the badge and preserving the **meaning** of the badge are separate tasks. pi-squire's `armed` boolean is currently initialized from the environment in the extension runtime, so reload/session-runtime recreation can reset it to the launch default; displaying it does not make a user's changed setting durable. If persistence across reload/resume is required, that is a separate design decision (the extension docs offer `appendEntry` for durable non-context session state). Do not silently claim that a startup-only setter or an in-memory boolean preserves the user's choice across transitions. [P1:120–127,180–186][S11, “State”][S19:126–166][S18:2972–2999]

## 4. Compatibility with `src/child.ts`

Comparing the complete exported declarations and runner diff found **no breaking signature changes** to the listed child APIs. The only change in the listed event declarations is additive `AgentSettledEvent.aborted: boolean` in 1.1.0. Child code ignoring that field remains valid; code constructing a typed fake event may need to add it. [C1][S10:137][S1:708–711,742–750,796–805,909–921,1231][P1]

| API used by child | 1.0.0 → 1.3.0 finding |
| --- | --- |
| `input` | Unchanged `text`, optional `images`, `source: "interactive" \| "rpc" \| "extension"`, optional `streamingBehavior`. [C1][S1:909–921] |
| `agent_start` | Unchanged notification marking loop start. [C1][S1:742–745] |
| `after_provider_response` | Unchanged numeric `status` and string-valued `headers`; fires before consuming the response stream. [C1][S1:706–711] |
| `agent_end` | Unchanged `messages: AgentMessage[]`; loop end is not final settlement. [C1][S1:746–750][S11, lifecycle] |
| `agent_before_settle` | Unchanged actionable boundary state/results, including continuation and entries. [C1][S1:779–799] |
| `agent_settled` | Adds required `aborted` in 1.1; still final notification after automatic continuation is exhausted. [C1][S1:800–805][S10:137] |
| `registerCommand` | Same signature and handler interface; extension commands execute before prompt input interception. [C1][S1:1231][S18:1609–1627] |
| `ctx.shutdown()` | Same `void` API and runner forwarding; requests orderly shutdown, with TUI deferring exit if busy. [C1][S1:246][S9:674–677][S3:1532–1537] |

**Important input distinction:** `input` is a **submitted prompt** interception event, not a keystroke callback. In `prompt()`, Pi first handles extension slash commands and then emits input; consequently `/auto-exit` can enable the setting without its own submission being treated as ordinary input. If “off when the user types” means immediately on the first keystroke rather than on submission, current `child.ts` does not implement that: `onTerminalInput` is the raw-terminal API, but interpreting all raw sequences as typing is unsafe because they also include navigation/control input. The product requirement needs that distinction before changing behavior. [S18:1595–1627][S1:81–82][P1:133–136,180–186]

**Relevant adjacent change:** 1.2.0 fixed the exact #5581 workaround mentioned in `registerTakeover`: idle custom-message turns now run `before_agent_start` with full prompt preparation. That event now discriminates `messageType: "user" | "custom"`; `prompt` exists only for user turns. Also, the session is busy during startup handlers, and `sendUserMessage` then requires `deliverAs`. These are real neighboring behavior changes but not signature breaks to the child's listed handlers; its takeover already supplies `deliverAs: "steer"`. Removing the workaround is only appropriate after deciding the minimum supported Pi version is 1.2+, not as a consequence of adding a badge. [S10:59–65,89][P1:15–20,78–81]

## Evidence and reproducibility

### Local commands and observed outputs

**[C1] Endpoint comparison, run 2026-10-20.** `node -p 'require("./node_modules/@earendil-works/pi-coding-agent/package.json").version'` → `1.0.0`. Fetched with `cd /tmp/pi-status-research && npm pack @earendil-works/pi-coding-agent@1.3.0 --silent && tar -xzf earendil-works-pi-coding-agent-1.3.0.tgz` → tarball `earendil-works-pi-coding-agent-1.3.0.tgz`. Compared installed `dist/core/extensions/types.d.ts` with fetched equivalent using `diff -u` and a Node script extracting each `export interface` block:

```text
ExtensionUIContext IDENTICAL
SessionStartEvent IDENTICAL
InputEvent IDENTICAL
AgentStartEvent IDENTICAL
AfterProviderResponseEvent IDENTICAL
AgentEndEvent IDENTICAL
AgentBeforeSettleEvent IDENTICAL
AgentSettledEvent CHANGED
```

The settled diff adds only the `aborted: boolean` field and its comment. The full declaration diff leaves `registerCommand`, `RegisteredCommand`, and `shutdown` unchanged. `diff -u` on `dist/modes/interactive/components/footer.js`, `dist/modes/rpc/rpc-mode.js`, and `dist/modes/interactive/components/custom-editor.d.ts` produced no differences. `diff -u` on runner implementation changes only tool-renderer resolution and `before_agent_start` trigger construction, not input or shutdown handling. Directly inspected 1.0.0/1.3.0 interactive reset and runtime replacement paths; both clear and rebind UI.

**[C2] Artifact and repository identity.** `date -I` → `2026-10-20`; `git log -5 --oneline` first line → `b721b9e Typed codemode results and annotations for the delegation tools (#47)`. `npm view @earendil-works/pi-coding-agent@1.3.0 dist.integrity` → `sha512-V/WoCjA2hQSe3QLWIUB24cTRdtEdeLiIzkDqU5RMXV6VWuD+KGZnzVBMhglwdnQTySkehZsjt8a3g6Jd2g4nnw==`. The registry returned no `gitHead` for 1.3.0, so this report pins that release by npm version/artifact rather than inventing a commit. `npm view @earendil-works/pi-coding-agent@1.0.0 gitHead` → `a13d35a742c6ef8462812a28fbe1d8c8b7431c32`. TUI 1.3.0 fetched with `npm pack @earendil-works/pi-tui@1.3.0 --silent`; `diff -u` against installed TUI 1.0.0 `dist/components/editor.d.ts` produced no differences.

### Primary source index

Line references above refer to the exact published files below. All URL sources are version-pinned; local pi-squire lines refer to commit `b721b9e`.

- [S1] [coding-agent 1.3.0 extension declarations](https://unpkg.com/@earendil-works/pi-coding-agent@1.3.0/dist/core/extensions/types.d.ts); [1.0.0 counterpart](https://unpkg.com/@earendil-works/pi-coding-agent@1.0.0/dist/core/extensions/types.d.ts).
- [S2] [1.3.0 built-in footer implementation](https://unpkg.com/@earendil-works/pi-coding-agent@1.3.0/dist/modes/interactive/components/footer.js).
- [S3] [1.3.0 interactive mode implementation](https://unpkg.com/@earendil-works/pi-coding-agent@1.3.0/dist/modes/interactive/interactive-mode.js); [1.0.0 counterpart](https://unpkg.com/@earendil-works/pi-coding-agent@1.0.0/dist/modes/interactive/interactive-mode.js).
- [S4] [1.3.0 footer data provider](https://unpkg.com/@earendil-works/pi-coding-agent@1.3.0/dist/core/footer-data-provider.js).
- [S5] [1.3.0 checked status-line example](https://unpkg.com/@earendil-works/pi-coding-agent@1.3.0/examples/extensions/status-line.ts).
- [S6] [1.3.0 TUI documentation](https://unpkg.com/@earendil-works/pi-coding-agent@1.3.0/docs/tui.md).
- [S7] [1.3.0 RPC mode implementation](https://unpkg.com/@earendil-works/pi-coding-agent@1.3.0/dist/modes/rpc/rpc-mode.js).
- [S8] [1.3.0 RPC extension UI protocol documentation](https://unpkg.com/@earendil-works/pi-coding-agent@1.3.0/docs/rpc-extension-ui.md).
- [S9] [1.3.0 extension runner](https://unpkg.com/@earendil-works/pi-coding-agent@1.3.0/dist/core/extensions/runner.js), including no-op UI at lines 128–146 and shutdown forwarding at 674–677.
- [S10] [1.3.0 package changelog](https://unpkg.com/@earendil-works/pi-coding-agent@1.3.0/CHANGELOG.md).
- [S11] [1.3.0 extension documentation](https://unpkg.com/@earendil-works/pi-coding-agent@1.3.0/docs/extensions.md).
- [S12] [1.3.0 checked custom-footer example](https://unpkg.com/@earendil-works/pi-coding-agent@1.3.0/examples/extensions/custom-footer.ts).
- [S13] [1.3.0 checked widget-placement example](https://unpkg.com/@earendil-works/pi-coding-agent@1.3.0/examples/extensions/widget-placement.ts).
- [S14] [pi-tui 1.3.0 terminal implementation](https://unpkg.com/@earendil-works/pi-tui@1.3.0/dist/terminal.js).
- [S15] [pi-tui 1.3.0 editor declarations](https://unpkg.com/@earendil-works/pi-tui@1.3.0/dist/components/editor.d.ts), `borderColor` lines 26/44 and protected border renderer at 97.
- [S16] [coding-agent 1.3.0 CustomEditor declarations](https://unpkg.com/@earendil-works/pi-coding-agent@1.3.0/dist/modes/interactive/components/custom-editor.d.ts).
- [S17] [1.3.0 terminal documentation](https://unpkg.com/@earendil-works/pi-coding-agent@1.3.0/docs/terminal-setup.md), “Program status”.
- [S18] [1.3.0 agent-session implementation](https://unpkg.com/@earendil-works/pi-coding-agent@1.3.0/dist/core/agent-session.js).
- [S19] [1.3.0 runtime replacement implementation](https://unpkg.com/@earendil-works/pi-coding-agent@1.3.0/dist/core/agent-session-runtime.js); [1.0.0 counterpart](https://unpkg.com/@earendil-works/pi-coding-agent@1.0.0/dist/core/agent-session-runtime.js).
- [S20] [1.3.0 CLI startup implementation](https://unpkg.com/@earendil-works/pi-coding-agent@1.3.0/dist/main.js).
- [P1] [pi-squire `src/child.ts` at b721b9e](https://github.com/gvanderclay/pi-squire/blob/b721b9e/src/child.ts), especially lines 120–186.

## Unsettled / not checked

- **Unknown:** actual rendering under the user's selected terminal, tmux options, custom footer, and terminal widths. This was source/type/documentation research, not a live TUI test.
- **Unknown requirement:** whether “user types” means raw keystrokes or submitting input, and whether the on/off choice must persist across reload/resume/new/fork. The report identifies the current contracts rather than choosing new product behavior.
