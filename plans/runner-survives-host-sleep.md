# Runner sessions survive host sleep

## The bug

Close the lid → every agent terminal shows **"Process exited with code 1"**. The agents did not
crash; the hub threw away its handles to them.

Measured on 2026-08-04 (`pmset -g log` + `slayzone.dev.diagnostics.sqlite`):

| Time | Event |
|---|---|
| 15:56:37 | `Clamshell Sleep` (lid closed) |
| 15:57:30 | DarkWake → `runner.sessions_disposed` ×2 + 4× `pty.exit {exitCode:1}` |
| 16:15:39 | `Clamshell Sleep` |
| 16:34:41 | DarkWake → same pair, same second |

No `local_runner.exit` in either window ⇒ **the runner process never died**; only the hub's view of
it did.

### Chain

1. Host sleeps. Both processes freeze; `setTimeout` does not fire.
2. On wake the heartbeat watchdog (`hub-gateway.ts:186` `armHeartbeatWatchdog`) fires with a
   wall-clock delta far past `DEFAULT_HEARTBEAT_TIMEOUT_MS` (45 s, `:146`).
3. `idleMs >= heartbeatTimeoutMs` → emits `runner-lost` (`:197`), then `teardown()` (`:199`), which
   itself emits `runner-disconnected` (`:244`). **One watchdog fire produces both events** — the
   socket never actually closed.
4. Both events are wired straight to `disposeRunner()` — twice over, once per routing backend
   (`exec-proxies.ts:329-330` pty, `:624-625` chat). That is why the logs show 4 sessions and 3
   sessions disposed in the same second.
5. `disposeRunner` → `finalize(entry, null, reason)` (`:291`) → the handle seam coerces
   `exitCode: event.exitCode ?? 1` (`:371`) → **a fabricated crash in every task**.
6. Runner-side, ptys are killed only by `disposeAll()`, wired solely to runner shutdown
   (`runner/src/main.ts:106`). The agent processes keep running, detached, invisible.

## Principles

- **Silence is not evidence.** A quiet socket cannot distinguish crashed / partitioned / asleep.
- **Killing belongs to the runner; bookkeeping belongs to the hub.** Only the runner can end a
  process. The hub may stop *tracking* one — that is a statement about the hub, not a claim about
  the world, and is the only thing a timer may decide.
- **The hub must still reap** (its own registry), or a runner that never returns leaks sessions
  forever and tasks hang in permanent "reconnecting".

## Status

Stages 1 and 2 are implemented, minus the runner-side lease (see Deferred). Verified:
`runner-transport` 106/106, `runner` 105/105, repo typecheck clean.

## Stage 1 — stop the bleeding (small, self-contained) — DONE

**Suspend-aware watchdog.** `setTimeout` cannot fire early, so a fire whose wall-clock lateness far
exceeds its own delay means the process was frozen (host sleep, VM suspend, blocked loop). In that
case the heartbeat window was never actually observed → re-arm a full window instead of reaping.

- `armHeartbeatWatchdog` records `armedAt` + `delayMs`; on fire, `lateness = (now - armedAt) - delayMs`.
- `lateness > SUSPEND_LATENESS_MS` → log, re-arm full window, return. Never declares loss.
- Bias is deliberate: a false re-arm costs one extra window of delay; a false reap costs every agent
  on the machine.
- Lateness — not `performance.now()` — because libuv's monotonic clock ticks through sleep on some
  platforms and not others. Lateness needs no clock-semantics assumption.

Fixes the lid-close bug outright: with no watchdog fire, nothing tears down and nothing is disposed.

**Runner-side wake nudge — DROPPED.** The dialer heartbeat is a `setInterval`, which on wake is
already overdue and fires immediately; a suspend detector there would be a no-op dressed up as
symmetry. Worst-case recovery is one interval (15 s), well inside the fresh 45 s window the guard
grants.

**Tests** — `hub-gateway.test.ts`: fake timers + `vi.setSystemTime()` to advance wall clock
independently of the timer clock, simulating a frozen process.

## Stage 2 — the real fix — DONE (except the lease)

**Detach, don't finalize.** `runner-lost` / `runner-disconnected` stop calling `disposeRunner`.
Entries go to `detached` and stay in the registry; the UI renders "reconnecting…", not an exit.

**Reattach on reconnect.** New `pty.list` → `[{sessionId, pid, seq}]` (mirrors the existing
`warmList`). On reconnect the hub re-attaches each detached entry and backfills from `lastSeq` via
the existing `pty.getBufferSince` + `RingBuffer`. The `warmAdopt` handover (`handlers/pty.ts:212`)
is the exact precedent — process, pid, buffer and seq counter all survive a rekey.

**Runner epoch.** Boot id in the join descriptor. Same epoch ⇒ same process, sessions survive; new
epoch ⇒ fresh process, everything it used to hold is provably gone. Removes the last guess.

**Reap only on a decisive signal:**

| Signal | Meaning |
|---|---|
| `local_runner.exit` | Process gone (supervisor observed it) |
| Reconnect, new epoch | Fresh process, old sessions gone |
| Reconnect, same epoch, absent from `pty.list` | That one really did exit |
| Lease expired, no reconnect | Hub stops tracking (see below) |

### Two things the implementation added that this plan did not anticipate

**One controller per (gateway, kind), not per backend.** `createRoutingChatBackend` builds a FRESH
`createRoutingProcessBackend` for every agent spawn, so a per-backend controller would add a gateway
listener set per agent (unbounded over a session) and fire one `proc.list` per agent on reconnect.
Backends now JOIN a controller keyed by `(gateway, kind)` and contribute a participant; finished
participants are pruned.

**`listRunners` added to the `RoutingGateway` slice.** The epoch baseline cannot come only from
`runner-connected` events: the chat backend is built at SPAWN time, long after the runner connected,
so its controller would have no baseline and would read the first disconnect as a restart — the
original bug, surviving for chat sessions. The controller now seeds its baseline from the roster at
construction. This was caught by a test, not by review.

### Deferred: runner-side lease

A runner that cannot reach its hub for `T_lease` should kill its own ptys. NOT implemented, for two
reasons: the value is an open question, and a lease that mis-measures a frozen process reproduces
exactly the bug this plan fixes — it is the single most destructive action in the design, and its
freeze-guard has to be right. Meanwhile the leak it protects against is closed for every case where
the runner reconnects at all: the reattach sweep kills sessions the runner still holds that the hub
no longer tracks. What remains uncovered is only "hub gone forever, remote runner still up".
Recommendation when it lands: freeze-guarded, ~1 hour, runner-side.

## Stage 3 — hardening

- **Local ground truth**: `local_runner.exit` + `process.kill(pid, 0)` (already used at
  `pty-manager.ts:2538`) + pidfile boot id against PID reuse. No timer in the local decision.
- **Surface runner health**: flapping / crash-looping runners warn in the Settings runners table
  (restart button already exists). Silent when reattach succeeds — warning on every DarkWake would
  be worse than the bug.

## Open

- `T_lease` value for the deferred runner-side lease.
- `DETACH_GRACE_MS` is 10 min — right for a lunch-break lid close?
- Stage 3 (`local_runner.exit` as ground truth, runner-health warnings) not started.
- No "reconnecting…" affordance yet: a detached terminal simply goes quiet, which is right for a
  sleeping laptop but silent about a genuinely unreachable remote runner.
