# pi-squire

A Pi extension that hands a task to a delegate Pi session in a background tmux
window: the `/delegate` command and the `delegate`, `delegation_status` and
`delegation_close` tools. It needs a `message:*` provider such as
[pi-session-mail](https://github.com/gvanderclay/pi-session-mail).

## Layout

- The extension is the `.ts` files in `src/`. `src/index.ts` is the entry Pi
  loads; `child.ts` is what a delegate itself registers, `agents.ts` reads
  the roster, `results.ts` handles replies and `tmux.ts` talks to tmux.
- Tests and their helpers (`harness.ts`, `fake-tmux.ts`) are in `test/`.
  Nothing under `test/` is published; `scripts/check-pack.mjs` enforces that.

## Checks

- `pnpm check` runs lint (`biome ci .`), typecheck (`tsc -p .`) and the
  tests. Run it before every commit; CI runs the same on Node 22.19 and 24,
  with a fresh `HOME` and no `PI_CODING_AGENT_DIR`.
- A single file: `node --test test/hooks.test.ts`.
- `node scripts/check-pack.mjs` after changing `package.json` `files` or adding
  a file under `src/`. Every `.ts` file under `src/` must be packed.
- `biome.json` relaxes some rules for the files that predate this repository
  (one override per file). New files get the full rules; do not add a file to
  an override to get past a rule.

## Changes

- Never commit to `main`: a ruleset refuses pushes there. Work on a branch,
  open a pull request with `gh pr create`, and merge with
  `gh pr merge --squash --auto`; it merges once the `check` and `pack` jobs
  pass. The pull request title becomes the commit message.
- Repository settings and rulesets live in `.github/repo-settings.json`.
  Change them there, in a pull request, then apply them with
  `node scripts/repo-settings.mjs` (`--dry-run` first); never in GitHub's UI.
- Fill in `.github/pull_request_template.md`. `CONTRIBUTING.md` is the
  human-facing copy of these rules; keep the two in step.
- Add each user-visible change under `## [Unreleased]` in `CHANGELOG.md` as
  it lands. Never edit `version` or tag by hand; see Releases.

## Releases

- Release with `pnpm release patch` (or `minor`, `major`) on an up-to-date
  `main`: it bumps the version, moves the CHANGELOG entries and opens a
  release pull request set to auto-merge. It refuses when `[Unreleased]` is
  empty. Once that merges, `release.yml` sees an untagged version on `main`,
  checks, tags, publishes to npm by trusted publishing, and makes the GitHub
  release.

## Rules

- The tests pin current behaviour. A change that makes one fail changes
  behaviour: update the test only when the change is deliberate, and say so
  in the commit and in `CHANGELOG.md`.
- `test/hooks.test.ts` runs every ```` ```js <name> ```` code fence in
  `README.md` against the extension, and fails on a fence it has no runner
  for. The README examples are therefore the hook contract: editing one is a
  contract change for every extension that uses the hook, not a docs fix.
- `session:launch` is a contract this package provides; the `message:*` hooks
  are contracts it consumes, owned by the provider's README.
- The `delegate` tool, the `/delegate` command and the `[delegate]` result
  text keep their names; the package is `pi-squire`.
