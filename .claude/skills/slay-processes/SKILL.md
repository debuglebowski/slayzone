---
name: slay-processes
description: "List and manage running processes via the slay CLI"
trigger: auto
---

Processes are background tasks managed by the SlayZone app — distinct from PTY terminal sessions (see slay-pty). These include automation runners, background jobs, and other managed child processes.

All process commands require the SlayZone app to be running, as data comes from the app's HTTP API.

## Commands

- `slay processes list [--json]` — list all managed processes.
  - Shows ID, status, label, command, PID, and start time

- `slay processes logs <id> [-n <lines>]` — print the last N lines of a process's output buffer.
  - Default: 50 lines

- `slay processes kill <id>` — kill a running process.

- `slay processes follow <id>` — stream process output in real time.
  - For live processes: uses SSE (Server-Sent Events) and streams indefinitely until the process exits or the connection drops
  - For already-finished processes: dumps the full output as plain text and returns immediately
