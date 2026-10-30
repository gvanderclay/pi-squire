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
| `model` | `provider/id` or a pattern, passed to the child's `--model` unchanged, so Pi resolves it. Absent means the parent's model. | Was required and had to be `provider/id`. |
| `thinking` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. An unknown value is dropped and the parent's level applies. Absent means the parent's level. | Check today's accepted values against this list. |
| `tools` | The delegate's complete tool list. Absent means the parent's tools. See Tools. | Meaning unchanged; the absent case is now stated. |
| `prompt_mode` | `append` (default) wraps the body in `<agent_instructions>` after Pi's prompt. `replace` adds the body after Pi's prompt with no wrapper, which is how every delegate is built today. | New. |
| `enabled` | `false` leaves the agent out. A project file with `enabled: false` hides a global agent in that project. | New. |
| `locked` | `true`, or a list of `model` and `thinking`. A locked field cannot be overridden by the `delegate` tool or command; a call that passes one is refused for that field, and the result says which agent locked which field. `true` locks every field the file sets. | New. |
| `display_name` | Shown on the delegate card, `/delegates` and the window title instead of the name. | New. |
| `fallback` | Models to try when `model` is usage-limited. Each entry is passed through like `model`. | Entries no longer need to be `provider/id`. |
| `auto-exit` | Unchanged. | — |
| `extensions` | Unchanged, except relative paths (see above). | — |
| `max_turns`, `inherit_context`, `run_in_background` | Ignored, with no warning. | New: known and ignored. |
| `exclude-tools` | Removed. Use `tools`, or leave a tool to a permission policy another extension applies. | Removed. |

Any other key is ignored silently.

## Tools

- No `tools` field: the delegate gets the parent session's active tools at
  launch, passed explicitly as `--tools`.
- An empty `tools` field (`tools:` or `tools: []`): no tools except
  `delegateTools`; `--no-tools` when that is empty too.
- A `tools` line: exactly those tools.
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
- That passing a pattern to `--model` and through `fallback` needs no
  validation beyond Pi's own error.
- That the `thinking` values above match what Pi accepts.

## Tools added to every delegate

`<agent dir>/squire/settings.json` gains `delegateTools`, beside
`windowPlacement` and `worktreeRoot`:

```json
{ "delegateTools": ["<tool or pattern>", "..."] }
```

- Tool names or `*` patterns, passed to the child's `--tools` unchanged.
- Added to every delegate: to its agent's `tools`, to an empty `tools`, and
  to the parent's tools for an agent with no `tools` field.
- The delegation tools are removed even when a pattern matches them.
- Empty by default. `pi-squire` names no provider's tools; the README tells
  the user to list the tools their `message:*` provider gives a delegate for
  reaching its parent.

## Implementation notes

- `locked`: a call that passes a locked field still starts; the field keeps
  the agent's value and the result's notices name the agent and the fields. A
  value equal to the agent's own is no override and passes quietly. Resumes
  apply the same rule.
- A `model` or `fallback` entry that is an exact `provider/id` in the registry
  keeps the credential and usage-limit checks; anything else goes to the child
  unchanged. The delegate's own mid-run switch still moves only to exact
  `provider/id` entries.
- `exclude-tools` in a file gets a warning, so a moved file does not silently
  gain tools.
- The child always gets an explicit tool selection: no flag would give it
  Pi's default tools, not the parent's. An absent `tools` field passes the
  parent's `pi.getActiveTools()` read when the launch or resume starts, less
  the delegation tools; an empty field passes only `delegateTools`, or
  `--no-tools` (Pi's way to start with none, MCP tools included) when that is
  empty. Tools only the agent's own `extensions` register are not in the
  parent's list, so an agent without `tools` does not get them.
- `display_name` replaces the agent's name in the window and session name
  (`<display_name>-<label>`); the record keeps it for `/delegates`.
