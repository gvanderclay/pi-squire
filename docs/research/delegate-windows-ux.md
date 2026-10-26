# Where delegate windows live and how the user reaches them: how other tools do it

## Question and short answer

Where do agent-delegation tools put a child's terminal (same tmux session, a separate session, a pane, a popup, another multiplexer, or no terminal at all), how does the user reach it from the parent, and what does each choice cost in robustness?

**No audited Pi subagent library creates a dedicated tmux session, and none uses `display-popup` or `switch-client`.** A ripgrep for `new-session`, `display-popup`, `switch-client`, `remain-on-exit`, `has-session` and `detach-on-destroy` over the non-test source of edxeth, nicobailon, giuseppecrj, HenryQW and the other clones found no hit (the `TMUX*` strip in edxeth's `child-env.ts` is the nearest). The Pi libraries fall into three groups:

1. **In-process, no terminal** (tintinweb, gotgenes, championswimmer, bermudi, kvidzibo; mavam as far as read). Navigation is a Pi TUI widget plus an overlay viewer, not a multiplexer.
2. **Herdr** (giuseppecrj, asermax, HenryQW, boadij, nicobailon's project panes, edxeth's Herdr backend, comput-sh/pi-intercom). Children get a pane in an extension-owned tab or a dedicated tab, always `--no-focus`; Herdr itself is the navigator.
3. **tmux** (edxeth only as a launcher; nicobailon as an inspector). edxeth opens a **split pane in the parent's own window**, and falls back to a detached `new-window` in the current session. Nothing then helps the user jump: the pane or window just exists.

The non-Pi tools that are built on tmux split the other way. **Claude Squad and Uzi create one detached tmux *session* per agent** (`new-session -d`); **workmux defaults to one *window* per task in the current session and has a `mode: session` knob**; **Claude Code agent teams split the user's own tmux window into panes** and default to in-process. Their navigation is always a dashboard of their own (a TUI list, `cs`, `claude agents`, workmux dashboard), not tmux's picker. Claude Code background agents show the pattern closest to goal 2: `claude agents` lists sessions, **Space peeks, Enter attaches, Left detaches**, and none of it needs tmux.

The tmux man page and a probe against tmux 3.7b (below) settle the robustness questions that matter for the shared-session and dedicated-session options: a session dies when its last window closes, `new-window -t <missing>:` fails, `new-session -A -d` is *not* a safe "create if missing" when the session exists, and `switch-client` needs a client it can find.

## Date, versions, method

Checked **2026-10-26 UTC**. Local tmux **3.7b**; local Pi libraries are shallow clones at the HEAD below (not necessarily the npm version). Claims cite `repo@sha:path:line`. Tests were not run for the libraries; behaviour is read from source and docs. The tmux probe ran on a private socket (`tmux -L sqprobe -f /dev/null`) and was killed afterwards. Web sources were fetched on the date above.

Discovery for Pi libraries: the list in `docs/research/parent-waiting-guidance.md` and `docs/research/subagent-resume.md`, plus ripgrep for `tmux|zellij|wezterm|kitty|display-popup|switch-client|new-window|split-window|herdr` over each clone's non-test source. A search that finds nothing does not prove absence.

| Library | Pin |
| --- | --- |
| edxeth/pi-subagents | [`cf6dbf41`](https://github.com/edxeth/pi-subagents/tree/cf6dbf41c17986f3882e6804a68e8fb8282d25e6) |
| nicobailon/pi-subagents | [`d9c5ca29`](https://github.com/nicobailon/pi-subagents/tree/d9c5ca29d881ee173681cafb66af1cc774285276) |
| tintinweb/pi-subagents | [`ca93a524`](https://github.com/tintinweb/pi-subagents/tree/ca93a5247e72e7053fcd10bea7125d6c4205f949) |
| gotgenes/pi-packages, `packages/pi-subagents` | [`109efb72`](https://github.com/gotgenes/pi-packages/tree/109efb7244e89e8cd6d7e2e1f0aba54f7f053e6f) |
| giuseppecrj/pi-herdr-agents | [`8864764e`](https://github.com/giuseppecrj/pi-herdr-agents/tree/8864764e65a469f7d90f9a0deb39ec3f0b26befc) |
| asermax/herdr-subagents | [`058fd5f1`](https://github.com/asermax/herdr-subagents/tree/058fd5f1cfa1731f10452a3dd1d6299a24d9ee46) |
| HenryQW/pi-harness, `extensions/pi-subagent` | [`18d2c7b8`](https://github.com/HenryQW/pi-harness/tree/18d2c7b8f39a4a3b87444099527df7c7e32cbdd8) |
| comput-sh/pi-intercom | [`6af57284`](https://github.com/comput-sh/pi-intercom/tree/6af57284abe93db37dee36015f808ddf688fc840) |
| championswimmer/pi-subagent-manager | [`51f1645c`](https://github.com/championswimmer/pi-subagent-manager/tree/51f1645ccc45aa1adb9582fa0082574cd8b481dc) |
| bermudi/pi-delegate | [`24fc88c0`](https://github.com/bermudi/pi-delegate/tree/24fc88c06a4f3d9715f2d99f072de4dca914edf6) |
| kvidzibo/pi-delegate | [`16bead2b`](https://github.com/kvidzibo/pi-delegate/tree/16bead2b3ea12194f048a4cb0d04cd42ad0aa580) |
| mavam/pi-agents | [`4377882b`](https://github.com/mavam/pi-agents/tree/4377882b7a14b65ed5669a372c0d232d9015392c) |
| boadij/pi-herdsman | [`40c7534d`](https://github.com/boadij/pi-herdsman/tree/40c7534d00beb8c47b1a768ff08838091533a78e) |
| jjuraszek/pi-cohort | `a0cc26d8` (no multiplexer hit; appears to be a nicobailon fork) |

| Non-Pi tool | Pin |
| --- | --- |
| smtg-ai/claude-squad | [`ce1ffb43`](https://github.com/smtg-ai/claude-squad/tree/ce1ffb4392b01f38e2c4599c7c84d2a93973b138) |
| devflowinc/uzi | [`421685f6`](https://github.com/devflowinc/uzi/tree/421685f65d66180152fb5f63128111ec12566ea5) |
| raine/workmux | [`23c09d88`](https://github.com/raine/workmux/tree/23c09d88a1bce1b63c2d894439bb79915dd71901) |
| asheshgoplani/agent-deck | [`967e2faf`](https://github.com/asheshgoplani/agent-deck/tree/967e2faf2b98b30da61206baaeff6bf998709f1b) |
| Claude Code docs | <https://code.claude.com/docs/en/agent-teams>, <https://code.claude.com/docs/en/agent-view> (no commit; read 2026-10-26) |
| herdr | <https://herdr.dev/docs/socket-api/> (repository and commit unknown; search returned a mirror, `Mihailorama/herdr-terminal`) |
| tmux | `tmux.1` as shipped with tmux 3.7b (`man tmux`); upstream <https://raw.githubusercontent.com/tmux/tmux/master/tmux.1> |

Short names drop the owner. The pi-squire facts come from this repo at `7c326f51`.

## What pi-squire does today

- It opens each delegate with `new-window -d -P -F #{window_id} -n <name> -c <cwd> -e K=V … -t <session_id of $TMUX_PANE> -- argv` (`src/tmux.ts:73-96`). The session is looked up from `TMUX_PANE`, so a client attached elsewhere does not matter (`src/tmux.ts:60-72`; `README.md:20-21`).
- Outside tmux it refuses (`src/index.ts:157, 770, 1092`; `src/resume.ts:348`). The README asks for tmux 3.0 or later because of `new-window -e`.
- It lists windows with `list-windows -a` and reads `#{pane_dead}` (`src/tmux.ts:105`); it never sets `remain-on-exit`, and never calls `switch-client`, `select-window`, `display-popup` or `attach` (ripgrep over `src/`).
- There is no user-facing way to reach a delegate window from the parent apart from tmux's own window list in the same session.

## Per-library findings

### 1. Placement of child sessions

| Library | Placement | Cite |
| --- | --- | --- |
| edxeth (tmux) | Split pane right of the parent pane while geometry allows, rebalanced with `select-layout`; if the new pane is too small, `break-pane -d` into its own window; with no split plan, `new-window -d` with **no `-t`** (tmux resolves the session from `TMUX_PANE`) | `edxeth@cf6dbf41:src/mux/surfaces.ts:137-160, 172-178` |
| edxeth (Herdr) | `auto` splits beside the parent, then dedicated tabs; policies `auto|right-stack|down-stack|right|down|tab` | `README.md:55, 955-966`; `src/mux/herdr-surfaces.ts:18` |
| edxeth (zellij) | split, stacked pane, `floating` or `tab-stack`; refuses right/down/stack/tab placement with more than one attached client | `README.md:981-991`; `src/mux/zellij-policy.ts:21`; `src/mux/zellij-placement.ts:88-89` |
| edxeth (WezTerm, cmux) | `wezterm cli spawn` or `split-pane`; cmux surface | `src/mux/surfaces.ts:196, 207`; backend list `src/mux/core.ts:9` |
| nicobailon | In-process SDK child; no terminal for the child. Terminal use is an optional read-only **inspector pane** (tmux `split-window -h`, Herdr pane, Ghostty AppleScript) | `docs/observability.md:99, 135`; `src/inspectors/tmux/actions.ts:126`; plugins `src/inspectors/plugins.ts:15` |
| nicobailon (Herdr project panes) | Peer Pi session opened as a pane in another project | `docs/tool-reference.md:499-511` |
| giuseppecrj | Pane in an extension-owned `Agents` tab of the target checkout's Herdr workspace; four panes per tab, overflow to a new tab; config `panes.mode = grouped|tab|split`, `panes.maxPerTab` | `README.md:109, 300`; `maestro/core/config/pane-config.ts:58-61` |
| asermax | Each child is its own Herdr tab, created with `focus: false` | `README.md:4`; `src/helper/spawn.ts:194-204` |
| HenryQW | A Herdr worker **tab** per task in a (worktree) workspace; `tab create … --no-focus` is asserted | `src/herdr-runtime.ts:929, 948`; `src/direct-herdr.ts:386`; continue opens a new tab (`README.md:103`) |
| comput-sh/pi-intercom | `herdr tab create --workspace $HERDR_WORKSPACE_ID`; refuses outside Herdr with "no fallback" on Linux | `src/launcher.ts:33-44` |
| tintinweb, gotgenes | In-process; "no spawned subprocesses" (gotgenes) | `gotgenes@109efb72:packages/pi-subagents/README.md:5, 16`; `tintinweb@ca93a524:README.md:17-19` |
| championswimmer, bermudi, kvidzibo | In-process SDK sessions; no multiplexer code found (the only `tmux` hits are `bermudi AGENTS.md:123-125` and a test doc, used for render checks) | ripgrep |
| mavam | A panel plus an "attach view" owned by `ctx.ui.custom`; multiplexer use: none found | `src/ui/focus.ts:8`; README diagram |
| boadij/pi-herdsman | Herdr-based (tab/workspace/pane calls in `extension/herdr.ts`); not read in depth; details unknown | ripgrep counts only |

Findings:

- **tmux is the weakest-supported backend** among the libraries that have several. edxeth's tmux path is the only one that creates anything in tmux, and it chooses **panes in the user's current window**, not windows or sessions. That is the opposite of pi-squire's goal 1: it floods the *window*, with an overflow rule (`isTmuxPaneUsable`, `moveTmuxPaneToWindow`) to avoid unusably small panes.
- **Herdr libraries solve goal 1 with grouping**: one `Agents` tab holding up to four panes (giuseppecrj), a tab per child kept unfocused (asermax, HenryQW), or `auto` then overflow tabs (edxeth). All use `--no-focus`/`focus: false`, so the child never steals the user's view. In tmux the equivalent is `new-window -d`, which pi-squire already uses.
- **Per-parent isolation is explicit in Herdr libraries**: edxeth keeps placement state "inside the parent Pi process" so two parents do not overwrite each other (`README.md:971`); giuseppecrj reuses the target checkout's workspace. No tmux library has a notion of "the parent's own session of delegate windows".

### 2. Navigation from the parent

| Library | How the user reaches a child | Cite |
| --- | --- | --- |
| edxeth | Pane/tab/window exists in the multiplexer; the user uses the multiplexer's own keys. A `/subagents` overlay lists runs; `capture-pane -p -S -N` is used to read a child's screen; tmux tab rename is opt-in (`PI_SUBAGENT_RENAME_TMUX_WINDOW`) | `src/tools/overlay/controller.ts:170-224`; `src/mux/io.ts:101-102`; `src/mux/surfaces.ts:276-283` |
| nicobailon | `/subagents-fleet` live inspector (browse, read, steer, stop); FleetView under the editor (`↓`/`←` at an empty editor); Enter/`H` opens the tmux inspector pane (`select-pane -t` to refocus an existing one, `options.focus` to keep or take focus); `inspector.command` prints a standalone runner command | `docs/observability.md:99-135`; `src/inspectors/tmux/actions.ts:104-138`; `docs/extension-api.md:509-515` |
| nicobailon (Herdr) | `herdr tab focus <tab_id>` or `workspace focus <ws_id>`; says "select it in Herdr manually" when ids are missing | `src/inspectors/herdr/focus.ts:32-51` |
| giuseppecrj | `herdr workspace focus` helper; optional Herdr sidebar plugin hides delegated children from Herdr's Agents view | `maestro/surfaces/herdr/herdr.ts:1315-1316`; `README.md:32, 251-288` |
| tintinweb | Above-editor widget; **FleetView** (`↓`/`←`, ↑/↓, Enter); `/agents` opens a **live conversation viewer overlay**; fullscreen or centred; `@agent` mentions | `README.md:17-19, 155-172` |
| gotgenes | Above-editor widget; `/subagents:sessions` opens any subagent's transcript in Pi's native read-only viewer, no steering | `README.md:18-19, 184-185` |
| championswimmer | `/agents` settings; watching, steering, stopping with shortcuts | `README.md:54, 60`; `docs/tools-and-ui.md` (not read further) |
| mavam | Panel, Ctrl+Q focus, Enter opens an attach view | `src/ui/focus.ts:2-8, 129` |
| HenryQW | Herdr tab labels show the worker worktree name; no jump command found | `README.md:150` |

Findings:

- **Every in-process library gives goal 2 through a Pi overlay** (picker list, then a viewer you can scroll, sometimes steer). The overlay lives in Pi's TUI, so it works in any terminal.
- **No Pi library gives a "jump to the terminal window" action in tmux.** The closest are nicobailon's `select-pane` on its own inspector pane and Herdr's `tab focus`. This is a gap rather than a convention to follow.
- Reading a child's screen without switching to it is done with `capture-pane -p` (edxeth `io.ts:101-102`; bermudi's own render checks, `AGENTS.md:123-125`).

### 3. Non-Pi tools

| Tool | Placement | Navigation | Cite |
| --- | --- | --- | --- |
| Claude Code agent teams | Default **in-process** (`teammateMode`: `"in-process"`); `"auto"` uses split panes when already inside tmux, or iTerm2 with `it2`; `"tmux"` forces panes; `--teammate-mode` flag | In-process: arrows in the agent panel, Enter views, type to message. Split panes: click a pane. Docs name "Orphaned tmux sessions" and tell the user to `tmux ls` and `kill-session` | `agent-teams.md`, "Choose a display mode" and "Orphaned tmux sessions"; "no session resumption with in-process teammates" |
| Claude Code background agents (`claude agents`) | A separate **supervisor process** runs the sessions; no terminal needed | List view; **Space peeks** (latest output or the question, reply inline); **Enter/→ attaches** (takes over the terminal); **← at an empty prompt detaches**; `claude attach <id>`, `claude logs <id>`, `claude agents --json` | `agent-view.md:9-15, 47-53, 158`; CLI forms from a secondary mirror, not re-checked on the official page |
| claude-squad | **One detached tmux session per agent**: `tmux new-session -d -s claudesquad_<name> -c <workdir> <program>`; session prefix `claudesquad_` | TUI list with a preview tab and a diff tab; Enter/`o` attaches by running `tmux attach-session -t …` **through a PTY it owns** (not a user-level switch); Ctrl-Q detaches; "Use Ctrl-Q to properly detach" error on Ctrl-D | `session/tmux/tmux.go:60, 102, 195, 293`; `README.md` keys |
| Uzi | One detached tmux session per agent: `tmux new-session -d -s <git-hash-prefixed name> -c <worktree>`; window renamed `agent`; `send-keys` to type prompts | `uzi ls -w` status table | `cmd/prompt/prompt.go:187-240` |
| workmux | **Window per task in the current session** by default; `mode: window|session`, `window_prefix` (default `wm-`), `default_session` to return to when a session closes; kitty/WezTerm/zellij backends | Dashboard TUI and a sidebar; cleanup uses `switch-client -c <client> -t <dest>` for each attached client of the doomed target (guarded by `if-shell -F`) | `README.md:58-59, 323-325, 639-640`; `src/multiplexer/tmux.rs:452-490` |
| agent-deck | tmux-backed sessions managed by its own TUI | `Enter` attach, `Ctrl+Q` detach; waiting sessions appear **in the tmux status bar** with `Ctrl+b`, `1`–`6` to jump | `README.md:373` and key table; code paths not read |
| Herdr | Workspaces → tabs → panes; sessions keep running when you detach; scripted by a socket API with workspace/tab/pane `create, list, focus, rename, close` and agent `attach` helpers | Focus commands, sidebar | <https://herdr.dev/docs/socket-api/> |

Findings:

- **The two tmux tools that isolate agents use sessions, not windows** (claude-squad, Uzi), and both use `new-session -d` with a prefixed name. Neither shows its sessions to the user's tmux session list as windows; but both do appear in `tmux ls`, which is why Claude Code's docs have a cleanup section.
- **workmux ships both** and makes it a config knob (`mode`), with `default_session` solving "which session do I return to when the dedicated one closes" and a `switch-client -c` per attached client at cleanup. That is the closest precedent for the config knob in the task.
- **None of them uses tmux's own picker or `display-popup` to show an agent.** claude-squad attaches through a PTY inside its own TUI; Claude Code attaches inside its own process. Popup use is unknown for agent-deck (not read).

## tmux behaviour (man page 3.7b and probe)

- **`new-session -d`** creates a session "not attached to the current terminal"; with `-d` the size comes from `default-size` (`man tmux`, `new-session`). It fails with `duplicate session: <name>` when the name exists (probe).
- **`new-session -A -d` is not create-if-missing.** `-A` makes `new-session` "behave like `attach-session` if session-name already exists; if `-A` is given, `-D` behaves like `-d` to `attach-session`" (man). With no terminal, the probe returned **`open terminal failed: not a terminal`**, rc=1, when the session already existed. Create-if-missing must be `has-session` then `new-session -d`, or `new-session -d` and tolerate `duplicate session`. The race between two parents is then the "duplicate" error, which is safe.
- **A session lives only while it has a window.** Killing the last window destroyed the session, and with no other session the **server exited** (`exit-empty` default on, man; probe: "no server running"). A shared `squire` session therefore disappears when the last delegate window closes, and `new-window -t squire:` then fails with `can't find session: squire` (probe, rc=1). Creating on demand has to be done on every launch, not once. `remain-on-exit` changes this: "when the shell command completes, the window closes; see the `remain-on-exit` option" (man), so a delegate that exited stays as a dead pane and keeps the session alive; pi-squire does not set it today.
- **`switch-client -c <target-client> -t <target-session>`** "switch the current session for client target-client to target-session"; `-t` may also be a pane/window (`session:window.pane`, `%pane`, containing `:`, `.` or `%`) to change session, window and pane together (man). Without `-c`, "tmux attempts to work out the client currently in use; if that fails, an error is reported" (man; probe: **`no current client`**, rc=1, from a script outside any client). The client chosen when the call comes from a process inside a pane is resolved from that pane; `TMUX_PANE` is how the pane id is passed (man). Resolution with several attached clients, or with the client the user is *looking at* differing from the one tied to the pane, is not shown by the man page: **unknown, not tested** (a probe needs real attached clients). workmux sidesteps it by enumerating `list-clients -t <target>` and switching each client explicitly (`tmux.rs:452-490`).
- **`attach-session`**: "If run from outside tmux, attach to target-session in the current terminal. … If used from inside, switch the currently attached session to target-session" (man). So `tmux attach -t x` run with `$TMUX` set behaves like `switch-client`; whether the process inside a `display-popup` has `$TMUX` set (and therefore switches the underlying client instead of rendering inside the popup) was **not verified**: a popup needs an attached client. The popular workaround is `TMUX= tmux attach -t x` (not found in the man page; community lore, unverified here). The man page for `new-session`/`attach` in 3.7b contains no "sessions should be nested with care" text; that message comes from the `tmux` client (not searched in source).
- **`display-popup`** `[-BCEkN] [-b border-lines] [-c target-client] [-d start-directory] [-e environment] [-h height] [-w width] [-x] [-y] [-t target-pane] [-T title] [shell-command …]`; "-E closes the popup automatically when shell-command exits; `-EE` only if it exited with success"; "the `-C` flag closes any popup on the client"; "If the command is run inside an existing popup, that popup is modified" (man). `-c target-client` chooses where it is drawn. The man page does not give a version; the README of pi-squire already requires 3.0 for `new-window -e`; **display-popup needs tmux ≥ 3.2** per the task; the man page read here does not state it (unknown, taken from the task). A popup is drawn on a *client*: with no client the call fails like `switch-client` does.
- **`detach-on-destroy [off | on | no-detached | previous | next]`**: `on` (default) detaches a client when its session is destroyed; `off` switches it to the most recently active remaining session; `no-detached` detaches only if no detached sessions exist, otherwise switches to the most recently active; `previous`/`next` pick by alphabetical order (man). A client that has `switch-client`ed into a delegate session and then loses it to a window close is **detached from tmux entirely** under the default, and the user's terminal drops to a shell. `attach-session -f no-detach-on-destroy` sets this per client (man, client flags). Worth noting: a `no-detached` setting would send a client to *another detached session* (such as a `squire` one), which is the wrong place to land.
- **Names**: session names are tried as `$id`, exact name, prefix, then pattern (man, target-session list); the `=` prefix forces an exact match (workmux uses `={name}:`, `tmux.rs`); a `.` or `:` in a name is rewritten (claude-squad replaces `.` with `_`, `tmux.go:68-70`). Fully qualified ids (`$3`, `@5`, `%7`) "are unchanged for the life of the session, window or pane in the tmux server" (man), which is why pi-squire's `#{window_id}` is stable while a renamed window or session is not.
- **Windows the user closes by hand** are handled in pi-squire by listing `list-windows -a` and treating a missing id as gone (`src/tmux.ts:105-110`); there is no tmux-side notification of closure. nicobailon's inspector shows how to check a pane is "alive AND ours" (`list-panes` fails on a gone pane, while `display-message` returns empty on tmux 3.3+; a marker survives pane-id reuse), `src/inspectors/tmux/actions.ts:88`.
- **Nested tmux (a delegate inside tmux)**: edxeth strips `TMUX*`, `TERM`, `HERDR*`, `WEZTERM*`, `ZELLIJ*` from a child's inherited env so the child does not think it owns the parent's pane (`src/launch/child-env.ts:15-24`); pi-squire's `new-window -e` env is explicit.

## Comparison

| | Child terminal | Dedicated per parent | Jump from parent | Peek | Config knob |
| --- | --- | --- | --- | --- | --- |
| edxeth | tmux/Herdr/zellij/WezTerm/cmux pane or tab | no | multiplexer keys; overlay lists | `capture-pane` | `PI_SUBAGENT_MUX`, `*_PLACEMENT` (Herdr, zellij) |
| nicobailon | none (in-process), optional inspector pane | no | `/subagents-fleet`, Enter/`H`, `select-pane`, `herdr tab focus` | transcript in inspector | `options.focus`, plugin registry |
| giuseppecrj | Herdr pane in `Agents` tab | per checkout workspace | `workspace focus` helper | widget | `panes.mode/maxPerTab` |
| asermax, HenryQW, comput-sh | Herdr tab per child | per workspace | Herdr UI | n/a | n/a |
| tintinweb, gotgenes | none | n/a | FleetView, `/agents` viewer, `/subagents:sessions` | live viewer | `widgetMode` |
| championswimmer, bermudi, kvidzibo, mavam | none | n/a | Pi overlay/attach view | live view | various |
| Claude Code teams | in-process or tmux/iTerm2 pane | no | panel arrows, click pane | in-process view | `teammateMode` |
| Claude Code `claude agents` | supervisor process, no terminal | n/a | Space peek, Enter attach, ← detach | peek panel | `defaultToAgentsView` |
| claude-squad / Uzi | detached tmux **session** per agent | yes (per agent) | own TUI attach through PTY / none | preview tab / `ls -w` | none found |
| workmux | tmux window (or session) per task | optional | dashboard, sidebar | dashboard preview | `mode`, `window_prefix`, `default_session` |
| agent-deck | tmux sessions | yes | TUI, status-bar jump keys | preview | many |
| **pi-squire today** | detached tmux **window** in the parent's session | no | none | none | none |

## Implications for pi-squire

This section interprets the evidence; it does not design pi-squire.

1. **Goal 1 (do not flood the current session) has two precedents in tmux, none in Pi.** Session-per-agent is how claude-squad and Uzi avoid the problem; workmux keeps windows by default and offers `mode: session`. Among Pi libraries only edxeth touches tmux, and it uses splits that add clutter to the user's window. A dedicated or shared session is therefore new ground for a Pi extension, but the workmux `window`/`session` config is a direct precedent for a knob, including the "where do I return to" setting.
2. **A single shared `squire` session needs create-on-demand on every launch.** The session dies with its last window and the server may exit (probe). `new-window -t squire:` fails with `can't find session` (probe), and `new-session -A -d` fails when the session exists and there is no tty (probe), so the portable sequence is "try `new-window -t squire:`, on `can't find session` `new-session -d -s squire`, tolerate `duplicate session` and retry". With several Pi parents on one server the shared session also mixes their delegates; a per-parent name means more sessions to name, collide and clean up (Claude Code documents an orphan-cleanup step for exactly this; claude-squad prefixes every name).
3. **Window ids already make addressing stable; session names do not.** pi-squire records `#{window_id}`, which the man page says is "unchanged for the life of the … window". Whether that id survives `move-window` or `join-pane` between sessions, or a user renaming the session, was not probed (unknown).
4. **Goal 2 (see and jump) is solved outside tmux in every Pi library that solves it at all.** The pattern is a Pi-side picker plus a read-only or steerable viewer (tintinweb, gotgenes, nicobailon, mavam) or a peek panel (Claude Code `claude agents`). None calls `switch-client`. A `/delegates` command that lists delegates and prints or runs an action is the common shape; the part that is missing in the ecosystem is a tmux-side jump, so its robustness costs are unprecedented for Pi and need their own tests.
5. **`switch-client` needs a client.** `no current client` is the probe result outside a client; from a Pi process in a pane tmux resolves the client from that pane, but the man page does not say what happens when several clients are attached to the parent's session or the user's focused client differs (unknown, untested). Workmux's `list-clients -t <session>` plus explicit `-c <client>` loop is the only code found that handles several clients; it gates each switch with `if-shell -F` so a client that moved is not yanked.
6. **A popup attach has two unverified costs.** `display-popup -E 'tmux attach -t …'` runs `attach-session`, which "from inside, switch[es] the currently attached session" (man), so with `$TMUX` set it may switch the underlying client instead of nesting; `env -u TMUX` / `TMUX=` is the usual fix (unverified here). The popup also ends when the attach ends, and `-c` is needed when the calling process is not the client's. Popups need a tmux that has them (≥ 3.2, from the task); pi-squire's README today says 3.0. A fallback for older tmux, and for no client, is needed if the knob offers popups.
7. **`detach-on-destroy` decides what a delegate close does to a switched client.** With the default `on`, a client that switched into a delegate session is detached when that session dies, so "the user jumped into a delegate and it exited" can drop them out of tmux. `remain-on-exit` on the delegate window keeps the pane until killed, which avoids that but needs pi-squire to reap windows (it already reads `pane_dead`, `src/tmux.ts:105`). Neither option is used by any audited library.
8. **Outside tmux** every tmux-based library here refuses or falls back: edxeth returns "no backend", pi-intercom says "no fallback", Claude Code teams fall back to in-process, pi-squire refuses (`src/index.ts:157`). The in-process libraries (tintinweb, gotgenes) never needed tmux; an in-process mode is the only precedent for "no window".
9. **Evidence for the config knob.** workmux (`mode: window|session`), Claude Code (`teammateMode: in-process|auto|tmux`), edxeth (`PI_SUBAGENT_MUX`, `*_PLACEMENT`) and giuseppecrj (`panes.mode`) all expose a placement setting; none of them offers a popup. A knob between "window in the current session", "dedicated/shared session" and "picker with jump" has precedent in structure but not in the specific options.

## Unknowns

- Whether a process started by `display-popup` has `$TMUX` set, and what `tmux attach` does in it (needs an attached client; not probed). Whether `display-popup` is ≥ 3.2 (task statement; not in the 3.7b man page).
- `switch-client` with several clients attached to one session, and with `-c` pointing at a client other than the one the user watches: not tested.
- How a pane moved with `join-pane`/`break-pane` between sessions behaves for a pi-squire-style window-id record (id stability is stated by the man page; real behaviour not probed).
- agent-deck's popup and nested-tmux handling (README only; code not read). Herdr's repository and commit (docs only). boadij/pi-herdsman's placement beyond the Herdr API (not read). championswimmer's UI detail (`docs/tools-and-ui.md` not read).
- Whether the Claude Code `claude attach <id>` and `claude logs <id>` forms are on the official page (seen on a mirror).
- Whether any Pi library not in the source list uses `display-popup` or `switch-client`; a hit may exist outside the 14 clones searched.

## Probed after the survey (tmux 3.7b, private socket, one attached client)

These settle four of the unknowns above:

- **Window ids survive `move-window` between sessions.** `@2` moved from `squire` to `main` and back, and kept its id each time. pi-squire's id-plus-name match in `list-windows -a` therefore still finds a window that the user, or pi-squire, moved.
- **Inside `display-popup`, `$TMUX` and `TMUX_PANE` are set.** Even so, a plain `tmux attach -t squire` attached a *second, nested client* rendered inside the popup. There was no "nested with care" refusal, and the underlying client did not switch. Detaching that client (`prefix d`, or `detach-client`) ended the command with rc 0, and `-E` then closed the popup. The `TMUX=` workaround is not needed on 3.7b. Older versions were not checked.
- **`display-popup` blocks its caller until the popup closes.** pi-squire's `execFile` call with its 10 s timeout would time out, so a popup has to be started without waiting, for example with `run-shell -b` or a detached spawn.
- **`switch-client -t <session>:<window>` run from a pane, with one attached client, switched that client** to the delegate's window.
- **`set-option -t squire detach-on-destroy off` is per session.** When the client was in `squire` and the last window of `squire` was killed, the client landed back in `main` instead of being detached. With that option set on the delegate session, an auto-exit while the user is watching is safe.

Still untested: several clients attached at once.

Local clones used for this survey are under `.scratch/tmp/` (untracked, not part of the change); the tmux man page text is saved at `.scratch/tmp/tmux-man.txt`.
