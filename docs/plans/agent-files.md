# Plan: agent files in Pi's shared agents folder

Status: implemented on branch agent-files.

## Decision

The roster moves from `<agent dir>/squire/agents/<name>/AGENT.md` to one file
per agent, `<name>.md`, in the agents folders Pi agent tooling shares:

- `<agent dir>/agents/<name>.md`, global.
- `<cwd>/.pi/agents/<name>.md`, per project, read only when the project is
  trusted. A project file overrides the global file of the same name.

The frontmatter follows the field names and meanings below, so an agent file
reads the same in any tool that uses this folder. `pi-squire` names no other
package in its code or docs, and has no code for any other package: keys it
does not know, such as a permission policy, are ignored and left for whatever
reads them.

This is a breaking change, released as a major version. The old location is no
longer read.

## Location and loading

- The roster is still read at call time, so a new file is usable without a
  reload.
- The agent's name is the filename without `.md`.
- Project agents load only when Pi reports the project as trusted. In an
  untrusted project only global agents load, so a cloned repository cannot
  change a delegate's prompt, model or tools.
- `squire/delegation_prompt.md` stays where it is. It is squire's guidance to
  the parent, not an agent.
- `extensions` paths that are relative resolve against the agent file's
  folder, as they did against the `AGENT.md` folder.

## Fields

| Field | Meaning | Change from today |
| --- | --- | --- |
| `description` | Shown in the roster and tool description. Defaults to the name. | Was required. |
| `model` | One model: `provider/id` or an alias, passed to the child's `--model` unchanged, so Pi resolves it. A `*` pattern makes the file invalid. Absent means the parent's model. | Was required and had to be `provider/id`. |
| `thinking` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. An unknown value is dropped and the parent's level applies. Absent means the parent's level. | Check today's accepted values against this list. |
| `tools` | The delegate's complete tool list. Absent means the parent's tools. See Tools. | Meaning unchanged; the absent case is now stated. |
| `prompt_mode` | `append` (default) wraps the body in `<agent_instructions>` after Pi's prompt. `replace` adds the body after Pi's prompt with no wrapper, which is how every delegate is built today. | New. |
| `enabled` | `false` leaves the agent out. A project file with `enabled: false` hides a global agent in that project. | New. |
| `locked` | `true`, or a list of `model` and `thinking`. A locked field cannot be overridden by the `delegate` tool or command; a call that passes one is refused for that field, and the result says which agent locked which field. `true` locks every field the file sets. | New. |
| `display_name` | Shown on the delegate card, `/delegates` and the window title instead of the name. | New. |
| `fallback` | Models to try when `model` is usage-limited. Each entry is one model, like `model`; a `*` pattern makes the file invalid. | Entries no longer need to be `provider/id`. |
| `auto-exit` | Unchanged. | — |
| `extensions` | Unchanged, except relative paths (see above). | — |
| `max_turns`, `inherit_context`, `run_in_background` | Ignored, with no warning. | New: known and ignored. |
| `exclude-tools` | Removed. Use `tools`, or leave a tool to a permission policy another extension applies. | Removed. |

Any other key is ignored silently.

## Tools

- No `tools` field: the delegate gets the parent session's active tools at
  launch, and the tools the agent's own `extensions` register, passed
  explicitly as `--tools`.
- Whatever the selection, the delegate gets exactly it, MCP tools included:
  an MCP tool no entry names or matches is not registered in the child.
- An empty `tools` field (`tools:` or `tools: []`): no tools except
  `delegateTools`; `--no-tools` when that is empty too.
- A `tools` line of tool names: exactly those tools.
- A `tools` line of only `-name` entries: the parent's tools, as with no
  `tools` field, less those. A `-name` entry may be a `*` pattern, matched as
  Pi matches tool patterns.
- A `+name` entry, or tool names and `-name` entries mixed, make the file
  invalid and disable the agent. pi-squire resolves the selection itself and
  always passes the child a plain list; it never passes `+name` or `-name`.
- The delegation tools (`delegate`, `delegation_status`, `delegation_close`,
  `delegation_resume`) are never available in a delegate, as today.
- Tools in the `delegateTools` setting are added to every delegate's tools,
  inherited or listed. See Tools added to every delegate.

## Prompt

- `replace` must reproduce today's prompt byte for byte, with a test that pins
  it.
- `append` wraps a non-empty body in `<agent_instructions>`; an empty body adds
  nothing.

## Docs and hooks

- README: the Agents section, the `delegateTools` setting, the first-use
  example, and the `session:launch` `agent` field (it names the old
  `AGENT.md` path).
