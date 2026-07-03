# Sidecar staleness, multi-instance hazard & observability

Found while validating the warm-agent pool (`plans/agent-sessions.md`). Warm-pool init in
`apps/server/src/composition.ts` + sidecar warm-init (commit `3d76e80d`) look correct but could
not be validated live: the running sidecar was stale (old in-memory bundle), so the new code
never executed.

## TL;DR

The sidecar's lifetime is bound to the Electron **main** process, but **nothing** ties it to the
on-disk `bin.cjs` build. Dev never watches/rebuilds the server, never hot-restarts the sidecar,
and there is **no build/commit signal** to tell which code a running sidecar is actually executing.
Multiple sidecars (supervised + stray standalone) coexist on the same DB and race on
`mcp_server_port`, so it's ambiguous which one the renderer/CLI/agents are talking to. Sidecar
diagnostics persistence already exists in source — but only in a build the stale sidecar isn't
running.

## Evidence (captured 2026-06-23, HEAD `3d76e80d`)

`bin.cjs` rebuilt today **18:46:04**. Live processes:

| PID | ppid | uptime | script path | launcher |
|-----|------|--------|-------------|----------|
| 31629 | 31421 | 00:02 | `out/server/dist/bin.cjs` (symlink) | dev supervisor (fresh respawn) |
| 61520→61529 | **1** | **~4 days** | `packages/apps/server/dist/bin.cjs` | `node .bin/electron …bin.cjs` (NOT supervised) — **orphaned** |
| 98274 | 98253 | ~21 min | `packages/apps/server/dist/bin.cjs` | standalone/e2e/manual |

Plus a **16-day-old** dev Electron main (crashpad etime `16-08:41:32`) and a packaged
`SlayZone.app` v0.34.0. So at least 3 sidecars + 2 app instances coexist.

The 4-day orphan proves the supervisor's death-detection has a gap (see RC3).

## Root causes

### RC1 — Dev never rebuilds the server, and never restarts the sidecar on a build change
- `app` `dev` script: `pnpm --filter @slayzone/server build && electron-vite dev`
  (`apps/app/package.json:9`). Server is built **once**.
- `apps/server/build.mjs` runs esbuild with **no watch**.
- `electron-vite dev` watches `main`/`preload`/`renderer` src and restarts main on a main-src
  change (that *would* respawn the sidecar). It does **not** watch the separate `@slayzone/server`
  package, so editing server code triggers neither a rebuild nor a main restart.
- Net: edit server code → must manually `pnpm --filter @slayzone/server build` → `bin.cjs`
  updated → but the running main+supervisor keep the old sidecar alive → new code never loads.
  Matches the evidence exactly (bin.cjs rebuilt, sidecar untouched).

### RC2 — The sidecar is spawned once and only relaunches on death; bin.cjs change is invisible
- Supervisor (`apps/app/src/main/sidecar-server-supervisor.ts`) spawns once
  (`index.ts:2042`), health-polls `/health` (250 ms), and respawns only on **process exit**.
- It never reads `bin.cjs` mtime/hash, so a rebuilt bundle is never noticed.
- `restart()` already exists (cycles the child on the sticky port) — but nothing calls it on a
  build change. Used today only for the e2e DB reset path.
- A long-lived main (16-day uptime here) therefore pins an arbitrarily old sidecar.

### RC3 — Stray / orphaned standalone sidecars survive and contend
- Death-detection (`apps/server/src/bin.ts:35-48`) only arms when `SLAYZONE_SUPERVISED=1`:
  stdin-pipe close + ppid-poll (`process.ppid === 1`).
- The 4-day orphan was launched via `node .bin/electron …bin.cjs` (e2e / manual / standalone),
  so `SLAYZONE_SUPERVISED` was unset → **no self-kill at all**. Its inner Electron's ppid is the
  `node` wrapper (still alive, itself orphaned at ppid 1), so even the ppid-poll backstop would
  never have fired.
- Every sidecar that boots blindly claims `settings.mcp_server_port`
  (`apps/server/src/server.ts:181-187`, comment claims "single writer" — false with ≥2 instances
  on one DB). Last writer wins → CLI/agents/slay resolve to whichever sidecar booted last.
  Ambiguous which sidecar/DB is in play.

### RC4 — No build/commit identity anywhere; diagnostics persistence exists but unproven
- `/health` returns only `{ ok, port, dbPath, uptimeMs }` (`apps/server/src/health.ts`).
- `appGetVersion` → package.json version (or `'0.0.0-server'`). No git sha, no build id.
  Impossible to tell what code a running sidecar executes, or compare to on-disk.
- Sidecar diagnostics **are** persisted in current source: `openServerDiagnosticsDatabase()`
  (`apps/server/src/db.ts:133`) + `bindDiagnosticsDbs()` in `composition.ts:157`, writing the
  host-DB sibling `slayzone[.dev].diagnostics.sqlite`. The reason the user saw no sidecar events
  is **circular** — the stale running sidecar predates this code. Fixing RC1-RC3 surfaces them,
  but there's still no boot event recording the build identity.

