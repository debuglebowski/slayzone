# `was_spawned` is orphaned — session restore can never fire

## Symptom

App restart → tasks that had live agents come up on the Start gate ("closed").
Commit `1a463d709` (auto-restore closed tabs) is intact but starves: it reads a
flag nothing writes anymore.

## Root cause

`terminal_tabs.was_spawned` is written by `spawnedSetter` in
`pty-manager.ts:1754` (spawn → true) / `:1814` (exit → false, skipped when
`isShuttingDown`). `spawnedSetter` is installed by `setPtySpawnedTabRecorder`,
called in exactly one place: `packages/apps/app/src/main/index.ts:1964` — the
**Electron main process**.

PTYs no longer live there. They are spawned by the **runner**
(`packages/apps/runner/src/handlers/pty.ts`, `node-pty.spawn`) and managed by
the **hub**'s pty-manager (`packages/apps/hub/src/composition.ts`). Neither
wires the recorder, so `spawnedSetter` is `null` in the process that owns the
sessions and every call is a no-op.

Same orphaning already documented for the idle-close config getter in
`composition.ts` ("It was only ever wired in the Electron host, so when pty
moved to the sidecar the entire feature went silently dead"). The three
tab-flag recorders are the same class, still unfixed.

### Measured evidence (dev DB, 2026-08-06)

- Live agents right now: 14 `claude` processes, all children of PID 7872 =
  `packages/apps/runner/dist/bin.cjs`.
- `terminal_tabs.was_spawned = 0` for every one of their tasks.
- Last quit (`00:42:47`) `app.quit_subprocess_shutdown` payload:
  `shutdownAllPtys {total: 0, exited: 0, killed: 0}` — main owns zero sessions,
  so `beginTerminalShutdown()` flips a gate on an empty manager.
- Only 9 rows repo-wide have `was_spawned = 1`; all are stale leftovers from
  the REST `pty/start-main` path (`_start-main.ts:67`), which writes the DB
  directly in the hub. Nothing clears them either.
- Boot at `00:43:05`: exactly two tasks auto-spawned with no preceding
  `renderer.timeline.tab_changed` — `fa40d92a` and `8deb1bc2`, i.e. the two
  stale `was_spawned=1` rows. Every other PTY that morning was created 1–2 s
  after a `tab_changed`, i.e. only once clicked.

### Secondary (not a bug, but reads as one)

`terminal_auto_close_idle = 1` @ 10 min, `terminal_auto_start = 0`. Agents idle
>10 min are hibernated and deliberately come back on the "Reopen … (resumes)"
screen. 15 main tabs carry `hibernated = 1`.

## Plan

1. **Wire the recorders where the sessions are.** In
   `packages/apps/hub/src/composition.ts`, next to the existing
   `setIdleCloseConfigGetter` block, install all three against the hub's `db`
   via the electron-free `@slayzone/task-terminals/server` entry:
   - `setPtySpawnedTabRecorder((tabId, v) => markTabSpawned(db, tabId, v))`
   - `setChatSpawnedTabRecorder(same)`
   - `setPtyHibernatedTabRecorder((tabId, v) => markTabHibernated(db, tabId, v))`

2. **Set the shutdown gate in the hub.** `beginTerminalShutdown()` at the top of
   `ServerHandle.stop()` (`hub/src/server.ts:481`), before anything that can
   trigger pty exits — the runner-gateway close and the runner's
   `sessions_disposed` cascade both fire exit handlers. Covers every quit path,
   since `bin.ts` SIGTERM/SIGINT/parent-pipe/ppid-reparent all funnel to
   `handle.stop()`.

3. **Keep the Electron-main wiring.** It is inert when the sidecar owns the
   runtime but still correct under `NO_SIDECAR=1`. No functionality dropped.

4. **Tests (TDD — write failing first).**
   - Hub composition contract test: spawn → `was_spawned=1`; natural exit → `0`;
     exit after `beginTerminalShutdown()` → preserved `1`.
   - Extend `task-terminals.test.ts` `listAutoRestoreTasks` coverage with the
     round-trip (spawn → quit → boot list contains the task).

5. **One-off cleanup.** Clear the 9 stale `was_spawned=1` rows so the first boot
   after the fix does not resurrect long-dead tasks as background tabs.

## Decisions

Governing rule from the user: **boot state must equal shutdown state.** Alive at
quit → alive at boot. Dead at quit (closed by hand, or idle-killed) → cold Start
gate.

1. **`was_spawned` only.** `hibernated` stays orphaned — it only drives the 💤
   badge. An idle kill is a normal exit, so it already clears `was_spawned` and
   the restore query skips the task. Cold start is the wanted behavior.
   → Step 1 wires the two spawned recorders; drop `setPtyHibernatedTabRecorder`.
2. **Clear the 9 stale rows.** They were not running at shutdown, so under the
   rule they must not come back running.
3. **Idle-close unchanged (10 min).** It is runtime behavior; its outcome
   (agent dead at quit) is faithfully reproduced by a Start gate.

## Implemented

- `terminal/src/server/index.ts` — export the recorder seam + `beginTerminalShutdown`
  from the SERVER barrel (they were electron-only, which is what stranded them),
  plus `getSpawnedTabRecorder` on both managers so the wiring is assertable.
- `hub/src/tab-flag-recorders.ts` — `wireTabFlagRecorders(db)`, called from
  `composition.ts` next to the idle-close getter.
- `hub/src/server.ts` — `beginTerminalShutdown()` as the first statement of
  `stop()`, before the runner-gateway teardown fires the exit cascade.
- Migration **155** — one-time `UPDATE terminal_tabs SET was_spawned = 0`.
- `hub/src/tab-flag-recorders.test.ts` (5 tests, added to `run-all.sh`): unwired
  by default → wired on both managers → real DB round-trip → composition calls
  it → `stop()` gates before teardown.
