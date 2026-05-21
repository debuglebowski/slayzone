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

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000] as const
const HEALTHY_RESET_MS = 60_000
const HEALTH_POLL_INTERVAL_MS = 250
const HEALTH_BOOT_TIMEOUT_MS = 10_000
const STOP_SIGTERM_GRACE_MS = 3_000

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
}

export type SidecarServerHandle = {
  getPort: () => number | null
  getHealth: () => 'starting' | 'ready' | 'restarting' | 'failed'
  /** Resolves on first ready; rejects on permanent failure. */
  waitForReady: () => Promise<void>
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
  let child: ChildProcess | null = null
  let port: number | null = null
  let health: 'starting' | 'ready' | 'restarting' | 'failed' = 'starting'
  let attempt = 0
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
    if (attempt >= BACKOFF_MS.length) {
      health = 'failed'
      opts.logger(`[supervisor] giving up after ${attempt} attempts`)
      opts.onPermanentFailure({ attempts: attempt, lastError })
      rejectWaiters(new Error('sidecar permanent failure'))
      return
    }
    const delay = BACKOFF_MS[attempt]
    attempt += 1
    health = 'restarting'
    opts.logger(`[supervisor] restart in ${delay}ms (attempt ${attempt}/${BACKOFF_MS.length})`)
    backoffTimer = setTimeout(spawnChild, delay)
  }

  const pollHealth = (): void => {
    if (stopped || !child || port === null) return
    void probeHealth(opts.host, port).then((ok) => {
      if (stopped) return
      if (ok) {
        health = 'ready'
        opts.logger(`[supervisor] sidecar ready pid=${child?.pid} port=${port}`)
        opts.onReady({ pid: child?.pid ?? -1, port: port! })
        resolveWaiters()
        // 60s healthy streak resets the backoff counter.
        healthyTimer = setTimeout(() => {
          attempt = 0
        }, HEALTHY_RESET_MS)
        return
      }
      if (Date.now() > bootDeadline) {
        opts.logger('[supervisor] health timeout — killing child')
        child?.kill('SIGKILL')
        return
      }
      pollTimer = setTimeout(pollHealth, HEALTH_POLL_INTERVAL_MS)
    })
  }

  function spawnChild(): void {
    if (stopped) return
    void probeFreePort(opts.host)
      .then((freePort) => {
        if (stopped) return
        port = freePort
        bootDeadline = Date.now() + HEALTH_BOOT_TIMEOUT_MS

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
          if (stopped) return
          const wasReady = health === 'ready'
          opts.logger(`[supervisor] sidecar exited code=${code} signal=${signal}`)
          if (wasReady) {
            // Crash after a healthy run — restart immediately, no backoff.
            health = 'restarting'
            spawnChild()
          } else {
            scheduleRestart(new Error(`exit code=${code} signal=${signal}`))
          }
        })

        pollTimer = setTimeout(pollHealth, HEALTH_POLL_INTERVAL_MS)
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
    waitForReady: () =>
      new Promise<void>((resolve, reject) => {
        if (health === 'ready') return resolve()
        if (health === 'failed') return reject(new Error('sidecar permanent failure'))
        readyWaiters.push({ resolve, reject })
      }),
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
        }, STOP_SIGTERM_GRACE_MS)
        proc.once('exit', () => {
          clearTimeout(killTimer)
          resolve()
        })
        proc.kill('SIGTERM')
      })
    }
  }
}
