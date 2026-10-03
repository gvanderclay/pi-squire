# Changelog

All notable changes to this package are recorded here, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. The package
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- A delegate whose run ends on a usage-limit error (a quota message, or a
  `429` that survived Pi's retries) records a mark in
  `pi-squire-limits.json` in Pi's agent directory. Every Pi session then
  refuses to launch a delegate on a marked model until the mark clears.
- A usage-limit mark clears at the reset time in the failed response's headers
  (`retry-after`, `anthropic-ratelimit-*-reset`, `x-ratelimit-reset-*`) when
  Pi reports them, ahead of the time in the error text.
- An agent's `fallback:` frontmatter (comma-separated or a YAML list of
  `provider/id`) names models to launch on, in order, when its `model` is
  usage-limited or unusable. The tool result and the command notice name the
  substitute and the skipped model; the call is refused only when every
  candidate is skipped. An explicit `model` is never substituted.
- A `failed` result from a delegate that recorded a usage-limit mark gets a
  `Usage limit:` line after `Status:`, naming the scope and clear time.
  `delegation_status` ends with a `Usage-limit marks:` block of the active
  marks, and its details gain `marks`.
- `/delegate-clear <all|provider|provider/model>` removes usage-limit marks and
  their repeat-hit history. An argument matching no active mark changes
  nothing and lists the active marks. No tool can clear marks.
- Before a launch on a paid `opencode-go` model, pi-squire reads the OpenCode
  Go quota (cached for 60 seconds). A window at 100% or `rate-limited` skips
  the model and records a `proactive` mark that clears at the window's reset
  time. A failed reading never blocks a launch: the result and notice say
  "Could not read opencode-go quota: …; launched without a proactive check.",
  and `delegation_status` shows the error in `readingErrors` until a later
  reading succeeds. `/delegate-clear` also drops the cached reading. A proactive
  mark that cannot be written does not stop the launch.

## [0.2.2] - 2026-10-02

### Fixed

- The README links `CONTRIBUTING.md` on GitHub, since it is not in the npm
  package and its relative link 404s on pi.dev.

## [0.2.1] - 2026-10-02

### Fixed

- A delegate's task now arrives as a user prompt labelled `[delegate]` instead
  of a `[mailbox]` message. Pi 1.0.0 started the injected message's turn
  without the system prompt, so a fresh delegate saw no context files, skills
  or role paragraph until after its first tool call, and could reject them as
  an injection (earendil-works/pi#5581).

## [0.2.0] - 2026-10-02

### Breaking

- A model without configured credentials is refused, by `/delegate` and the
  `delegate` tool alike, instead of failing in the delegate's window.
- A reply counts as a delegation's result only when it comes from the delegate
  (`envelope.from` equals the delegation's id); a reply to its request from any
  other sender is left to the provider as ordinary mail.
- Providers must set `envelope.from` to the sender's address.
- The `reply()` fixture in `test/poll.test.ts` now sends the delegation id as
  `from` instead of `"d"`, to match.

### Changed

- The sources moved to `src/`, so load the package directory (`pi -e .`), not
  `index.ts`. Installs through npm or git are unaffected.
- Each check (a poll tick, a `delegation_status` call, a `delegation_close`
  call) asks tmux once, however many delegations run, instead of once per
  delegation.
- The appended system prompt reaches the delegate as a path to a private file
  under the system temporary folder, so its text stays off the command line
  and out of `ps`. A `session:launch` listener now sees that path where the
  prompt text was. The argv tests in `test/delegate.test.ts` read the prompt
  from the file instead of from argv, a deliberate behaviour change.

### Fixed

- `delegation_status` details name a labelled delegation's session
  (`scout-roster`), as its text does, instead of `<agent>-<first 8 of the id>`.
- A recycled tmux window id is no longer mistaken for a delegate's window, nor
  killed: a window counts as the delegate's only when its id and its name both
  match.
- A delegate whose program exited in a window kept open (`remain-on-exit`)
  reads as gone instead of running.

### Added

- `session:launch` payloads carry the agent's name as `agent`.
- The README's Install section names its requirements: tmux 3.0 or later, Pi
  0.80.5 or later, the first installable release with `agent_settled` (tested
  with Pi 1.0.0), macOS and Linux, and
  `pi install npm:pi-session-mail` as an example `message:*` provider.
- A README "Compatibility" section names the contracts other extensions rely
  on, the below-1.0 rule that breaking one bumps the minor version, and what a
  `message:*` provider must do.

## [0.1.0] - 2026-10-02

The first public release. Before this repository the package lived in its
author's dotfiles; the changes below are against that copy.

### Added

- Published to npm as `pi-squire`.
- MIT license and package metadata, including `engines` (Node 22.19 or later).
- CI on Node 22.19 and 24: lint, typecheck, tests, and a check of the
  published file list.

### Fixed

- The published file list includes `child.ts`, which `index.ts` imports.

[Unreleased]: https://github.com/gvanderclay/pi-squire/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/gvanderclay/pi-squire/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/gvanderclay/pi-squire/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/gvanderclay/pi-squire/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/gvanderclay/pi-squire/releases/tag/v0.1.0
