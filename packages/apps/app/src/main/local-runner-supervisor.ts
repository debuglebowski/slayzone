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
 * entirely from env (SLAYZONE_HUB_ADDRESS / SLAYZONE_HUB_JOIN_TOKEN / … — see
 * runner config.ts), supplied by the caller.
 */

/**
 * Exit code the runner uses for "the hub no longer recognizes me" (EX_CONFIG).
 *
 * Duplicated rather than imported: the app does not depend on
 * `@slayzone/runner-transport`, and taking a package dependency to share one
 * integer would pull the whole transport tree into the main bundle. The canonical
 * definition is `RUNNER_EXIT_NEEDS_RE_ENROLLMENT` in
 * `runner-transport/src/shared/frames.ts` — keep them in step (a mismatch degrades
 * to "supervisor keeps retrying", i.e. today's behavior, not a crash).
 */
const RUNNER_EXIT_NEEDS_RE_ENROLLMENT = 78

/** Production timing defaults. Overridable via `LocalRunnerOpts.timing` (tests). */
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000] as const
const HEALTHY_RESET_MS = 60_000
const STOP_SIGTERM_GRACE_MS = 3_000

/**
 * How much of the child's output to keep for the exit report. The runner owns
 * every agent pty, so an exit is never cheap — but its stdout/stderr is a
 * firehose while it lives, so only the tail is retained, and only until the
 * next spawn replaces it.
 */
const OUTPUT_TAIL_LINES = 40
const OUTPUT_TAIL_LINE_CHARS = 500

export type LocalRunnerTiming = {
  /** Backoff schedule (ms per retry). Length = max restart attempts. */
  backoffMs?: readonly number[]
  /** Continuous-uptime duration that resets the backoff attempt counter. */
  healthyResetMs?: number
  /** Grace period after SIGTERM before `stop()` escalates to SIGKILL. */
  stopSigtermGraceMs?: number
}

/**
 * What the supervisor knows about a runner that just died. Every agent pty is a
 * direct child of the runner, so this is the only place the cause of a
 * whole-fleet agent death is observable.
 */
export type LocalRunnerExitInfo = {
  /** Process exit code, or null when the runner was killed by a signal. */
  code: number | null
  /** Signal that killed the runner, or null on a self-exit. */
  signal: NodeJS.Signals | null
  /** How long this runner ran before dying. */
  uptimeMs: number
  /** 1-based index of the restart just scheduled; null when none follows. */
  restartAttempt: number | null
  /** Backoff delay before that restart; null when not restarting. */
  restartDelayMs: number | null
  /** Last {@link OUTPUT_TAIL_LINES} stdout+stderr lines from the dead runner. */
  tail: string[]
}

export type LocalRunnerOpts = {
  /** process.execPath — the Electron binary. */
  execPath: string
  /** Absolute path to the runner's dist/bin.cjs. */
  scriptPath: string
  /** Base env for the child (ELECTRON_RUN_AS_NODE + the SLAYZONE_RUNNER_* /
   *  SLAYZONE_HUB_ADDRESS / SLAYZONE_HUB_JOIN_TOKEN vars are merged in by the caller). */
  env: NodeJS.ProcessEnv
  /**
   * Mint a FRESH join token before a restart. Optional; without it a restart
   * reuses `env` verbatim.
   *
   * Why it matters: `SLAYZONE_HUB_JOIN_TOKEN` is SINGLE-USE. If the runner's
   * stored api key ever fails verification (it re-enrolls as a fallback), the
   * enrollment is refused with "join token rejected: unknown" and the runner exits
   * fatally. Restarting it with the same spent token reproduces that failure every
   * time until the backoff budget is exhausted, so the runner stays dead until the
   * app is restarted — a state that is invisible while the hub can execute work
   * itself, and fatal once runners are the only execution path.
   *
   * Returning `null` keeps the existing env (the mint failed; the plain backoff
   * retry is still worth attempting).
   */
  mintJoinToken?: () => Promise<string | null>
  /** Receives the runner's stdout/stderr lines + supervisor notices. */
  logger: (line: string) => void
  /**
   * Called once per runner death, before the restart (if any) is spawned.
   *
   * Separate from `logger` on purpose: the app wires `logger` to the boot log,
   * which is a no-op unless SLAYZONE_DEBUG_BOOT=1 — so for the whole life of
   * this supervisor a runner exit left NO trace anywhere, while killing every
   * agent on the machine. This callback is the durable channel; the caller
   * records it as a diagnostics event.
   */
  onExit?: (info: LocalRunnerExitInfo) => void
  /** Called once the backoff budget is exhausted — log-only, non-fatal. */
  onPermanentFailure?: (info: { attempts: number; lastError: unknown }) => void
  /** Called when the runner reports the hub no longer recognizes it. Restarts are
   *  suppressed from that point; the caller should surface it to the user. */
  onNeedsReEnrollment?: () => void
  /** Optional timing overrides (tests only — production omits this). */
  timing?: LocalRunnerTiming
}

