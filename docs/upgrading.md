# Upgrading

[Home](../README.md#update-and-uninstall) · [Changelog](../CHANGELOG.md) · [Troubleshooting](troubleshooting.md)

- [Update packages and runtimes together](#update-packages-and-runtimes-together)
- [Migrate old agent files](#migrate-old-agent-files)
- [Host-selection and placement changes](#host-selection-and-placement-changes)
- [Durable records and downgrade refusal](#durable-records-and-downgrade-refusal)
- [Before uninstalling](#before-uninstalling)

## Update packages and runtimes together

Use `pi list` to identify your configured sources and scope. For unpinned npm
installs, update both sides of the task/reply contract:

```bash
pi update npm:pi-session-mail
pi update npm:pi-squire
```

`pi update --extensions` updates all configured packages; plain `pi update`
updates Pi itself. An exact npm version, Git tag or commit stays pinned.
Reinstall the desired version/source with `pi install`; use `--local` for a
project declaration, from that project with its trust resolved. Do not accidentally
replace a project pin with a separate personal declaration. Package command
syntax is Pi 1.5.2's (`pi --help`, `pi update --help`, `pi remove --help`).

Upgrade pi-session-mail and Squire together, then restart/reload both parent and
delegate runtimes. A provider must implement `message:send`, `message:reply`,
`message:inbound` and `message:scan`; pi-session-mail ≥0.6.0 does (Squire's tests
pin 0.7.1). There is no version negotiation or legacy automatic-answer path.
See [provider contract](integrations.md#compatibility).

## Migrate old agent files

Use `auto_exit`, not the retired `auto-exit` frontmatter key:

```yaml
auto_exit: false
```

Old `auto-exit` and `extensions` fields are silently ignored, even malformed
values and missing extension paths. **An old `auto-exit: false` no longer keeps
the delegate open**: without `auto_exit: false` or a call override, auto-exit is
on. Agent-specific extension loading was removed from launch/resume; use normal
Pi discovery or a reviewed `session:launch` contributor. The command flags
`--auto-exit` / `--no-auto-exit`, `/auto-exit`, and `PI_DELEGATE_AUTO_EXIT` did not
change. `exclude-tools` warns and is no longer read; migrate to `tools`.
Move retired `<agent dir>/squire/agents/<name>/AGENT.md` files to
`<agent dir>/agents/<name>.md`. See [agent validation](agents.md).

## Host-selection and placement changes

Without `multiplexer`, detecting both tmux and Herdr now refuses rather than
assuming tmux. Set `{ "multiplexer": "tmux" }` to keep that choice; Paseo-hosted
Pi always uses Paseo. Existing records continue using their recorded backend.
See [host selection](hosts.md#choosing-a-terminal-host).

Tmux companions now default to `<project>-delegates`; existing names (including
`<project>-delegate-session`) are not renamed. Nested launches and resumes keep
the saved root preference. There is no directory rename/relocation tracking or
companion repair. See [placement](hosts.md#where-delegate-windows-open).

## Durable records and downgrade refusal

Keep the same agent directory when reopening the exact session. Retain identity,
child-task, tree, owner and task-reply/outbox records alongside session files and
mail; a transcript alone does not replace those obligations. Do not reset a
registry to regain capacity or discard a frozen answer to clear an error.

A Squire older than Paseo/opaque-locator support cannot safely read those trees
and refuses the whole tree. Tree registry versioning fences older writers;
unknown versions and downgrade writes refuse rather than overwrite the record.
Upgrade every Pi that reads a shared tree instead of moving one runtime back.
Persisted routed history also prevents removing/changing a role's profile to
fall back to legacy selection. See [routing history](routing.md#request-metadata-and-selection).

Delegations missing required original-root placement identity cannot be resumed,
even by their original root. Tool, command and picker refuse before trust,
reservation, mail or window effects; there is no identity migration or synthesis.
For such history, inspect the absolute session path for manual recovery, or
start fresh work as appropriate; manual reopening does not grant resume authority.
See [resume](results-and-recovery.md#resuming-a-delegation).

## Before uninstalling

Close tasks and inspect/merge/back up/clean managed resources while Squire is
still loaded. Then remove the configured source in its original scope; see
[uninstall](../README.md#update-and-uninstall). Removal is not permission to
delete user agent files, running delegates, worktrees, durable records or mail.