## Fix design

### Goal A — Sidecar reliably runs the latest build after a restart
1. **Server watch + bundle hashing** (`apps/server/build.mjs`):
   - Add a `--watch` mode (esbuild `context().watch()`), invoked by a new `dev` script in
     `apps/server/package.json`.
   - On every (re)build, after the bundle is written, compute its sha256 and write
     `dist/sidecar-build.json` = `{ buildId: <sha256>, commit: <git sha or "uncommitted">,
     builtAt: <iso>, version }`. This file is the **on-disk truth**.
   - Run this watcher as part of `pnpm dev` (concurrently with `electron-vite dev`), so server
     edits rebuild `bin.cjs` automatically.
2. **Supervisor hot-restart on build change** (`sidecar-server-supervisor.ts`, dev only,
   **flag-gated — opt-in**, e.g. `SLAYZONE_SIDECAR_HOT_RESTART=1`):
   - Watch `dist/sidecar-build.json` (fs.watch + debounce). On change → `restart()`.
   - The new child boots from the fresh `bin.cjs`; sticky port preserved, renderer WS survives.
   - Off by default so a restart never surprises a live debug session; production never installs
     the watcher (gated on `is.dev`), behavior byte-identical.
3. **Build-id compiled into the bundle**:
   - `build.mjs` `define`s `__SLAYZONE_SERVER_BUILD_ID__` / `__SLAYZONE_SERVER_COMMIT__` /
     `__SLAYZONE_SERVER_BUILT_AT__`. Sidecar reads these at runtime (Goal B).
   - Use git sha + builtAt for the defines (avoids the hash-of-own-output chicken-egg); the
     sha256 in `sidecar-build.json` is the post-build content hash for the on-disk compare.

### Goal B — Visible signal of running build/commit, comparable to on-disk
1. `/health` 200 body gains `buildId`, `commit`, `builtAt` (from the compiled defines)
   (`apps/server/src/health.ts` + `server.ts` state).
2. Supervisor, after first `/health` ready, reads `dist/sidecar-build.json` and compares
   on-disk `buildId`/`commit` vs the running sidecar's reported values. Mismatch →
   - log a loud `[supervisor] STALE sidecar: running <x> vs disk <y>`,
   - expose `running` vs `disk` build in `getStatus()` (surfaced by `appGetSidecarStatus` →
     diagnostics UI / status line),
   - **dev**: auto-`restart()` (only if the hot-restart flag from A.3 is set);
     **prod**: warn-only — surface the signal, never force a restart (a prod mismatch is
     abnormal, and a surprise respawn in a user's face isn't worth it).
3. Sidecar emits a `sidecar.boot` diagnostic event on startup recording
   `{ buildId, commit, builtAt, pid, port, dbPath, supervised }` so the running build is visible
   in the diagnostics DB itself.

### Goal C — Sidecar diagnostics persisted & queryable
- Already implemented in source (RC4). Deliverables: (a) verify the sidecar's derived diag path
  equals the host's (`SLAYZONE_DB_PATH` → replace `.sqlite`→`.diagnostics.sqlite`), (b) the
  `sidecar.boot` event from Goal B is the canary that persistence works, (c) add the warm-pool
  reconcile decisions (enabled/disabled, adopt/spawn/skip) as diagnostic events if not already
  covered, so warm-pool staleness is diagnosable without guessing.

### Multi-instance hazard (RC3) — one deterministic instance registry
The registry subsumes both disambiguation **and** backend discovery. It is the single source of
truth for "which sidecars are live, on which DB, which build, who owns them". Never caps instances.

- **Registry**: each sidecar, on boot, upserts a row into a `sidecar_instances` table (or a
  `dataRoot/sidecar-instances.json` lock dir):
  `{ pid, ownerPid, port, dbPath, buildId, commit, supervised, startedAt }`.
  `ownerPid` = the process whose death means this sidecar is orphaned (the supervisor's Electron
  main PID when supervised; the launching shell/process PID when standalone).
- **Deterministic reaping (no heartbeats/timers)**: an entry is a *provable* orphan iff its
  `ownerPid` is **not alive** (`process.kill(ownerPid, 0)` throws `ESRCH`). On any sidecar boot,
  scan the registry and reap every entry with a dead owner. No time-window tuning, no guessing —
  a fact, not a heuristic. (Supervised sidecars already die with their parent; this covers the
  standalone/manual/e2e launchers that skip `SLAYZONE_SUPERVISED` death-detection — the class that
  produced the 4-day orphan.)
- **Discovery replaces `mcp_server_port`**: retire the shared `settings.mcp_server_port` key and
  its last-writer-wins race entirely. The CLI / agent hooks / external MCP resolve the backend
  from the registry (pick the `supervised` live entry for this DB). No writer-discipline patch
  needed — there is no shared key to clobber. (Migration note: keep writing `mcp_server_port` for
  one release as a compat shim if any external reader still expects it; audit first per RC3.)

## Implementation phases (TDD per project rule — failing test first)

