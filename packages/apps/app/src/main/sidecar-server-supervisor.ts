import { spawn, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import { readFileSync, watchFile, unwatchFile } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Supervises the @slayzone/hub side-car subprocess.
 *
 * Slice 2.5 dark-launch: the side-car is spawned + supervised but nothing
 * depends on it. The renderer keeps using the in-process tRPC server. A
 * permanent failure here is log-only — no user impact.
 *
 * The side-car is spawned as the same Electron binary run with
 * ELECTRON_RUN_AS_NODE=1 — a separate OS process that shares Electron's
 * better-sqlite3 native ABI. It is NOT imported as a module (keeps it out of
 * the main bundle); only spawned by file path.
 */

/** Production timing defaults. Overridable via `SidecarServerOpts.timing`. */
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000] as const
const HEALTHY_RESET_MS = 60_000
const HEALTH_POLL_INTERVAL_MS = 250
const HEALTH_BOOT_TIMEOUT_MS = 10_000
const STOP_SIGTERM_GRACE_MS = 3_000
const BUILD_WATCH_INTERVAL_MS = 500

/**
 * Timing overrides. Every field is optional and falls back to the production
 * constant above — omitting `timing` entirely keeps production behaviour
 * byte-identical. Exists purely so crash-recovery tests can shrink the backoff
 * schedule + the 60s healthy-reset window to run fast and deterministically.
 */
export type SidecarTiming = {
  /** Backoff schedule (ms per retry). Length = max restart attempts. */
  backoffMs?: readonly number[]
  /** Continuous-healthy duration that resets the backoff attempt counter. */
  healthyResetMs?: number
  /** Interval between `/health` probes while waiting for a child to boot. */
  healthPollIntervalMs?: number
  /** Time a freshly-spawned child has to answer `/health` before it is killed. */
  healthBootTimeoutMs?: number
  /** Grace period after SIGTERM before `stop()` escalates to SIGKILL. */
  stopSigtermGraceMs?: number
  /** Poll interval for the on-disk build manifest watcher (hot-restart). */
  buildWatchIntervalMs?: number
}

export type SidecarServerOpts = {
  /** process.execPath — the Electron binary. */
  execPath: string
  /** Absolute path to the side-car's dist/bin.js. */
  scriptPath: string
  /** Base env for the child (ELECTRON_RUN_AS_NODE + SLAYZONE_* are merged in). */
  env: NodeJS.ProcessEnv
  /** Host the side-car binds to. */
  host: string
  /** Receives the side-car's stdout/stderr lines + supervisor notices. */
  logger: (line: string) => void
  onReady: (info: { pid: number; port: number }) => void
  onPermanentFailure: (info: { attempts: number; lastError: unknown }) => void
  /** Optional timing overrides (tests only — production omits this). */
  timing?: SidecarTiming
  /**
   * Dev hot-restart: watch `dist/sidecar-build.json` and relaunch the side-car
   * when the on-disk build changes (picks up a fresh `bin.cjs` without a full
   * app restart). Opt-in — the caller gates it on `is.dev` +
   * `SLAYZONE_SIDECAR_HOT_RESTART=1`. Off ⇒ staleness is only surfaced, never
   * auto-corrected. Never enabled in production.
   */
  hotRestartOnBuildChange?: boolean
  /**
   * Bind exactly this port instead of probing a free one (plans/sidecar-staleness.md,
   * Phase 4). One supervised sidecar per environment ever runs at a time
   * (single-instance-locked app, or a single e2e worker), so a fixed port turns
   * backend discovery from a DB-write race into a known constant, and a stray
   * second instance into a loud EADDRINUSE at bind time instead of silent
   * ambiguity. Overrides the sticky-port/probe logic entirely — never cleared.
   */
  fixedPort?: number
}

export type SidecarHealth = 'starting' | 'ready' | 'restarting' | 'failed'

export type SidecarStatus = {
  health: SidecarHealth
  /** Last known port. Null before the first spawn. */
  port: number | null
  /** Current child PID, or null when no child is running. */
  pid: number | null
  /** Restart attempts since the last 60s healthy streak. */
  restarts: number
  /**
   * Lifetime respawns (spawns after the first). Unlike `restarts`, never
   * reset — a healthy-crash immediate respawn counts here even though it
   * doesn't consume a backoff attempt. Crash-recovery tests assert on this.
   */
  totalRespawns: number
  /** Absolute DB path the side-car was told to open. */
  dbPath: string | null
  /** Milliseconds the side-car has been continuously healthy, or null. */
  uptimeMs: number | null
  /** Build id the live process reports via /health (`commit@builtAt`). Null
   *  before the first ready or if the sidecar predates build-identity. */
  runningBuildId: string | null
  /** Build id currently on disk (`dist/sidecar-build.json`, sibling of the
   *  spawned bin). Null if the manifest is missing/unreadable. */
  diskBuildId: string | null
  /** running !== disk (both known) — the process is executing stale code
   *  relative to the latest build on disk. */
  stale: boolean
}

