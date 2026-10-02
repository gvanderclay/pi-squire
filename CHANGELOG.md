# Changelog

All notable changes to this package are recorded here, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. The package
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Breaking

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

[Unreleased]: https://github.com/gvanderclay/pi-squire/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/gvanderclay/pi-squire/releases/tag/v0.1.0
