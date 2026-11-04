# Hub per OS user — never adopt another user's hub

Reported 2026-11-03 (0.36.4, build 6a0c237): two macOS users, fast user switching. B's app shows A's
projects/tasks until A quits.

Scope (decided 2026-11-03): fix the mix-up only. Blocking deliberate access (local key / socket, folder
lock) is parked — see bottom.

## Root cause (verified in code)

1. Packaged hub always binds `127.0.0.1:51100` (`app/src/main/index.ts:2665`). Single-instance lock is
   per OS user; loopback is shared (`paths.ts:100` assumes one hub per channel per machine).
2. B's child is still booting when the supervisor polls `/health`; A's hub answers 200 → supervisor marks
   ready (`sidecar-server-supervisor.ts:199-225` checks status + buildId only) → B's renderer + agents
   use `:51100`. Child then dies EADDRINUSE; fixed port "wins outright" so every respawn retries 51100.
3. Bare `slay` in B's plain shell: `local-hub.ts:97` probes 51100; with no `SLAYZONE_ROOT` there is no
   expected root → accepts A's hub.

## Fix

### 1. Supervisor only accepts its own child (`sidecar-server-supervisor.ts`)
- `probeHealth` also returns `pid` (`/health` reports it to loopback callers, `health.ts:104`).
- Ready only when `pid === child.pid`. Foreign answer = keep polling (not ready).
- No new env var / protocol: a foreign hub can't share our child's pid.

### 2. Port fallback, sticky
- Fixed port stays first choice. Child exits before ready AND `/health` on the fixed port answers with a
  foreign pid → next spawn picks a free port in `HUB_DYNAMIC_PORT_RANGE` (51110–51199), sticky across
  respawns; no backoff attempt burned. Log `[supervisor] :51100 held by another hub (pid N) — using :P`.
- Renderer (`app:get-server-url` → `handle.getPort()`), agents (`__serverPort` → `mcp-env.ts:251`), local
  computer (`mintLocalComputerJoinToken`) already follow the live port — verify, no change expected.

### 3. `slay` finds its own hub (`cli/src/local-hub.ts`)
- `/health` (loopback-only fields) also reports `user` (OS user the hub runs as) and `dev`.
  The CLI must not derive the app's on-disk layout (lint guard), so identity comes from the hub.
- `SLAYZONE_ROOT` set → match by root (unchanged). Plain shell → match by own OS user + channel.
- Fixed port not ours (or empty) → sweep `HUB_DYNAMIC_PORT_RANGE` (`findFirstHub`, settles on first
  match) for a supervised hub with our user + dev bit; none → "foreign" refusal / "not running".
- Hub too old to report `user` on the fixed port → accepted (previous behaviour).
- `db.ts` "--dev?" hint uses the same rule.

### 4. Tests (TDD — fail first)
- Supervisor unit: fake server on the test's fixed port answering hub-shaped `/health` with another pid →
  today ready (fails); after: not ready, falls back to range port, child's own `/health` → ready.
- Supervisor unit: own child on fixed port → ready, no fallback (no regression).
- CLI unit (`local-hub.test.ts`): no `SLAYZONE_ROOT`, hub on fixed port with another user's root →
  `foreign`; sweep finds own root.
- e2e: none (Playwright skips the fixed port). Manual: second macOS user on this Mac, or reporter on a
  beta — both apps run, each shows own data; B's `slay tasks list` shows B's tasks.

### 5. Ship
- Changelog: "Fixed: on a Mac shared by several users, a second user's SlayZone could show the first
  user's projects."

## Parked (follow-up, not this fix)
- Any local process of another OS user can still call A's hub (no auth with login off) and read
  `~/.slayzone` (0755, DB files 0644). Options drawn in artifact "Hub per OS user — before & after":
  per-user key (~1–2 days) or private socket (~1–2 weeks). Folder lock (0700) is cheap and could ship
  alone.

## Open questions
1. Ship as 0.36.5 hotfix?