export type LocalRunnerHandle = {
  getPid: () => number | null
  /**
   * Cycle the runner in place (Settings → Runners restart button).
   *
   * Not merely "kill and let supervision respawn": this is the ONLY recovery
   * from the supervisor's two dead ends — a spent backoff budget, and the
   * needs-re-enrollment latch — so it clears both, and re-mints the join token
   * (single-use; the one in `opts.env` is likely spent, and a dead stored
   * credential is exactly the case that needs a live one). Resolves once the
   * replacement child has been spawned; it dials + enrolls asynchronously after
   * that. Concurrent calls coalesce onto the first.
   */
  restart: () => Promise<void>
  stop: () => Promise<void>
}

export function startLocalRunner(opts: LocalRunnerOpts): LocalRunnerHandle {
  const backoffMs = opts.timing?.backoffMs ?? BACKOFF_MS
  const healthyResetMs = opts.timing?.healthyResetMs ?? HEALTHY_RESET_MS
  const stopSigtermGraceMs = opts.timing?.stopSigtermGraceMs ?? STOP_SIGTERM_GRACE_MS

  let child: ChildProcess | null = null
  /** Set when the runner reports its identity is gone. Suppresses restarts, which
   *  cannot fix it — only an operator re-enrolling can. */
  let needsReEnrollment = false
  /** Latest re-minted join token, or null to use whatever `opts.env` carries. */
  let currentJoinToken: string | null = null
  let attempt = 0
  let stopped = false
  let backoffTimer: NodeJS.Timeout | null = null
  let healthyTimer: NodeJS.Timeout | null = null
  /** In-flight `restart()`, so concurrent calls coalesce instead of double-spawning. */
  let restartInFlight: Promise<void> | null = null

  const clearTimers = (): void => {
    if (backoffTimer) clearTimeout(backoffTimer)
    if (healthyTimer) clearTimeout(healthyTimer)
    backoffTimer = healthyTimer = null
  }

  /**
   * Best-effort fresh join token for the NEXT spawn. Never throws — a mint
   * failure still leaves the plain retry worth attempting (see `mintJoinToken`).
   */
  const remintJoinToken = async (): Promise<void> => {
    if (!opts.mintJoinToken) return
    try {
      const token = await opts.mintJoinToken()
      if (token) {
        currentJoinToken = token
        opts.logger('[local-runner] minted a fresh join token')
      }
    } catch (err) {
      opts.logger(`[local-runner] join-token re-mint failed: ${String(err)}`)
    }
  }

  /** SIGTERM, escalating to SIGKILL after the grace period. Resolves when gone. */
  const killChild = (proc: ChildProcess): Promise<void> =>
    new Promise<void>((resolve) => {
      // Already dead (its `exit` fired but the handler hasn't run yet) — there is
      // no further `exit` event coming, so waiting for one would hang forever.
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
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

  /** The scheduling decision, so `onExit` can report it without re-deriving it. */
  type RestartDecision = { restartAttempt: number | null; restartDelayMs: number | null }
  const NO_RESTART: RestartDecision = { restartAttempt: null, restartDelayMs: null }

  const scheduleRestart = (lastError: unknown): RestartDecision => {
    if (stopped) return NO_RESTART
    if (needsReEnrollment) {
      opts.logger(
        '[local-runner] not restarting: this runner must be enrolled again before it can connect'
      )
      opts.onNeedsReEnrollment?.()
      return NO_RESTART
    }
    if (attempt >= backoffMs.length) {
      opts.logger(`[local-runner] giving up after ${attempt} attempts`)
      opts.onPermanentFailure?.({ attempts: attempt, lastError })
      return NO_RESTART
    }
    const delay = backoffMs[attempt]
    attempt += 1
    opts.logger(`[local-runner] restart in ${delay}ms (attempt ${attempt}/${backoffMs.length})`)
    backoffTimer = setTimeout(() => {
      // Refresh the join token before respawning: the old one may be spent, in
      // which case reusing it makes every retry fail identically (see
      // `mintJoinToken`). Best-effort — a mint failure still gets the plain retry.
      void remintJoinToken().finally(() => spawnChild())
    }, delay)
    return { restartAttempt: attempt, restartDelayMs: delay }
  }

  function spawnChild(): void {
    if (stopped) return
    // stdin is 'pipe' so the child detects parent death via stdin close.
    const proc = spawn(opts.execPath, [opts.scriptPath], {
      env: {
        ...opts.env,
        ELECTRON_RUN_AS_NODE: '1',
        // A re-minted token overrides the (possibly spent) one in `opts.env`.
        ...(currentJoinToken ? { SLAYZONE_HUB_JOIN_TOKEN: currentJoinToken } : {})
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    child = proc
    const spawnedAt = Date.now()
    // Scoped to THIS child: a fresh spawn must not inherit the corpse's output.
    const outputTail: string[] = []
    opts.logger(`[local-runner] spawned pid=${proc.pid}`)

    // A run that lasts healthyResetMs resets the backoff counter (a genuine
    // long-lived runner shouldn't accumulate attempts across a rare crash).
    healthyTimer = setTimeout(() => {
      attempt = 0
    }, healthyResetMs)

    const pipe = (chunk: Buffer): void => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) continue
        outputTail.push(line.slice(0, OUTPUT_TAIL_LINE_CHARS))
        if (outputTail.length > OUTPUT_TAIL_LINES) outputTail.shift()
        try {
          opts.logger(`[runner] ${line}`)
        } catch {
          /* a throwing logger must never stall the pipe */
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
      // A runner that needs re-enrolling will NEVER reconnect by restarting: the hub
      // has forgotten its identity, and only an operator enrolling it again fixes
      // that. Respawning would burn the backoff budget re-failing identically. Read
      // it from the EXIT CODE (a shared constant) rather than matching a log line.
      if (code === RUNNER_EXIT_NEEDS_RE_ENROLLMENT) needsReEnrollment = true
      child = null
      if (healthyTimer) clearTimeout(healthyTimer)
      if (stopped) return
      opts.logger(`[local-runner] runner exited code=${code} signal=${signal}`)
      // A crash after a long healthy run gets a fresh backoff budget (the reset
      // timer already zeroed `attempt`); a quick crash consumes an attempt.
      const uptimeMs = Date.now() - spawnedAt
      if (uptimeMs >= healthyResetMs) attempt = 0
      const decision = scheduleRestart(new Error(`exit code=${code} signal=${signal}`))
      // Report AFTER scheduling so the caller can say whether a restart follows.
      // Guarded: a throwing consumer must not skip the restart that just got
      // scheduled — the agents are already dead, losing the respawn too would
      // leave the machine unable to run anything.
      try {
        opts.onExit?.({ code, signal, uptimeMs, tail: [...outputTail], ...decision })
      } catch {
        /* a throwing exit reporter must never break supervision */
      }
    })
  }

  /**
   * Operator-initiated cycle. Distinct from the automatic restarts above in
   * three ways, each of which is the point of the button:
   *
   *  1. It CLEARS both dead ends — a spent backoff budget and the
   *     needs-re-enrollment latch. Automatic supervision must keep respecting
   *     them (retrying either is pure noise); an explicit human action is the
   *     one signal that says "the underlying cause may have changed".
   *  2. It detaches `child` BEFORE the kill, so the exit handler's
   *     `child !== proc` guard makes the death inert: no crash diagnostic
   *     claiming every agent died unexpectedly, and no competing backoff
   *     restart racing the one we are about to spawn.
   *  3. It re-mints unconditionally rather than on a backoff timer.
   */
  const doRestart = async (): Promise<void> => {
    if (stopped) return
    clearTimers()
    attempt = 0
    needsReEnrollment = false
    const proc = child
    child = null
    if (proc) {
      opts.logger(`[local-runner] restart requested — stopping pid=${proc.pid}`)
      await killChild(proc)
    } else {
      opts.logger('[local-runner] start requested — no runner was running')
    }
    await remintJoinToken()
    // A `stop()` (app quit) that landed while we were killing/minting wins:
    // spawning now would orphan a child no cleanup hook tracks.
    if (stopped) return
    spawnChild()
  }

  spawnChild()

  return {
    getPid: () => child?.pid ?? null,
    restart: () => {
      if (restartInFlight) return restartInFlight
      restartInFlight = doRestart().finally(() => {
        restartInFlight = null
      })
      return restartInFlight
    },
    stop: async () => {
      if (stopped) return
      stopped = true
      clearTimers()
      const proc = child
      child = null
      // No child to reap when a restart is mid-flight — it already detached and
      // SIGTERM'd the outgoing one, and the `stopped` flag above cancels its
      // respawn. Deliberately NOT awaited: its re-mint can retry for tens of
      // seconds, and quit must not block on that.
      if (!proc) return
      await killChild(proc)
    }
  }
}