export type SidecarServerHandle = {
  getPort: () => number | null
  getHealth: () => SidecarHealth
  /** Read-only status snapshot for diagnostics UI. */
  getStatus: () => SidecarStatus
  /** Resolves on first ready; rejects on permanent failure. */
  waitForReady: () => Promise<void>
  /** Cycle the child (same sticky port) — e.g. e2e DB reset needs the side-car
   *  to re-open the freshly-migrated DB + re-warm its caches. Resolves once the
   *  old child has exited; the caller then `waitForReady()`s the new one. */
  restart: () => Promise<void>
  stop: () => Promise<void>
}

/** Probes a free OS-assigned port by binding then immediately closing. */
function probeFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, host, () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

/**
 * Single GET /health probe. Resolves `{ ok }` (HTTP 200) plus the running
 * build's `buildId` from the body when present — so the supervisor can compare
 * the live process against the on-disk build and flag a stale sidecar.
 */
function probeHealth(
  host: string,
  port: number
): Promise<{ ok: boolean; buildId: string | null }> {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/health', timeout: 1_000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        resolve({ ok: false, buildId: null })
        return
      }
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        let buildId: string | null = null
        try {
          const parsed = JSON.parse(body) as { buildId?: unknown }
          if (typeof parsed.buildId === 'string') buildId = parsed.buildId
        } catch {
          /* body may be absent/legacy — treat as unknown build */
        }
        resolve({ ok: true, buildId })
      })
    })
    req.on('error', () => resolve({ ok: false, buildId: null }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false, buildId: null })
    })
  })
}

