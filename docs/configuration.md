# Configuration

[Home](../README.md) · [Agents](agents.md) · [Troubleshooting](troubleshooting.md)

- [Files and read policy](#files-and-read-policy)
- [Setting reference](#setting-reference)
  - [multiplexer](#multiplexer)
  - [windowPlacement](#windowplacement)
  - [companionSuffix](#companionsuffix)
  - [maxDepth](#maxdepth)
  - [maxConcurrentDelegates](#maxconcurrentdelegates)
  - [maxDelegatesPerRoot](#maxdelegatesperroot)
  - [delegateTools](#delegatetools)
  - [toolBundles](#toolbundles)
  - [worktreeRoot](#worktreeroot)
  - [worktreeRootByRepo](#worktreerootbyrepo)
  - [resultBodyKiB](#resultbodykib)
  - [delegateWidgetPlacement](#delegatewidgetplacement)
  - [delegateWidgetMaxEntries](#delegatewidgetmaxentries)
- [Parent guidance and launch environment](#parent-guidance-and-launch-environment)

## Files and read policy

`<agent dir>/squire/` holds the optional parent guidance file and
`settings.json` (`multiplexer`, `maxDepth`, `maxConcurrentDelegates`, `maxDelegatesPerRoot`,
`windowPlacement`, `companionSuffix`, `worktreeRoot`, `worktreeRootByRepo`, `delegateTools`, `toolBundles`,
`resultBodyKiB`, `delegateWidgetPlacement` and `delegateWidgetMaxEntries`); `routing.json` is
the separate optional v1 policy for agents with `routing_profile` (see
[Role/task routing](routing.md#role-task-routing)). The agents live in
`<agent dir>/agents/` (see [Agents](agents.md#agents)).
`settings.json` is read when a setting is needed, never cached, so a change
applies to the next launch. A missing file means every default. A file that
cannot be read, is not JSON or is not an object refuses every launch, resume
and fork with an error naming the file, as does an invalid value of a setting
that affects launching or limits. The exceptions: deciding whether to expose
the delegation tools treats such a file as `maxDepth` 1, `toolBundles`
problems disable only the agents that use a bundle, an invalid `resultBodyKiB`
warns and the result uses the default budget, and widget setting problems show
one warning and use the widget defaults.

## Setting reference

All settings below live in `<agent dir>/squire/settings.json`, shared by sessions
using that agent directory; these are not project `.pi/settings.json` keys.
`<agent dir>` is `~/.pi/agent` or `PI_CODING_AGENT_DIR`. A missing file means
defaults. Malformed JSON, inaccessible files and non-object top levels refuse
admission even when only a cosmetic/creation setting was intended. Exceptions
for tool exposure, bundle users, result delivery and widget display are explicit
below. Unknown keys are ignored. A key is validated when its reader needs it,
not all keys on every call.

### multiplexer

| Property | Value |
| --- | --- |
| Type | `"tmux"` or `"herdr"` |
| Default | Auto-detect, or inherited delegate backend |
| Scope | Terminal host for new launches; ignored when Paseo hosts Pi |
| When read | Each launch/resume/fork, frozen before effects |
| Invalid value / file | Refuses terminal launch and names file; chosen unusable host never falls back. |

[Host selection](hosts.md#choosing-tmux-or-herdr).

### windowPlacement

| Property | Value |
| --- | --- |
| Type | `"companion"` or `"current"` |
| Default | `"companion"` |
| Scope | Tmux placement; existing windows unchanged |
| When read | Each launch/resume/fork |
| Invalid value / file | Refuses launch and names file. |

[Placement](hosts.md#where-delegate-windows-open).

### companionSuffix

| Property | Value |
| --- | --- |
| Type | String: 1–32 ASCII letters, digits, `_`, `-`; no edge hyphen or numeric final segment |
| Default | `"delegates"` |
| Scope | New root companion preference; does not replace saved nested/resume preference |
| When read | With tmux placement at launch |
| Invalid value / file | Refuses launch and names file, even if placement is current. |

[Companions](hosts.md#where-delegate-windows-open).

### maxDepth

| Property | Value |
| --- | --- |
| Type | Positive safe integer (JSON `null` also uses the default) |
| Default | `1` (root → direct child only) |
| Scope | Delegation depth across the root tree; agent grant still required |
| When read | Tool exposure and every launch/resume/fork admission |
| Invalid value / file | Invalid value refuses, naming file. A broken file uses depth 1 for exposure only; admission refuses it. |

[Nesting](nesting.md#nested-delegation).

### maxConcurrentDelegates

| Property | Value |
| --- | --- |
| Type | Nonnegative safe integer; `0` means unlimited |
| Default | `16` when maxDepth > 1; otherwise `0` |
| Scope | Unfinished delegations tree-wide, including waiting coordinators |
| When read | Every admission, under shared tree lock |
| Invalid value / file | Refuses admission and names file; lowering a valid cap never kills work. |

[Tree budgets](nesting.md#tree-wide-launch-budgets).

### maxDelegatesPerRoot

| Property | Value |
| --- | --- |
| Type | Nonnegative safe integer; `0` means unlimited |
| Default | `64` when maxDepth > 1; otherwise `0` |
| Scope | Lifetime launches per root session, including resumes |
| When read | Every admission, under shared tree lock |
| Invalid value / file | Refuses admission and names file. Completion never refunds lifetime use. |

[Tree budgets](nesting.md#tree-wide-launch-budgets).

### delegateTools

| Property | Value |
| --- | --- |
| Type | Array of nonempty tool names or `*` patterns; one per entry, no comma or leading `+`/`-` |
| Default | `[]` |
| Scope | Adds tools to every delegate after its selection/exclusions |
| When read | Each launch/resume/fork |
| Invalid value / file | Refuses every launch and names file; does not disable individual agents. |

[Tool selection](agents.md#agents).

### toolBundles

| Property | Value |
| --- | --- |
| Type | Object of bundle name → tool-name/pattern arrays; name starts alphanumeric then letters/digits/`_`/`-`; entries have no comma or leading `+`/`-`/`$` |
| Default | `{}` |
| Scope | Agent `tools: [$name]` expansion; no permission policy or nesting of bundles |
| When read | With roster reads at call time |
| Invalid value / file | Bad setting or broken file disables agents that reference bundles; others are unaffected by this setting itself. Broken shared file still refuses admission. |

[Bundles](agents.md#agents).

### worktreeRoot

| Property | Value |
| --- | --- |
| Type | Nonempty template string; must contain `{branch}`; only `{repoParent}`, `{repo}`, `{branch}` placeholders |
| Default | `"{repoParent}/{repo}-worktrees/{branch}"` |
| Scope | Destination for managed creation, unless a matching repository override wins |
| When read | Managed worktree creation only |
| Invalid value / file | Invalid template refuses creation; does not affect inherited/cwd launches. Broken shared file still refuses admission. |

[Managed worktrees](workspaces.md#managed-worktrees).

### worktreeRootByRepo

| Property | Value |
| --- | --- |
| Type | Object of nonempty repository path → valid worktree template string |
| Default | `{}` |
| Scope | Canonical main-checkout-specific overrides, before worktreeRoot |
| When read | Managed worktree creation only; all entries validated |
| Invalid value / file | Bad template, unresolved key or duplicate canonical key refuses creation. Other launch modes ignore creation-key errors. |

[Templates and path resolution](workspaces.md#managed-worktrees).

### resultBodyKiB

| Property | Value |
| --- | --- |
| Type | Safe integer, 4–64 KiB |
| Default | `32` (8 KiB head + 24 KiB tail) |
| Scope | Result body budget; full reply remains in provider envelope |
| When read | When a result arrives |
| Invalid value / file | Warns and uses default, including on broken shared file; a claimed reply must still be delivered. |

[Result truncation](results-and-recovery.md#results).

### delegateWidgetPlacement

| Property | Value |
| --- | --- |
| Type | `"above"` or `"below"` |
| Default | `"above"` |
| Scope | Interactive widget placement for roots and coordinators |
| When read | About once a second while interactive view runs |
| Invalid value / file | Warns once per distinct error and uses widget defaults, including on broken shared file. |

[Widget](delegation.md#delegate-overview).

### delegateWidgetMaxEntries

| Property | Value |
| --- | --- |
| Type | Nonnegative safe integer |
| Default | `3`; `0` hides child rows, not ancestors, and restores count footer |
| Scope | Visible child-entry cap across expanded depths, not physical line count |
| When read | About once a second while interactive view runs |
| Invalid value / file | Warns once per distinct error and uses widget defaults, including on broken shared file. |

[Widget](delegation.md#delegate-overview).

## Parent guidance and launch environment

`delegation_prompt.md` is Markdown, inserted unchanged as the
`squire_parent_delegation` system-prompt section before each new run, including
a run started by an idle delegate result. It is not a conversation or user
message, is not duplicated in the `delegate` tool description or guidelines,
and is not copied into the launched child's prompt. An opted-in coordinator
reads this same file for its own parent role. The guidance is added only while the `delegate`
tool is active and not hidden; when delegation is inactive or hidden, the
section is removed and tool selection is left as it was. A missing or whitespace-only
file adds no section. Editing the file replaces the section at the next run;
deleting it removes the section. A read failure other than a missing file
warns with the path, removes stale guidance for that run, and leaves otherwise
valid delegation working. The package ships no default delegation or approval
policy.

Refresh happens before a new run, not before every model request in a tool
loop, and the extension does not watch the filesystem. `pi-squire` uses launch variables to bootstrap a delegate; durable session
identity takes precedence when it reopens. A tmux window starts with the tmux
server's environment plus `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`
(when set; `--session-dir` outranks it), and these delegate values:

- `PI_DELEGATE_PARENT`: direct parent's session id;
- `PI_DELEGATE_ROOT`: root session id;
- `PI_DELEGATE_DEPTH`: child depth as a decimal string;
- `PI_DELEGATE_AGENT`: this child's roster identity (not display name);
- `PI_DELEGATE_CHAIN`: comma-separated agent names, root downward, including
  the child last, e.g. `coordinator,worker`; names label requests, session ids route them;
- `PI_DELEGATE_AUTO_EXIT`: `1` or `0`;
- `PI_DELEGATE_MULTIPLEXER`: `tmux`, `herdr` or `paseo`, the backend that
  opened it (see [Choosing tmux or Herdr](hosts.md#choosing-tmux-or-herdr) and
  [Paseo support](hosts.md#paseo-support));
- `PI_DELEGATE_FALLBACK`: remaining model candidates, when any.

Every host copies `PI_SESSION_MAIL_ROOT` and `XDG_STATE_HOME` on new launches
(and on resumes and forks where supported) when present in the launching Pi's
environment, including empty or relative values; Squire does not resolve them.
Tmux and Paseo receive selected parent variables, not the whole environment.
Herdr starts with the parent's full environment, excluding routing/launch
identity as described under [Tabs](hosts.md#tabs).
With pi-session-mail, only absolute values select a location: an absolute
`PI_SESSION_MAIL_ROOT` wins, otherwise an absolute `XDG_STATE_HOME` selects its
`pi-session-mail/` subdirectory, otherwise the provider uses its home default.
Unset keys are not overridden in the host environment, including the new
Herdr pane's own environment. If that pane, the tmux server or the Paseo daemon
supplies different values or defaults (including a different home directory),
unset or non-absolute parent values can still split the mailboxes. Set an absolute
`PI_SESSION_MAIL_ROOT` in the parent to keep mail in the same namespace;
pi-session-mail 0.7.1 exposes no effective-root hook for Squire to query.

It always gets `PI_UNATTENDED=1`.
`PI_UNATTENDED=1` is a general signal, not specific to pi-squire: no human is
watching this session, even though it runs in a TUI. Other extensions may read
it to skip a dialog or confirmation instead of waiting on one, and any other
runner that starts Pi unattended can set it too. Anything else the
parent process has, such as a `CLAUDE_CONFIG_DIR` set by a shell alias,
reaches a tmux or Paseo child only through a `session:launch` contributor;
Herdr also inherits the parent's environment as described above. `--model` and
`--thinking` override the agent's defaults for one call, unless the agent
locks them (see [Agents](agents.md#agents)). For a bound role, `--model` without
`--routing` launches it outside its routing profile; with `--routing`, the
overrides apply only within the eligible route (see
[Role/task routing](routing.md#role-task-routing)).
An unknown value is refused with close matches, and so is a model with no
configured credentials. For tmux and Paseo, an API key present only in the
parent's environment does not reach the delegate: log in through Pi, supply it
through a `session:launch` contributor, or set it in the tmux server's or
Paseo daemon's environment respectively. Herdr inherits API keys from the
parent's environment. `--auto-exit` and `--no-auto-exit` override the agent's
`auto_exit`.
