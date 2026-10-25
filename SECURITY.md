# Security Policy

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Write to the
repository owner via GitHub (fwmakc) or use
[private vulnerability reporting](https://github.com/fwmakc/dreamteam/security/advisories/new).
You will get a response within a few days.

## Scope and known design boundaries

Dream Team is a local-first tool: agents can run shell commands, write files
and ssh into configured servers. Please keep these trust boundaries in mind:

- **The access token** (`TOKEN` in `~/.dreamteam/.env`) is server-password
  level: whoever has it can make the team run commands on your machine. Serve
  binds to `127.0.0.1` by default; expose it only behind HTTPS or your own VPN.
- **Tool code is trusted code.** Custom tools from `~/.dreamteam/tools/` run
  with your user's rights — treat them like any npm dependency.
- **hosts.json / mails.json** contain server and mailbox credentials in plain
  text by design. Keep `.dreamteam/` out of git (the wizard reminds you) and
  treat `/home export` archives like a password (they contain provider keys).
- **Model-output gating.** Agent action blocks (`run`, `ssh`, `files`, …) go
  through per-tool `check()` policies; mutating actions require explicit
  `y/n` confirmation unless the card says otherwise.

## Supported versions

Only the latest published version receives security fixes.
