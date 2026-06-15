import { spawn, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'

/**
 * Supervises the @slayzone/server side-car subprocess.
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

/** Single GET /health probe — resolves true on HTTP 200. */
function probeHealth(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/health', timeout: 1_000 }, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
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
  let attempt = 0
  let spawnCount = 0
  let stopped = false
  let backoffTimer: NodeJS.Timeout | null = null
  let healthyTimer: NodeJS.Timeout | null = null
  let pollTimer: NodeJS.Timeout | null = null
  let bootDeadline = 0

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
    void probeHealth(opts.host, port).then((ok) => {
      if (stopped) return
      if (ok) {
        health = 'ready'
        readySince = Date.now()
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
    // Reuse the sticky port if we have one; otherwise probe a fresh free port.
    const portSource =
      stickyPort !== null ? Promise.resolve(stickyPort) : probeFreePort(opts.host)
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

  spawnChild()

  return {
    getPort: () => (health === 'ready' ? port : null),
    getHealth: () => health,
    getStatus: () => ({
      health,
      port,
      pid: child?.pid ?? null,
      restarts: attempt,
      totalRespawns: Math.max(0, spawnCount - 1),
      dbPath: opts.env.SLAYZONE_DB_PATH ?? null,
      uptimeMs: readySince === null ? null : Date.now() - readySince
    }),
    waitForReady: () =>
      new Promise<void>((resolve, reject) => {
        if (health === 'ready') return resolve()
        if (health === 'failed') return reject(new Error('sidecar permanent failure'))
        readyWaiters.push({ resolve, reject })
      }),
    restart: async () => {
      if (stopped) return
      const proc = child
      if (!proc) {
        // No live child (e.g. mid-backoff) — kick a fresh spawn on the sticky port.
        spawnChild()
        return
      }
      // Kill the child; the `exit` handler respawns immediately on the sticky
      // port (treated as a healthy crash). Resolve once the old child is gone.
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
    },
    stop: async () => {
      if (stopped) return
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
