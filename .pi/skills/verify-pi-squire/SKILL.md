---
name: verify-pi-squire
description: Drives a real Pi with this checkout's pi-squire and pi-session-mail in a private tmux server, or a private named Herdr session hosted by one, on a cheap model, to prove delegate, result, auto-exit, status, close, resume, fork and Herdr restart behavior the way a user sees it. Use when a change to src/ needs proof beyond the unit tests, or to reproduce a delegation bug.
---

# Verify pi-squire

This skill runs the real thing: the repository's pinned Pi (`node_modules/.bin/pi`) with this checkout's `src/index.ts` and the pinned `pi-session-mail`, in a tmux server of its own, with a scratch agent directory. Every Pi session it starts, the root and every delegate, runs on `opencode-go/deepseek-v4.1-flash` at thinking `low`. A full feature pass costs well under a cent.

All commands go through one helper. Run it from the repository root (or a worktree root):

```bash
node .pi/skills/verify-pi-squire/scripts/squire-verify.mjs --help
```

Every command prints one JSON object. `"ok": false` means it failed, with the reason in `error`.

## Launch

1. `pnpm install` once per checkout. The helper needs `node_modules/.bin/pi` and `node_modules/pi-session-mail`.
2. The helper needs an OpenCode key. It takes `OPENCODE_API_KEY` from your environment, or else the `api_key` entry for the model's provider in your own Pi `auth.json` (in `PI_CODING_AGENT_DIR`, or `~/.pi/agent`), running it first if it is a `!command`. It passes only that key to the private tmux server, and every Pi in the run reads it from there. The run's agent directory never gets your `auth.json`, so the run cannot write your credentials or use another provider's.
3. Start a run:

   ```bash
   node .pi/skills/verify-pi-squire/scripts/squire-verify.mjs launch --run <id>
   ```

   Omit `--run` for a timestamped id. It creates `.scratch/verify-pi-squire/<id>/`:

   | Path | What |
   | --- | --- |
   | `agent/` | Scratch `PI_CODING_AGENT_DIR`: `settings.json` loading this checkout and `node_modules/pi-session-mail`, `defaultProjectTrust: "never"`, and `agents/verifier.md` (deepseek, low, tools `read, ls`) |
   | `work/` | A one-commit Git repository; the root and its delegates run here |
   | `state/` | Holds `pi-session-mail/`, the run's `PI_SESSION_MAIL_ROOT`, so its mailboxes stay in the run. `XDG_STATE_HOME` is left alone, so other tools keep the user's state |
   | `tmp/` | `TMPDIR`, so Squire's prompt files stay in the run |
   | `evidence/` | Proof artifacts; cleanup never touches it |
   | `run.json` | Commit under test, whether `src/` was dirty, model, tmux socket, root session file |

   It starts tmux on socket `squire-verify-<id>` (`tmux -L squire-verify-<id>`), session `root`, window `root`, running the root Pi with `--tools read,ls,delegate,delegation_*,session_mail_*` (no bash, edit or write). The environment has every `PI_*`, `TMUX*` and `HERDR*` variable removed (`self-test` checks this without starting anything), so an agent running this from inside Pi or tmux does not leak its own session into the run.

   Ready means the root's footer shows `deepseek-v4.1-flash • low`, which appears once the TUI has its model. Launch waits up to 60 s and saves the pane to `evidence/launch-pane.txt`.

4. With `--herdr` (and optionally `--herdr-integration`), launch instead starts a private named Herdr session `squire-verify-<id>` with its own `herdr.toml` (`HERDR_CONFIG_PATH`), inside a `host` window of the run's tmux server, and runs the root Pi in pane `w1:p1`. No `multiplexer` setting is written, so it also proves auto-detection. `type`, `delegate`, `capture`, `windows` and `cleanup` then act on Herdr. `herdr --args` passes through only read/type probes under the run's `--session` and rejects session, server and scope-changing flags; `herdr-restart` and `cleanup` are the only lifecycle commands, and touch only `squire-verify-<id>`. See [features/herdr.md](features/herdr.md). It never addresses Herdr's `default` session or your config.
5. Delegate windows (tmux runs) open in a second tmux session on the same socket, chosen by Squire's [window placement](../../../README.md#where-delegate-windows-open). In the runs that proved this skill it was `work-delegate-session`; read the real name from the `delegate` command's output or `windows`.

