---
name: slay-processes
description: "List and manage running processes via the slay CLI"
trigger: auto
---

Processes are background tasks managed by the SlayZone app — distinct from PTY terminal sessions (see slay-pty). These include automation computers, background jobs, and other managed child processes.

All process commands require the SlayZone app to be running, as data comes from the app's HTTP API.

## Commands

- `slay processes list [--json]` — list all managed processes.
  - Shows ID, status, PID, label, and command (`--json` adds the rest)
  - `orphaned` = part of a run is still alive but not attached to the app (e.g. it outlived an app restart). `stop`, `start` or `restart` take it down.

- `slay processes logs <id> [-n <lines>]` — print the last N lines of a process's output buffer.
  - Default: 50 lines

- `slay processes start <id> [--wait] [--settle <ms>] [--timeout <ms>] [--json]` — start a stopped process with its stored command/cwd. Prints the new PID.
  - Exits 1 if it is already running (use `restart`) or not found.
  - `--wait`: wait until it has stayed running for `--settle` ms (default 2000); exits 1 with its last log lines if it exits first. `--timeout` default 30000.

- `slay processes restart <id> [--wait] [--settle <ms>] [--timeout <ms>] [--json]` — stop the process and its whole tree, then start it again under the same id. Same flags/output as `start`.

- `slay processes stop <id>` — stop a process and its whole tree (escalates to SIGKILL). It stays listed; `start` brings it back. Exits 1 if part of the tree survived.

- `slay processes remove <id>` — stop a process (whole tree) AND remove it from the list. Use `stop` to keep it.

Never relaunch a managed process yourself (nohup, &, disown): it would be invisible to SlayZone. Use `restart`.

- `slay processes follow <id>` — stream process output in real time.
  - For live processes: uses SSE (Server-Sent Events) and streams indefinitely until the process exits or the connection drops
  - For already-finished processes: dumps the full output as plain text and returns immediately