export function startSidecarServer(opts: SidecarServerOpts): SidecarServerHandle {
  // Resolve timing — each field falls back to its production default.
  const backoffMs = opts.timing?.backoffMs ?? BACKOFF_MS
  const healthyResetMs = opts.timing?.healthyResetMs ?? HEALTHY_RESET_MS
  const healthPollIntervalMs = opts.timing?.healthPollIntervalMs ?? HEALTH_POLL_INTERVAL_MS
  const healthBootTimeoutMs = opts.timing?.healthBootTimeoutMs ?? HEALTH_BOOT_TIMEOUT_MS
  const stopSigtermGraceMs = opts.timing?.stopSigtermGraceMs ?? STOP_SIGTERM_GRACE_MS
  const buildWatchIntervalMs = opts.timing?.buildWatchIntervalMs ?? BUILD_WATCH_INTERVAL_MS

  let child: ChildProcess | null = null
  let port: number | null = null
  // Sticky port: probed once on first spawn, reused across respawns so the
  // renderer's fixed WS URL survives a crash + immediate respawn. Only cleared
  // (→ re-probe a fresh port) when a spawn exits WITHOUT ever becoming healthy
  // (e.g. the sticky port became unbindable) — a never-ready child means the
  // renderer never had a working connection to that port anyway.
  let stickyPort: number | null = null
  let health: SidecarHealth = 'starting'
  let readySince: number | null = null
  // Build id the live child last reported via /health. Null until first ready,
  // reset on every exit — an old value must never survive into a new child.
  let runningBuildId: string | null = null
  let attempt = 0
  let spawnCount = 0
  let stopped = false
  let backoffTimer: NodeJS.Timeout | null = null
  let healthyTimer: NodeJS.Timeout | null = null
  let pollTimer: NodeJS.Timeout | null = null
  let bootDeadline = 0

  // On-disk build manifest (sibling of the spawned bin). Read fresh on demand so
  // a rebuild after boot is reflected immediately (drives stale-detection).
  const manifestPath = join(dirname(opts.scriptPath), 'sidecar-build.json')
  const readDiskBuildId = (): string | null => {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { buildId?: unknown }
      return typeof parsed.buildId === 'string' ? parsed.buildId : null
    } catch {
      return null
    }
  }

  const readyWaiters: Array<{ resolve: () => void; reject: (e: unknown) => void }> = []

  const resolveWaiters = (): void => {
    while (readyWaiters.length) readyWaiters.shift()!.resolve()
  }
  const rejectWaiters = (err: unknown): void => {
    while (readyWaiters.length) readyWaiters.shift()!.reject(err)
  }

  const clearTimers = (): void => {
    if (backoffTimer) clearTimeout(backoffTimer)
    if (healthyTimer) clearTimeout(healthyTimer)
    if (pollTimer) clearTimeout(pollTimer)
    backoffTimer = healthyTimer = pollTimer = null
  }

  const scheduleRestart = (lastError: unknown): void => {
    if (stopped) return
    if (attempt >= backoffMs.length) {
      health = 'failed'
      opts.logger(`[supervisor] giving up after ${attempt} attempts`)
      opts.onPermanentFailure({ attempts: attempt, lastError })
      rejectWaiters(new Error('sidecar permanent failure'))
      return
    }
    const delay = backoffMs[attempt]
    attempt += 1
    health = 'restarting'
    opts.logger(`[supervisor] restart in ${delay}ms (attempt ${attempt}/${backoffMs.length})`)
    backoffTimer = setTimeout(spawnChild, delay)
  }

  const pollHealth = (): void => {
    if (stopped || !child || port === null) return
    void probeHealth(opts.host, port).then((result) => {
      if (stopped) return
      if (result.ok) {
        health = 'ready'
        readySince = Date.now()
        runningBuildId = result.buildId
        // Stale detection: the live process's build vs the build on disk. A
        // mismatch means the sidecar is running old code (e.g. bin.cjs was
        // rebuilt but this long-lived process never relaunched) — the exact
        // dogfooding failure this guards against. Loud log; auto-restart is
        // Phase 3 (flag-gated). Unknown build (legacy sidecar, no manifest) is
        // not treated as stale — only a definite mismatch.
        const diskBuildId = readDiskBuildId()
        if (runningBuildId && diskBuildId && runningBuildId !== diskBuildId) {
          opts.logger(
            `[supervisor] STALE sidecar: running ${runningBuildId} vs disk ${diskBuildId} — relaunch to load the fresh build`
          )
        }
        opts.logger(`[supervisor] sidecar ready pid=${child?.pid} port=${port}`)
        opts.onReady({ pid: child?.pid ?? -1, port: port! })
        resolveWaiters()
        // 60s healthy streak resets the backoff counter.
        healthyTimer = setTimeout(() => {
          attempt = 0
        }, healthyResetMs)
        return
      }
      if (Date.now() > bootDeadline) {
        opts.logger('[supervisor] health timeout — killing child')
        child?.kill('SIGKILL')
        return
      }
      pollTimer = setTimeout(pollHealth, healthPollIntervalMs)
    })
  }

  function spawnChild(): void {
    if (stopped) return
    // Fixed port wins outright — no probing, no sticky-port bookkeeping needed
    // (it's already permanently "stuck" to the one configured value). Otherwise
    // reuse the sticky port if we have one; else probe a fresh free port.
    const portSource =
      opts.fixedPort !== undefined
        ? Promise.resolve(opts.fixedPort)
        : stickyPort !== null
          ? Promise.resolve(stickyPort)
          : probeFreePort(opts.host)
    void portSource
      .then((freePort) => {
        if (stopped) return
        stickyPort = freePort
        port = freePort
        bootDeadline = Date.now() + healthBootTimeoutMs

        // stdin is 'pipe' so the child detects parent death via stdin close.
        const proc = spawn(opts.execPath, [opts.scriptPath], {
          env: {
            ...opts.env,
            ELECTRON_RUN_AS_NODE: '1',
            SLAYZONE_SUPERVISED: '1',
            SLAYZONE_HOST: opts.host,
            SLAYZONE_PORT: String(freePort)
          },
          stdio: ['pipe', 'pipe', 'pipe']
        })
        child = proc
        spawnCount += 1
        opts.logger(`[supervisor] spawned pid=${proc.pid} port=${freePort}`)

        const pipe = (chunk: Buffer): void => {
          for (const line of chunk.toString().split('\n')) {
            if (line.trim()) {
              try {
                opts.logger(`[sidecar] ${line}`)
              } catch {
                /* a throwing logger must never stall the pipe */
              }
            }
          }
        }
        proc.stdout?.on('data', pipe)
        proc.stderr?.on('data', pipe)

        proc.on('error', (err) => {
          opts.logger(`[supervisor] spawn error: ${String(err)}`)
          if (child === proc) {
            child = null
            scheduleRestart(err)
          }
        })
        proc.on('exit', (code, signal) => {
          if (child !== proc) return
          child = null
          readySince = null
          runningBuildId = null
          if (stopped) return
          const wasReady = health === 'ready'
          opts.logger(`[supervisor] sidecar exited code=${code} signal=${signal}`)
          if (wasReady) {
            // Crash after a healthy run — restart immediately, no backoff, on
            // the SAME sticky port so the renderer's WS URL stays valid.
            health = 'restarting'
            spawnChild()
          } else {
            // Never became healthy — the sticky port may be unbindable; drop it
            // so the next attempt probes a fresh free port.
            stickyPort = null
            scheduleRestart(new Error(`exit code=${code} signal=${signal}`))
          }
        })

        pollTimer = setTimeout(pollHealth, healthPollIntervalMs)
      })
      .catch((err) => {
        opts.logger(`[supervisor] port probe failed: ${String(err)}`)
        scheduleRestart(err)
      })
  }

  // Cycle the child on the sticky port. The `exit` handler treats this like a
  // healthy crash → immediate respawn. Resolves once the old child is gone.
  // A deliberate restart (user button / hot-restart) grants a FRESH backoff
  // budget: it must be able to recover from `failed` (attempts exhausted).
  const doRestart = async (): Promise<void> => {
    if (stopped) return
    attempt = 0
    const proc = child
    if (!proc) {
      if (backoffTimer) {
        // Mid-backoff — cancel the pending spawn so we don't double-spawn.
        clearTimeout(backoffTimer)
        backoffTimer = null
      } else if (health !== 'failed') {
        // A spawn is already in flight (port-probe window before the child is
        // assigned) — let it land; there is nothing to cycle yet.
        return
      }
      health = 'restarting'
      spawnChild()
      return
    }
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }, stopSigtermGraceMs)
      proc.once('exit', () => {
        clearTimeout(killTimer)
        resolve()
      })
      proc.kill('SIGTERM')
    })
  }

  spawnChild()

  // Dev hot-restart: poll the on-disk build manifest; when it names a build
  // different from the one the live child reported, relaunch onto it. Polls
  // (watchFile) rather than fs.watch so a manifest that doesn't exist yet (built
  // concurrently with the app) is tolerated — the watcher just fires once it
  // appears. `hotRestartInFlight` collapses the burst of writes a rebuild emits
  // into a single restart.
  let hotRestartInFlight = false
  if (opts.hotRestartOnBuildChange) {
    watchFile(manifestPath, { interval: buildWatchIntervalMs }, () => {
      if (stopped || hotRestartInFlight) return
      const diskBuildId = readDiskBuildId()
      // Only act on a definite mismatch against a ready child — never on a
      // missing manifest or before the child has reported its build.
      if (health === 'ready' && runningBuildId && diskBuildId && diskBuildId !== runningBuildId) {
        opts.logger(
          `[supervisor] build changed on disk (${diskBuildId}) — hot-restarting sidecar`
        )
        hotRestartInFlight = true
        void doRestart().finally(() => {
          hotRestartInFlight = false
        })
      }
    })
  }

  return {
    getPort: () => (health === 'ready' ? port : null),
    getHealth: () => health,
    getStatus: () => {
      const diskBuildId = readDiskBuildId()
      return {
        health,
        port,
        pid: child?.pid ?? null,
        restarts: attempt,
        totalRespawns: Math.max(0, spawnCount - 1),
        dbPath: opts.env.SLAYZONE_DB_PATH ?? null,
        uptimeMs: readySince === null ? null : Date.now() - readySince,
        runningBuildId,
        diskBuildId,
        stale: !!(runningBuildId && diskBuildId && runningBuildId !== diskBuildId)
      }
    },
    waitForReady: () =>
      new Promise<void>((resolve, reject) => {
        if (health === 'ready') return resolve()
        if (health === 'failed') return reject(new Error('sidecar permanent failure'))
        readyWaiters.push({ resolve, reject })
      }),
    restart: doRestart,
    stop: async () => {
      if (stopped) return
      if (opts.hotRestartOnBuildChange) unwatchFile(manifestPath)
      stopped = true
      clearTimers()
      const proc = child
      child = null
      if (!proc) return
      await new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => {
          proc.kill('SIGKILL')
        }, stopSigtermGraceMs)
        proc.once('exit', () => {
          clearTimeout(killTimer)
          resolve()
        })
        proc.kill('SIGTERM')
      })
    }
  }
}
