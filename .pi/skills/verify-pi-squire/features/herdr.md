# Herdr runs: parity, auto-detection and restart

A `--herdr` run hosts its root Pi in pane `w1:p1` of a private named Herdr session (`squire-verify-<id>`, private `herdr.toml` via `HERDR_CONFIG_PATH`), itself hosted by the run's private tmux server. With no `multiplexer` setting, delegates open as Herdr tabs because the root has only a Herdr context. Every other recipe in this folder runs unchanged against it; `delegate` returns `tab` and `session` is the workspace.

## Sub-features

- Auto-detection: no setting, Herdr-only context, delegates open in tabs; a tmux run with no setting opens windows.
- Fork, resume and nested delegates open flat tabs in workspace `w1`.
- After a Herdr restart, pre-restart delegations are not running and resume refuses, naming the restored tab; `delegation_close` leaves the restored tab alone.

## How to get to it (user POV)

Run Pi in a Herdr pane, with no `multiplexer` in `<agent dir>/squire/settings.json`, and `/delegate` as usual. Restart Herdr (`herdr session stop` + start) while a delegate runs, then try `delegation_resume` on it.

## Driving it with squire-verify

Preconditions: `herdr` 0.9.5 on PATH; your own Herdr Pi integration installed (`herdr integration status` shows `pi: current`) if you want restored tabs to report sessions. The run never addresses the `default` session or your config.

1. `launch --run <id> --herdr --herdr-integration`, then `doctor --run <id>`.
2. `delegate --run <id> --label first --no-auto-exit` and `wait-result`: the JSON has `tab: "w1:t2"`.
3. Fork: `ask --tool delegation_fork` with that id; the text says `in tab verifier-<id8> (w1:t3) in workspace w1`.
4. Quit the first delegate: `herdr --run <id> --args "pane send-text w1:p2 /quit"` then `--args "pane send-keys w1:p2 Enter"`; `windows` no longer lists `w1:t2`.
5. Resume: `ask --tool delegation_resume` with the first id and a nonce task; `wait-result` on that nonce. Note the new id and tab.
6. `herdr-restart --run <id>`: `before`/`after` keep pane/tab ids and change every `terminal`.
7. `ask --tool delegation_resume` with the resumed id: `isError: true`, text `Herdr tab verifier-first (w1:tN) already runs delegation session …`.
8. `ask --tool delegation_close` with that id: members are `absent`; `windows` still lists the restored tab.
9. Nested: write `agent/agents/coordinator.md` (tools `read, ls, delegate, delegation_status`, `allow_nested_delegation: [verifier]`) and `{"maxDepth": 2}` in `agent/squire/settings.json`, then `type --text "/delegate coordinator --label nest …"` asking it to delegate to verifier. The coordinator's session shows `in tab verifier-<id8> (w1:tN) in workspace w1`.
10. `cleanup --run <id>` stops and deletes only `squire-verify-<id>`; `herdr session list` no longer shows it.

## Gotchas

- The helper's `delegate` command always uses agent `verifier`; use `type` for another agent.
- `cleanup` may report `killed: false` for tmux: stopping the Herdr session already ended the host server.
- Without `--herdr-integration`, Herdr does not relaunch the run's Pis after a restart, so step 7 instead proves the shell-only restored pane path (resume proceeds and leaves the restored tab alone).
- Herdr keeps per-session state under `~/.config/herdr/sessions/<name>` until `cleanup` deletes the session.
