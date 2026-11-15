# Agent reference

[Home](../README.md) · [Configuration](configuration.md) · [Troubleshooting](troubleshooting.md)

- [Agents](#agents)

## Agents

An agent is one Markdown file, `<name>.md`, in the agents folders Pi agent
tooling shares; the file name without `.md` is the agent's name (letters,
digits, `_` or `-`). The roster is read at call time, so a new or edited file
is usable without a reload.

- `<agent dir>/agents/<name>.md` holds the global agents.
- `<cwd>/.pi/agents/<name>.md` holds a project's agents, read only when Pi
  reports the parent's project as trusted. A project file replaces the global
  file of the same name. In an untrusted project only the global agents load,
  so a cloned repository cannot change a delegate's prompt, model or tools.

The body is the delegate's instructions, appended to Pi's own prompt; it
reaches the child as a path to a private file under the system temporary
folder, so the text stays off the command line. Every frontmatter field is
optional, and the [first-use example](../README.md#first-use) is a complete agent file:

| Field | Meaning |
| --- | --- |
| `description` | Shown in the roster and the `delegate` tool's description. Defaults to the name. |
| `routing_profile` | Experimental, shipped opt-in to role/task routing: the value names a profile in `<agent dir>/squire/routing.json`. Without it, the agent keeps legacy model selection. A bound role requires valid routing policy and per-call routing metadata; see [Role/task routing](routing.md#role-task-routing). |
| `display_name` | Shown instead of the name on the delegate card, in the compact widget and in the window title (`<display_name>-<label>`). The agent is still called by its name. It may hold only ASCII letters, digits, `-` and `_`; any other value (a space, `#`, `.`, a non-ASCII letter, or an empty value) makes the file invalid, so the agent is disabled. |
| `model` | One model: `provider/id` or an alias such as `sonnet`, passed to the child's `--model` unchanged, so Pi resolves it to one model. A `*` pattern makes the file invalid. Absent means the parent session's current model for legacy agents; a bound role uses its routing policy. |
| `thinking` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. Absent means the parent's level for legacy agents; a bound role uses its route's per-candidate level. An unknown value is dropped with a warning and the parent's level applies to legacy agents. Pi clamps the level to the model. |
| `tools` | The delegate's tools (see below): tool names and `$bundle` entries for exactly those, or only `-name` entries for the parent session's current tools less those. Absent means the parent session's current tools; empty (`tools:` or `tools: []`) means no tools except the `delegateTools` setting. MCP tools follow the selection like any other. |
| `fallback` | For legacy agents, models to try in order when `model` is usage-limited (see [Usage limits](results-and-recovery.md#usage-limits)). Routed roles use only their policy's frozen candidate list. Each entry is one model, like `model`; a `*` pattern, or a YAML list entry holding a comma, makes the file invalid. A comma-separated line (`fallback: a, b`) is two entries. |
| `auto_exit` | `true` or `false`, default `true`; see [Auto-exit](results-and-recovery.md#auto-exit). |
| `skills` | `true` or `false`, default `true`. `false` passes the child `--no-skills`, which disables discovered and configured skills, so their names and descriptions leave the system prompt. A skill loaded by an explicit `--skill` path still loads; pi-squire passes none. |
| `context_files` | `true` or `false`, default `true`. `false` passes the child `--no-context-files`, which disables `AGENTS.md` and `CLAUDE.md` discovery. The delegate then gets none of the rules those files carry, your project's and your global ones alike, so keep what it needs in the agent body. |
| `allow_nested_delegation` | Experimental, shipped: `true` or a YAML list of exact child agent names; grants nested delegation below `maxDepth` (see [Nested delegation](nesting.md#nested-delegation)). Absent, false or an empty list grants none. Malformed values disable the agent; unavailable names warn. |
| `prompt_mode` | `append` (the default) wraps the body in `<agent_instructions>` and `</agent_instructions>` lines; `replace` adds the body unwrapped. An empty body adds nothing either way. |
| `enabled` | `false` leaves the agent out. A project file with `enabled: false` hides a global agent of the same name in that project. |
| `locked` | `true`, or a list of `model` and `thinking`. A call to `delegate`, `/delegate`, resume or fork that passes a locked field does not get it: the agent's value is used (the parent's when the file sets none) and the result says which agent locked which field. Passing the agent's own value is the same as passing nothing: no notice, and its fallbacks still apply. A resume of a locked field runs on the file's value as it is now, not on what the delegate last ran on. `true` locks the fields the file sets. A routed lock still has to satisfy route constraints; see [Role/task routing](routing.md#role-task-routing). |

Any other key, such as `max_turns`, `inherit_context` or `run_in_background`,
is ignored without a warning and left for whatever else reads the file.
Squire observes only whether `permission:` is a map for the nested-grant warning
above; it leaves interpretation and enforcement to the permission provider.

**Breaking frontmatter change:** use `auto_exit` instead of `auto-exit`.
The old `auto-exit` and `extensions` fields are silently ignored, including
malformed values and missing extension paths. In particular, an old
`auto-exit: false` no longer keeps the delegate open: without `auto_exit: false`
or a call override, auto-exit defaults to on. Agent-specific extension loading
has been removed from both launch and resume. Normal Pi extension discovery
and [`session:launch`](integrations.md#sessionlaunch) customization remain available.
The `--auto-exit` / `--no-auto-exit` flags, `/auto-exit` command and
`PI_DELEGATE_AUTO_EXIT` environment variable are unchanged.

`exclude-tools` is no longer read; a file that still has it gets a warning
(use `tools` instead).

The starter’s `read, grep, find, ls` selection uses Pi built-ins, not shell
commands. Pi 1.5.2’s `grep` needs ripgrep (`rg`) and `find` needs `fd`
(or `fdfind` on PATH). Pi uses its cached binaries or PATH and otherwise
tries to download them automatically. On a fresh machine with downloads
blocked or `PI_OFFLINE=1`, install ripgrep and fd before asking the scout
to search; an unavailable binary makes that tool fail. Unsupported platforms
and Android/Termux need system-provided binaries too. `read` and `ls` do not
need those search binaries.

`tools` lists the delegate's tools as a comma-separated or YAML list
(`tools: read, grep` or `tools: [read, grep]`). Each entry of a YAML list
names one tool: an entry holding a comma, such as `tools: ["read,-bash"]`,
makes the file invalid. pi-squire works out the delegate's whole selection
itself and always passes the child a plain list, `--tools read,grep`, which Pi
treats as the whole selection, extension tools included; entries may be `*`
patterns. It never passes Pi `+name` or `-name` entries. MCP tools follow the
list like any other tool: an MCP tool (`mcp__<server>__<tool>`, or one of the
MCP resource tools) that no entry names or matches is not registered in the
delegate at all, so it is neither declared nor callable from `codemode` nor
loadable by `tool_search`, whatever its exposure. Pi filters MCP tools by
`--tools` only once an entry starts with `mcp__`, so when the list has no
such entry pi-squire adds the entry `mcp__`, which names no tool; an empty
selection is `--no-tools`, which removes MCP tools too. To give a delegate an
MCP server's tools, name them, for example `mcp__docs__*`. An extension that
turns tools on at run time can still add only tools the list allows. Tool names
are not checked against the parent's tools, at top level or nested: normal Pi
extension discovery or `session:launch` customization can provide tools in the
child.

- No `tools` field: the delegate gets the parent session's available tools
  when the launch (or resume) starts, at any depth: active tools plus registered
  codemode/deferred operations, excluding hidden tools and inactive direct tools,
  passed as `--tools`, plus the `delegateTools` entries. Pi initially declares
  these selected tools in the child, even when their exposure is codemode or
  deferred. An extension can deselect optional tools during child startup and
  enable them later. A parent with only `read` available gives such a delegate
  only `read`.

  Only tools that are active, or reachable through codemode or deferred
  exposure, when the launch starts are inherited. A tool an extension
  registers inactive and turns on later, for example through a loader tool
  that enables a group of tools on demand, does not reach a delegate unless
  the parent has already turned it on. To give every delegate such tools
  whatever the parent has active, list them in the `delegateTools` setting;
  to give them to particular agents, name them in those agents' `tools`. The
  child's own copy of the extension can then turn them on as it would in any
  session.
- An empty `tools` field, `tools:` or `tools: []`: the delegate gets no tools
  except the `delegateTools` entries. With none of those either, it starts
  with `--no-tools`.
- A `tools` list of tool names: exactly those tools, plus the
  `delegateTools` entries. A `$name` entry stands for the tools of that
  bundle in the `toolBundles` setting (see below).
- A `tools` list of only `-name` entries (`tools: -bash, -write`): the
  parent's tools, as with no `tools` field, less those, plus the
  `delegateTools` entries. A `-name` entry may be a `*` pattern
  (`-mcp__docs__*`).
- A `+name` entry, a `-$name` entry, a `$name` entry naming no bundle, or
  tool names and `-name` entries in one list, make the file invalid, and the
  agent is disabled (see below).

`toolBundles` in `<agent dir>/squire/settings.json` names tool lists that
several agents share:

```json
{ "toolBundles": { "readonly": ["read", "grep", "find", "ls"] } }
```

An agent then writes `tools: [$readonly, pstack_models]`, which reads as
`read, grep, find, ls, pstack_models`; a name listed twice counts once. A
bundle name starts with a letter or digit, then uses letters, digits, `_` or `-`; each entry is one tool name or
`*` pattern, with no comma and no leading `+`, `-` or `$`, so bundles do not
nest. A bundle carries tools only, not permission rules. The setting is read
with the roster. A setting that is not an object of such lists, or a settings
file that cannot be read or is not a JSON object, disables every agent that
uses a bundle, with the reason naming the file; agents without bundles are
unaffected by the setting itself. (`$`, unlike `@`, may start a plain YAML value.)

The delegation tools (`delegate`, `delegation_status`, `delegation_close`,
`delegation_resume`, `delegation_fork`) are removed from ordinary tool selections. An opted-in
coordinator below `maxDepth` receives them automatically; a leaf has them
inactive. Commands are still registered but cannot bypass admission. See the
experimental [nesting restrictions](nesting.md#nested-delegation).

The delegate's result reaches the parent through the `message:*` provider's
reply hook when squire settles the task, not through a tool, so a short `tools` list cannot
stop it answering. To let a delegate message its parent mid-task, whatever its
`tools`, list the tools your `message:*` provider gives a session for that in
the `delegateTools` setting, in `<agent dir>/squire/settings.json` beside
`windowPlacement` and `worktreeRoot`:

```json
{ "delegateTools": ["<tool or pattern>"] }
```

Each entry, a tool name or `*` pattern, is added to every delegate's tools,
whether they come from its agent's `tools` or from the parent (after any
`-name` entries are taken off), and passed to `--tools` unchanged. The setting
is empty by default, is read at each launch and resume, and a value that is
not a list of names, or an entry that holds a comma or starts with `+` or
`-`, refuses every launch with an error naming the file, before the task is sent or a window
opens; it does not disable agents one by one.

A `model` or `fallback` entry that is an exact `provider/id` in Pi's registry
is checked as before: a model without credentials or with an active
usage-limit mark is skipped for the next candidate. Anything else, such as an
alias, goes to the child's `--model` unchanged, and Pi resolves it to one
model; if Pi cannot, the child's Pi reports the error and its window closes
without a result. When a running delegate moves to a fallback after a usage
limit, it resolves each entry the way Pi resolves `--model`: an exact
`provider/id`, or a bare id or alias such as `sonnet`, to one model, in the
order the entries are listed. No entry may be a `*` pattern: a `model` or
`fallback` entry with `*` makes the file invalid, and the agent is disabled.

Each run of the delegate also gets a system-prompt section naming the parent
session's address. The delegate's task arrives as a message from that
session, and that message and every later one from the same address are
instructions to follow as given. Other sessions are colleagues: the delegate
may answer them, but checks with the parent before doing work the parent did
not ask for. Its final message reaches the parent on its own. The section also
asks for a short report that leads with the conclusion, long detail in a named
file, a file re-read only if it changed or its needed contents are no longer
in context, and a status check repeated only after waiting. It names no provider, package or tool, so it holds whatever
`message:*` provider delivers the task. `prompt_mode: replace` appends the
body as written.

An agent file that cannot be used is invalid, and its agent is disabled:
frontmatter that is not readable YAML or not a set of fields, an `enabled`,
`auto_exit`, `skills` or `context_files` that is not `true` or `false`, a
`tools` value that is not a list,
a `tools` list with a `+name` entry or with tool names and `-name`
entries mixed, a `tools` or `fallback` YAML list entry holding a comma, or a
`model` or `fallback` entry with a `*` pattern. A disabled agent is left
out of the roster and of the `delegate` tool's description, so the model never
picks it, and a warning names the file and the reason when the session starts
(and before a run, when a file turns invalid while the session runs). A call
or resume that names it anyway is refused with that reason. A
field that cannot be used (a `fallback` that is not a list, an unknown
`thinking`, `prompt_mode` or `locked` entry) is dropped with a warning and the
agent still loads. While the retired `<agent dir>/squire/agents/` folder
exists, a warning says to move each `<name>/AGENT.md` to
`<agent dir>/agents/<name>.md`. With no agents at all, `/delegate` says how to
add one and, in interactive Pi, offers an opt-in minimal scout with a file
preview and scope choice. See the [first-use path](../README.md#first-use) and
[bootstrap details](delegation.md#new-delegate-form).