Teardown is [Cleanup](#cleanup).

## Doctor

```bash
node .pi/skills/verify-pi-squire/scripts/squire-verify.mjs doctor --run <id>
```

Read-only. Exits 1 unless every check passes: an OpenCode key found, tmux server up, root window alive, root footer shows the model, the run's settings load this checkout and pi-session-mail, and the checkout is still at the commit the run started on. It also reports the root session file, which Pi only writes with the session's first entry, so it reads "not written yet" before the first command. Run it first whenever anything looks off.

## Drive

Two ways to act, matching the two ways a user does:

- **The `/delegate` command**, typed into the root. No model is involved in the parent:

  ```bash
  node .pi/skills/verify-pi-squire/scripts/squire-verify.mjs delegate --run <id> --label <label> [--no-auto-exit] [--task "<text>"]
  ```

  Without `--task`, the task is "Reply with exactly the text SQUIRE-<label>-<random> and nothing else." and the JSON returns that `nonce`. It waits for Squire's `delegate: verifier <id> started in window verifier-<label> in session <session>` notice and returns the delegation `id`, `window` and `session`. Labels are letters, digits, `_` or `-`.

- **A Squire tool, called by the root model**:

  ```bash
  node .pi/skills/verify-pi-squire/scripts/squire-verify.mjs ask --run <id> --tool <tool> --text "<prompt>"
  ```

  It types the prompt and waits for the next result of `<tool>` in the root session file, then returns its `text`, `details` and `isError` and saves the entry as evidence. Name the tool and every argument in the prompt, for example `Call the delegation_status tool with id <id>, then reply with only its output, verbatim.`

To wait for a delegate's answer:

```bash
node .pi/skills/verify-pi-squire/scripts/squire-verify.mjs wait-result --run <id> --nonce <nonce> [--timeout 180]
```

It finds the root's `custom_message` entry of `customType: "delegate"` whose text holds the nonce, and returns the delegation id, `status` (`done`, `failed` or `stopped`), the delegate's session file and its last answer with the model that wrote it, plus the run's current tmux windows.

Other commands: `type --run <id> --text "<line>"` types any line into the root and presses Enter; `windows --run <id>` lists every window on the run's socket; `capture --run <id> --name <name>` saves each window's pane text.

The feature map in [`features/`](features/README.md) has the recipe for each user-facing feature.

## Evidence

Everything goes to `.scratch/verify-pi-squire/<id>/evidence/`:

- `launch-pane.txt`: the root pane at ready.
- `result-<nonce>.json`: the root session's delegate result entry, written by `wait-result`.
- `tool-<tool>-<entry id>.json`: a Squire tool result from the root session, written by `ask`.
- `<name>-<window>.txt`: pane text, written by `capture`.

Session files (`agent/sessions/**.jsonl`), Squire's state (`agent/squire/`) and the mailboxes (`state/pi-session-mail/`) stay in the run folder and survive cleanup too.

Proof standards for this repository:

- Drive the user path: the `/delegate` command or a model tool call. Never write Squire's state files or call its modules directly.
- A result proves delivery only when it holds the nonce in the **root session file** and the delegate's own session holds the same text from `opencode-go/deepseek-v4.1-flash`. Pane text alone is not proof; it can show a stale notice.
- Check side effects alongside the message: the window list (auto-exit, close), the tool's `details` (close member outcomes, resume ids).
- Record `run.json`'s `commit` and `srcDirty` with any claim. A proof from a dirty `src/` covers the working tree, not the commit.

## Cleanup

```bash
node .pi/skills/verify-pi-squire/scripts/squire-verify.mjs cleanup --run <id>
```

For a Herdr run it first runs `herdr session stop` and `herdr session delete` for `squire-verify-<id>` only. It runs `tmux -L squire-verify-<id> kill-server`: only this run's server, which holds the root and every delegate it started. It never kills by process name and never touches the user's own tmux server. The JSON lists the evidence files still present; check it is non-empty.

Leave the run folder in place. It is under `.scratch/`, which Git ignores. Pi writes an empty `agent/auth.json` there, and the permission rules forbid deleting files named `auth.json`, so do not try to remove the folder.

## Helpers

- `scripts/squire-verify.mjs`: the only helper. Node 22.19 or later, no dependencies. `--help` lists every command. `SQUIRE_VERIFY_MODEL` and `SQUIRE_VERIFY_THINKING` override the model and thinking for one run.

## Model level

`low` was enough for every recipe in the feature map when it was written: the delegate only has to echo a nonce, and the root model only has to make the one named tool call. If a run fails because deepseek did the wrong thing (no tool call, wrong tool, an answer that is not the nonce) rather than Squire, rerun with `SQUIRE_VERIFY_THINKING=high`, then `max`, and note it under that feature's Gotchas. Do not switch to a more expensive model.