1. **Phase 1 — Build identity** ✅ DONE (lowest risk, unblocks everything):
   `build.mjs` defines (`__SLAYZONE_SERVER_COMMIT__`/`_BUILT_AT__`) + `dist/sidecar-build.json`
   (adds `bundleSha256`); `src/build-info.ts` (`getServerBuildInfo`); `/health` exposes
   `commit`/`builtAt`/`buildId`; `sidecar.boot` diagnostic event (`source: 'server'`, added to the
   `DiagnosticSource` union). Tests: `build-info.test.ts` (pure, in run-all.sh) + a standalone boot
   smoke. **Validated live** against the running dev sidecar (`:61539`): `/health` advertises the
   build and the `sidecar.boot` row is queryable in the real dev diagnostics DB.
   - **Gap found + fixed**: `recordDiagnosticEvent` batches — only `error` level auto-flushes, so a
     sidecar that boots then exits inside the flush window loses its boot canary (exactly the
     crash-loop case). Fixed: `await flushWriteQueue()` right after the boot event, and drain the
     queue in `stop()` before closing the diagnostics DB.
2. **Phase 2 — Supervisor stale detection** ✅ DONE: `probeHealth` now returns the running
   `buildId`; supervisor reads the on-disk `sidecar-build.json` (sibling of the spawned bin) and
   compares. `getStatus()` gains `runningBuildId`/`diskBuildId`/`stale`; a loud
   `[supervisor] STALE sidecar: running X vs disk Y` logs on mismatch. Surfaced in the Diagnostics
   settings tab (Build row + ⚠ STALE badge). Auto-restart deferred to Phase 3 (flag-gated). Mirror
   types updated (`api.ts`, `app-deps.ts`, host fallback, sidecar self-report). Tests: 2 new
   supervisor cases (match ⇒ not stale; disk-ahead ⇒ stale + loud log), 9/9 green; all touched
   packages typecheck clean.
3. **Phase 3 — Dev hot-restart** (flag-gated) ✅ DONE: `build.mjs --watch` (own fs.watch + full
   rebuild → fresh `builtAt`/manifest each time, so bundle and manifest always match — avoids a
   restart loop); server `dev` script; a `dev.mjs` launcher (no concurrency dep) that builds once,
   starts the watcher (`--no-initial`), and runs `electron-vite dev`; `pnpm dev` → `node dev.mjs`.
   Supervisor watches `sidecar-build.json` (`watchFile`, tolerates late-appearing file) and
   `restart()`s onto the new build only when `hotRestartOnBuildChange` is set — wired to
   `is.dev && SLAYZONE_SIDECAR_HOT_RESTART==='1'`; `hotRestartInFlight` collapses the rebuild's
   write burst. Tests: 2 supervisor cases (flag ON ⇒ relaunch onto new build; flag OFF ⇒ stale
   surfaces, no relaunch), plus a standalone watch validation (touch src → fresh buildId, bin
   rewritten). All green; app typechecks clean; electron-vite resolves via `pnpm exec`.
4. **Phase 4 — Instance registry**: registry row on boot (with `ownerPid`) + deterministic
   owner-PID reaping + registry-based backend discovery (retire `mcp_server_port`). Test: boot 2
   sidecars on one DB → registry shows both; kill one's owner → next boot reaps it (dead ownerPid);
   CLI discovery resolves the supervised entry.

## Risks
- Sticky-port restart must not drop the renderer WS mid-flight — `restart()` already preserves the
  port; verify the brief gap is covered by the renderer's reconnect.
- Watching `sidecar-build.json` (not `bin.cjs`) avoids restarting mid-write (10 MB bundle).
- `mcp_server_port` discipline must not break the chromium fork / standalone CLI discovery — fork
  uses fixed ports, standalone-without-host still needs *a* discoverable port; gate on supervised.
- Don't reap a sidecar a legitimate launcher still owns — heartbeat window must exceed e2e pauses.

## Decisions (locked 2026-07-02)
1. **Dev hot-restart = flag-gated** (`SLAYZONE_SIDECAR_HOT_RESTART=1`), opt-in. Off by default so
   it never surprises a live debug session.
2. **Prod build mismatch = warn-only**. Auto-`restart()` is dev-only (and only under the flag
   above). A prod mismatch is abnormal; no forced respawn in a user's face.
3. **Deterministic orphan reaping via owner-PID liveness** — no heartbeats/timers. Reap iff the
   recorded `ownerPid` is dead (`kill(pid,0)` → `ESRCH`).
4. **Retire `mcp_server_port`** — the instance registry (decision 3) is the single backend-discovery
   source; CLI/agents/MCP resolve the supervised live entry. Eliminates the last-writer race
   instead of patching it. Compat shim for one release only if an external reader still needs it
   (audit first).
5. **Build id = both** git sha (human/commit link) + sha256-of-bundle (catches uncommitted/dirty;
   drives the running-vs-disk compare).
6. **Scope = all 4 phases.**

Net structural change from the original draft: decisions 3+4 collapse into **one** deterministic
instance registry that owns both orphan-reaping and backend discovery.
