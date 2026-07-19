import { spawn, type ChildProcess } from 'node:child_process'

/**
 * Supervises a co-located @slayzone/runner subprocess (hub/runner split, wave 2B).
 *
 * Spawned in local mode (a hub always accepts runners; see index.ts).
 * this module is never imported/invoked ⇒ byte-identical boot.
 *
 * Mirrors the sidecar-server-supervisor's crash-recovery shape (backoff schedule,
 * healthy-uptime reset, permanent-failure cutoff, SIGTERM→SIGKILL stop) but
 * WITHOUT health polling: the runner exposes no `/health` endpoint — it dials the
 * hub and reports liveness over the runner socket. So "healthy" here is simply
 * "ran long enough without exiting", which resets the backoff attempt counter.
 *
 * The runner is spawned as the same Electron binary run with
 * ELECTRON_RUN_AS_NODE=1 (shares the app's node-pty native ABI), by file path —
 * never imported as a module (keeps it out of the main bundle). Its config comes
 * entirely from env (SLAYZONE_HUB_URL / SLAYZONE_RUNNER_JOIN_TOKEN / … — see runner
 * config.ts), supplied by the caller.
 */

/** Production timing defaults. Overridable via `LocalRunnerOpts.timing` (tests). */
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000] as const
const HEALTHY_RESET_MS = 60_000
const STOP_SIGTERM_GRACE_MS = 3_000

export type LocalRunnerTiming = {
  /** Backoff schedule (ms per retry). Length = max restart attempts. */
  backoffMs?: readonly number[]
  /** Continuous-uptime duration that resets the backoff attempt counter. */
  healthyResetMs?: number
  /** Grace period after SIGTERM before `stop()` escalates to SIGKILL. */
  stopSigtermGraceMs?: number
}

export type LocalRunnerOpts = {
  /** process.execPath — the Electron binary. */
  execPath: string
  /** Absolute path to the runner's dist/bin.cjs. */
  scriptPath: string
  /** Base env for the child (ELECTRON_RUN_AS_NODE + the SLAYZONE_RUNNER_* /
   *  SLAYZONE_HUB_URL / SLAYZONE_RUNNER_JOIN_TOKEN vars are merged in by the caller). */
  env: NodeJS.ProcessEnv
  /** Receives the runner's stdout/stderr lines + supervisor notices. */
  logger: (line: string) => void
  /** Called once the backoff budget is exhausted — log-only, non-fatal. */
  onPermanentFailure?: (info: { attempts: number; lastError: unknown }) => void
  /** Optional timing overrides (tests only — production omits this). */
  timing?: LocalRunnerTiming
}

export type LocalRunnerHandle = {
  getPid: () => number | null
  stop: () => Promise<void>
}

export function startLocalRunner(opts: LocalRunnerOpts): LocalRunnerHandle {
  const backoffMs = opts.timing?.backoffMs ?? BACKOFF_MS
  const healthyResetMs = opts.timing?.healthyResetMs ?? HEALTHY_RESET_MS
  const stopSigtermGraceMs = opts.timing?.stopSigtermGraceMs ?? STOP_SIGTERM_GRACE_MS

  let child: ChildProcess | null = null
  let attempt = 0
  let stopped = false
  let backoffTimer: NodeJS.Timeout | null = null
  let healthyTimer: NodeJS.Timeout | null = null

  const clearTimers = (): void => {
    if (backoffTimer) clearTimeout(backoffTimer)
    if (healthyTimer) clearTimeout(healthyTimer)
    backoffTimer = healthyTimer = null
  }

  const scheduleRestart = (lastError: unknown): void => {
    if (stopped) return
    if (attempt >= backoffMs.length) {
      opts.logger(`[local-runner] giving up after ${attempt} attempts`)
      opts.onPermanentFailure?.({ attempts: attempt, lastError })
      return
    }
    const delay = backoffMs[attempt]
    attempt += 1
    opts.logger(`[local-runner] restart in ${delay}ms (attempt ${attempt}/${backoffMs.length})`)
    backoffTimer = setTimeout(spawnChild, delay)
  }

  function spawnChild(): void {
    if (stopped) return
    // stdin is 'pipe' so the child detects parent death via stdin close.
    const proc = spawn(opts.execPath, [opts.scriptPath], {
      env: {
        ...opts.env,
        ELECTRON_RUN_AS_NODE: '1'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    child = proc
    const spawnedAt = Date.now()
    opts.logger(`[local-runner] spawned pid=${proc.pid}`)

    // A run that lasts healthyResetMs resets the backoff counter (a genuine
    // long-lived runner shouldn't accumulate attempts across a rare crash).
    healthyTimer = setTimeout(() => {
      attempt = 0
    }, healthyResetMs)

    const pipe = (chunk: Buffer): void => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) {
          try {
            opts.logger(`[runner] ${line}`)
          } catch {
            /* a throwing logger must never stall the pipe */
          }
        }
      }
    }
    proc.stdout?.on('data', pipe)
    proc.stderr?.on('data', pipe)

    proc.on('error', (err) => {
      opts.logger(`[local-runner] spawn error: ${String(err)}`)
      if (child === proc) {
        child = null
        if (healthyTimer) clearTimeout(healthyTimer)
        scheduleRestart(err)
      }
    })
    proc.on('exit', (code, signal) => {
      if (child !== proc) return
      child = null
      if (healthyTimer) clearTimeout(healthyTimer)
      if (stopped) return
      opts.logger(`[local-runner] runner exited code=${code} signal=${signal}`)
      // A crash after a long healthy run gets a fresh backoff budget (the reset
      // timer already zeroed `attempt`); a quick crash consumes an attempt.
      if (Date.now() - spawnedAt >= healthyResetMs) attempt = 0
      scheduleRestart(new Error(`exit code=${code} signal=${signal}`))
    })
  }

  spawnChild()

  return {
    getPid: () => child?.pid ?? null,
    stop: async () => {
      if (stopped) return
      stopped = true
      clearTimers()
      const proc = child
      child = null
      if (!proc) return
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
  }
}
