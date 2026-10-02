# Security

pi-squire starts a second Pi session, as the same user, in a tmux window. The
delegate runs with the same rights as the session that started it, so this
is not a sandbox. The security questions are what reaches the delegate's
process, and whether anything other than the parent can start one. This page
says which problems count as security bugs and how to report them.

## Reporting

Report privately through GitHub:
[open a security advisory](https://github.com/gvanderclay/pi-squire/security/advisories/new).
Do not open a public issue. Include the command or tool call, the agent file,
and the `session:launch` listeners you have installed.

## What reaches the delegate

- Arguments: the parent's own Pi command, the session id and name, the model,
  thinking level, the agent's `exclude-tools`, and a path to a private file
  holding the appended system prompt, made of the agent file's prompt and a
  note naming the parent. The task is not on the command line; it travels as
  mail through the `message:*` provider.
- Environment: tmux starts the window with the tmux server's environment plus
  `PI_CODING_AGENT_DIR`, `PI_DELEGATE_PARENT`, `PI_DELEGATE_AUTO_EXIT` and,
  when set, `PI_CODING_AGENT_SESSION_DIR`.
- `session:launch` listeners may append arguments and add environment
  variables. Any installed extension can do this, and pi-squire passes them on
  unchanged. A listener also sees the agent's name, as the `agent` field of the
  payload. Environment variables a listener adds appear briefly on the `tmux`
  command line, which other local users can read, so a listener must not pass
  secrets that way.
- tmux runs the command directly from an argument list, with no shell.

## In scope

- Text from the task, an agent file, a model name, a label or a flag reaching
  the delegate as extra arguments, or being run by a shell.
- Environment from the parent process, other than the variables listed above,
  reaching the delegate through pi-squire.
- A delegate starting delegates of its own, or acting on a reply that did not
  come from the delegation it belongs to.

## Out of scope

- What the delegate does with its task. It runs as the user, with the tools
  the agent file leaves it; limit it with `exclude-tools` and a permission
  extension.
- What `session:launch` listeners add. They are extensions you installed and
  already run with your rights.
- Anything the tmux server's own environment carries into new windows.