- CHANGELOG: the breaking change, with the move as a migration note
  (`squire/agents/<name>/AGENT.md` becomes `agents/<name>.md`; add
  `prompt_mode: replace` to keep today's prompt; replace `exclude-tools`).
- `PI_DELEGATE_AGENT` and `session:launch` keep carrying the agent's name.

## Checks during implementation

- How a tool that turns on other tools at run time, such as `web_enable`,
  behaves under a `tools` list.
- That passing an alias to `--model` and through `fallback` needs no
  validation beyond Pi's own error.
- That the `thinking` values above match what Pi accepts.

## Tools added to every delegate

`<agent dir>/squire/settings.json` gains `delegateTools`, beside
`windowPlacement` and `worktreeRoot`:

```json
{ "delegateTools": ["<tool or pattern>", "..."] }
```

- Tool names or `*` patterns, passed to the child's `--tools` unchanged. An
  entry that starts with `+` or `-` makes the setting invalid, which refuses
  every launch.
- Added to every delegate: to its agent's `tools`, to an empty `tools`, and
  to the parent's tools for an agent with no `tools` field.
- The delegation tools are removed even when a pattern matches them.
- Empty by default. `pi-squire` names no provider's tools; the README tells
  the user to list the tools their `message:*` provider gives a delegate for
  reaching its parent.

## Implementation notes

- `locked`: a call that passes a locked field still starts; the field keeps
  the agent's value (the parent's when the file sets none) and the result's
  notices name the agent and the fields. A value equal to that one is treated
  exactly as no value: no notice, the usual model choice with the agent's
  fallbacks, and no `provider/id` check for an alias. Model and thinking are
  decided separately.
- Resumes: an unlocked field keeps what the delegate last ran on, unless the
  call passes a value. For thinking that is the last `thinking_level_change`
  on the active branch of the delegate's session file (the leaf is Pi's last
  entry, walked back through `parentId`; Pi records one at start, one per
  change and one per clamp), read by `sessionThinking`, and the record's
  `thinking` only when the session has none. A locked field takes the agent file's current value
  when the resume starts, even if the file changed since the launch, and a
  locked model starts from the file's `model` again, then its fallbacks, even
  when the delegate had moved to a fallback mid-run. A passed value for a
  locked field is refused with the notice, or dropped quietly when it equals
  the file's current value.
- A `model` or `fallback` entry that is an exact `provider/id` in the registry
  keeps the credential and usage-limit checks; anything else goes to the child
  unchanged.
- No `*` patterns for models: a `model` or `fallback` entry containing `*`
  makes the file invalid and disables the agent. Each entry names one model.
  Pi's `--model` (`resolveCliModel`) has no `*` patterns and would turn
  `alpha/*` into a custom model id, and expanding a pattern only mid-run gave
  a launch and a resume of the same agent different meanings.
- The delegate's own mid-run switch resolves each `fallback` entry with Pi's
  exported `resolveCliModel`, the resolver behind `--model`, so an alias
  means the same model as at launch: an exact `provider/id`, or a bare id or
  alias (`sonnet`) to one model, in listed order. A custom model id it makes
  up for an unknown entry is not used: the entry is passed over. The registry
  is handed to the resolver as a runtime with only `getModels` and
  `hasConfiguredAuth(provider)`, the two methods it reads.
- `exclude-tools` in a file gets a warning, so a moved file does not silently
  gain tools.
- The child always gets an explicit tool selection: no flag would give it
  Pi's default tools, not the parent's. An absent `tools` field passes the
  parent's `pi.getActiveTools()` read when the launch or resume starts, less
  the delegation tools; an empty field passes only `delegateTools`, or
  `--no-tools` (Pi's way to start with none, MCP tools included) when that is
  empty.
- The parent's tools for an agent without `tools` (or with only `-name`
  entries) include the tools its own `extensions` register, which exist only
  in the child. `extension-tools.ts` loads those extensions in the parent with
  Pi's exported `discoverAndLoadExtensions`, pointed at an empty folder so
  nothing else is discovered: a fresh module (Pi's loader caches nothing), a
  throwaway event bus and runtime, no session, so `session_start` never fires.
  The names are the keys of each loaded extension's `tools`. This sees the
  tools an extension registers as it loads, which Pi's docs make the place to
  register them; a tool registered later is not seen and must be named.
  Computing the list in the child was not possible: `--tools` decides which
  tools Pi registers at all, and a child extension cannot see or widen it.
  An extension that fails to load is warned about and contributes nothing.
- An invalid agent file disables its agent: `readRoster` keeps it in
  `disabled` with the reason, the roster and the `delegate` description leave
  it out, its warning is shown at session start and, once per session, before
  a run for a file that turned invalid since, and a launch or resume naming it
  is refused with the reason. The `delegateTools` setting is global, so an
  invalid one refuses every launch with an error instead of disabling agents.
- MCP tools obey the selection. Pi (1.3, 1.4) keeps every MCP tool
  registered, so callable from `codemode` and loadable by `tool_search`,
  unless a `--tools` entry starts with `mcp__` (`_allowlistFiltersMcp`), in
  which case MCP tools are filtered by the list like any other tool, the
  resource tools included. pi-squire adds the entry `mcp__`, which names no
  tool, to a list without such an entry. `--exclude-tools 'mcp__*'` was not
  used: it would also drop MCP tools that a `*` pattern in the list selects,
  and it would need the resource tools named one by one. `test/pi-tools.test.ts`
  starts the project's own Pi with the tool arguments a launch passed and a
  probe extension registering stand-in MCP tools, and checks what Pi
  registered.
- `display_name` replaces the agent's name in the window and session name
  (`<display_name>-<label>`); the record keeps it for `/delegates`.
