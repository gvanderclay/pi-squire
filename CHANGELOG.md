# Changelog

All notable changes to this package are recorded here, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. The package
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
