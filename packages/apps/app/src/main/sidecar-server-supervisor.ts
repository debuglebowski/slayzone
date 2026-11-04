import { spawn, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import { readFileSync, watchFile, unwatchFile } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { HUB_PROCESS_ENV } from '@slayzone/platform/hub-switches'
import { HUB_DYNAMIC_PORT_RANGE } from '@slayzone/platform/paths'
import { SUPERVISED_STOP_SIGKILL_GRACE_MS } from '@slayzone/platform/parent-watch'
import { createChildReaper } from './child-reaper'

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
/**
 * Grace after SIGTERM before a RESTART escalates to SIGKILL. Shorter than a stop's
 * (SUPERVISED_STOP_SIGKILL_GRACE_MS) on purpose: the app stays up, so the outgoing
 * child can be neither orphaned nor left to finish "after the app" — a longer grace
 * would only delay the replacement the user is waiting for, which cannot start
 * until the outgoing child is gone (it needs the same fixed port).
 */
const RESTART_SIGTERM_GRACE_MS = 3_000
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
  /**
   * Grace after SIGTERM before `stop()` escalates to SIGKILL. Default
   * SUPERVISED_STOP_SIGKILL_GRACE_MS: past the child's own stop deadline, so a
   * graceful stop is never cut short.
   */
  stopSigtermGraceMs?: number
  /** Grace after SIGTERM before `restart()` escalates to SIGKILL. Default 3s. */
  restartSigtermGraceMs?: number
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
  /**
   * The DB file the side-car will open, DERIVED by the caller (getDatabasePath()
   * — `<ROOT>/storage` + the dev-vs-packaged filename). Diagnostics-only: it is
   * surfaced through {@link SidecarStatus.dbPath}, never handed to the child,
   * which derives the identical path from the inherited SLAYZONE_ROOT/_DEV. Passed
   * explicitly rather than read back out of `env` so the value can't silently go
   * null when no path-pointing var exists.
   */
  dbPath: string
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
   * ambiguity.
   *
   * "One per environment" holds per OS USER only: another user on the same machine
   * runs their own app on the same loopback. When a hub with a different root holds
   * this port, the supervisor binds a fallback in HUB_DYNAMIC_PORT_RANGE instead
   * (sticky for this run) and never reports the other hub as its own — readiness
   * requires `/health.pid` to be this child's pid.
   */
  fixedPort?: number
  /**
   * The Convex deployment (`host[:port]`) this app's renderer was built for, handed to
   * the hub as `SLAYZONE_HUB_CONVEX_ADDRESS` (after the inherited hub config is
   * stripped). The hub starts GitHub sign-in only against this one, never a URL a
   * client names (T-99). Absent = the hub has no Convex sign-in.
   */
  convexAddress?: string
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
  /** Absolute DB path the side-car opens (host-derived). Null before the first spawn. */
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
  /**
   * App quit has begun: a child that exits from now on stays down, and
   * `restart()` / hot-restart become no-ops. A live child is left running — the
   * quit drain may still need the hub — and `stop()` still reaps it.
   *
   * Without this, a hub that died during the drain (SIGINT to the dev process
   * group) respawned immediately and outlived a stalled quit, holding the port
   * the next app boot needed.
   */
  suspendRestarts: () => void
  /**
   * Reap the hub: SIGTERM, then SIGKILL only after the hub's own stop deadline
   * (SUPERVISED_STOP_SIGKILL_GRACE_MS), so a graceful stop is never cut short.
   * Resolves only once it is GONE — including one an in-flight `restart()` is still
   * killing (that kill, and its shorter grace, is joined) — so a quit that awaits it
   * cannot exit under a live hub. Idempotent: every call returns the same reap.
   *
   * Never resolves early, so an app quit must bound its wait (see
   * lifecycle/quit-reap-child.ts): a process stuck in uninterruptible sleep
   * survives even SIGKILL.
   */
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

/** Whether `port` on `host` can be bound right now (bind, then close at once). */
function canBind(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, host, () => srv.close(() => resolve(true)))
  })
}

/** First port in `range` that can be bound right now, or null when all are taken. */
async function firstBindablePort(
  host: string,
  range: { start: number; end: number }
): Promise<number | null> {
  for (let port = range.start; port <= range.end; port++) {
    if (await canBind(host, port)) return port
  }
  return null
}

type HealthProbe = {
  ok: boolean
  buildId: string | null
  /** The answering process's pid (a loopback-only `/health` field). Null when absent. */
  pid: number | null
  /** The answering hub's SLAYZONE_ROOT (loopback-only). Null when absent. */
  root: string | null
}

const NOT_HEALTHY: HealthProbe = { ok: false, buildId: null, pid: null, root: null }

/**
 * Single GET /health probe. Resolves `{ ok }` (HTTP 200) plus, from the body when
 * present: the running build's `buildId` (so the supervisor can flag a stale
 * sidecar), and the answering process's `pid` + `root` — the identity that tells
 * this supervisor's own child apart from any OTHER hub answering on the same port
 * (loopback is shared by every OS user on the machine).
 */
function probeHealth(host: string, port: number): Promise<HealthProbe> {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/health', timeout: 1_000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        resolve(NOT_HEALTHY)
        return
      }
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        const out: HealthProbe = { ok: true, buildId: null, pid: null, root: null }
        try {
          const parsed = JSON.parse(body) as { buildId?: unknown; pid?: unknown; root?: unknown }
          if (typeof parsed.buildId === 'string') out.buildId = parsed.buildId
          if (typeof parsed.pid === 'number') out.pid = parsed.pid
          if (typeof parsed.root === 'string') out.root = parsed.root
        } catch {
          /* body may be absent/legacy — identity unknown */
        }
        resolve(out)
      })
    })
    req.on('error', () => resolve(NOT_HEALTHY))
    req.on('timeout', () => {
      req.destroy()
      resolve(NOT_HEALTHY)
    })
  })
}

export function startSidecarServer(opts: SidecarServerOpts): SidecarServerHandle {
  // Resolve timing — each field falls back to its production default.
  const backoffMs = opts.timing?.backoffMs ?? BACKOFF_MS
  const healthyResetMs = opts.timing?.healthyResetMs ?? HEALTHY_RESET_MS
  const healthPollIntervalMs = opts.timing?.healthPollIntervalMs ?? HEALTH_POLL_INTERVAL_MS
  const healthBootTimeoutMs = opts.timing?.healthBootTimeoutMs ?? HEALTH_BOOT_TIMEOUT_MS
  const stopSigtermGraceMs = opts.timing?.stopSigtermGraceMs ?? SUPERVISED_STOP_SIGKILL_GRACE_MS
  const restartSigtermGraceMs = opts.timing?.restartSigtermGraceMs ?? RESTART_SIGTERM_GRACE_MS
  const buildWatchIntervalMs = opts.timing?.buildWatchIntervalMs ?? BUILD_WATCH_INTERVAL_MS

  let child: ChildProcess | null = null
  /**
   * Every hub process not yet exited, and one shared kill per process — a restart
   * and a stop, or two stops, join the same kill instead of one returning early.
   */
  const reaper = createChildReaper()
  /** The reap `stop()` started; every later call returns it. */
  let stopping: Promise<void> | null = null
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
  /** Set by `suspendRestarts()` (app quit): no respawn of any kind. */
  let restartsSuspended = false
  let backoffTimer: NodeJS.Timeout | null = null
  let healthyTimer: NodeJS.Timeout | null = null
  let pollTimer: NodeJS.Timeout | null = null
  let bootDeadline = 0
  /** One "not our child" log line per spawn, not one per 250ms poll. */
  let foreignAnswerLogged = false

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
    if (stopped || restartsSuspended) return
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
      // Something answered on our port, but it is not our child. Loopback is shared
      // by every OS user on the machine, so while our child is still booting (or
      // failing to bind) the answer can come from ANOTHER user's SlayZone hub —
      // adopting it hands this user's renderer, agents and CLI that user's data.
      // Never ready on a pid we did not spawn; the child's own exit (bind failure)
      // or the boot deadline decides what happens next.
      if (result.ok && result.pid !== child?.pid) {
        if (!foreignAnswerLogged) {
          foreignAnswerLogged = true
          opts.logger(
            `[supervisor] :${port} answered by pid=${result.pid ?? '?'}, not this child ` +
              `pid=${child?.pid} — not adopting it`
          )
        }
      } else if (result.ok) {
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

  /**
   * The port to bind when a fixed port is configured: the fixed port itself, unless
   * someone else holds it.
   *
   * The fixed port is per CHANNEL, not per OS user: two macOS users (fast user
   * switching) each run their own app — the single-instance lock is per user — but
   * share one loopback. When the other user's hub already holds it, binding it is
   * impossible and waiting for it is pointless (it is not going away), so take the
   * first free port in the hub block's dynamic range instead. `slay` finds it there
   * by its root (cli/src/local-hub.ts).
   *
   * One holder is NOT someone else: our own previous hub (same root), still in its
   * graceful stop after a quick app relaunch. Keep the fixed port for it — the
   * child's bind fails, and the ordinary backoff retries until the old hub is gone —
   * so this user's address stays the well-known one and two hubs never serve the
   * same database.
   */
  const choosePortWithFixed = async (fixed: number): Promise<number> => {
    if (await canBind(opts.host, fixed)) return fixed
    const holder = await probeHealth(opts.host, fixed)
    const ownRoot = opts.env.SLAYZONE_ROOT?.trim()
    if (holder.ok && holder.root && ownRoot && resolvePath(holder.root) === resolvePath(ownRoot)) {
      opts.logger(
        `[supervisor] :${fixed} still held by this app's previous hub (pid ${holder.pid ?? '?'}) — waiting for it to exit`
      )
      return fixed
    }
    const fallback = await firstBindablePort(opts.host, HUB_DYNAMIC_PORT_RANGE)
    const who = holder.ok
      ? `another hub (pid ${holder.pid ?? '?'}, root ${holder.root ?? 'unknown'})`
      : 'another process'
    if (fallback === null) {
      opts.logger(
        `[supervisor] :${fixed} held by ${who} and the hub block is full — trying it anyway`
      )
      return fixed
    }
    opts.logger(`[supervisor] :${fixed} held by ${who} — using :${fallback}`)
    return fallback
  }

  function spawnChild(): void {
    if (stopped || restartsSuspended) return
    // Sticky port first: a respawn after a healthy run keeps the port the renderer's
    // WS URL already points at. Otherwise the fixed port (or, when someone else
    // holds it, a fallback — see choosePortWithFixed); else a fresh OS-assigned one.
    // A spawn that never becomes healthy clears the sticky port (exit handler), so
    // the next attempt chooses again.
    const portSource =
      stickyPort !== null
        ? Promise.resolve(stickyPort)
        : opts.fixedPort !== undefined
          ? choosePortWithFixed(opts.fixedPort)
          : probeFreePort(opts.host)
    void portSource
      .then((freePort) => {
        if (stopped) return
        stickyPort = freePort
        port = freePort
        bootDeadline = Date.now() + healthBootTimeoutMs
        foreignAnswerLogged = false

        // Start from a hub-clean env: whatever hub-side config this app inherited
        // (launched from a task terminal, a shell profile) describes ANOTHER hub, and a
        // stray public address / switch / auth secret / dial-side address would make
        // this one refuse to boot (B1, B4, B5) or change who can sign in. The app's own
        // values are set below, after the strip.
        const inherited: NodeJS.ProcessEnv = { ...opts.env }
        for (const name of HUB_PROCESS_ENV) delete inherited[name]

        // stdin MUST stay a pipe that nothing writes to or closes: the hub reads its
        // EOF as "the app died" (@slayzone/platform/parent-watch — alongside an EPIPE
        // on stdout/stderr and a ppid poll) and stops itself, bounded, which is what
        // ends it when the app crashes or is SIGKILLed with no quit path to reap it.
        const childEnv: NodeJS.ProcessEnv = {
          ...inherited,
          ELECTRON_RUN_AS_NODE: '1',
          SLAYZONE_SUPERVISED: '1',
          // Where the sidecar hub LISTENS: one var, `host:port`, no scheme. This is
          // the hub's own name for it — `SLAYZONE_HUB_ADDRESS` is the DIAL-side name
          // (computer, `slay`) and a hub refuses to boot when it still sees it.
          SLAYZONE_HUB_LISTEN_ADDRESS: `${opts.host}:${freePort}`,
          // The desktop app's own hub has no login: the app already carries the user.
          // Set explicitly (it is also the default) so this does not depend on
          // whatever the app was launched with. Boot rule B1 is what keeps such a hub
          // on loopback.
          SLAYZONE_HUB_REQUIRE_LOGIN: '0',
          ...(opts.convexAddress ? { SLAYZONE_HUB_CONVEX_ADDRESS: opts.convexAddress } : {})
        }
        const proc = spawn(opts.execPath, [opts.scriptPath], {
          env: childEnv,
          stdio: ['pipe', 'pipe', 'pipe']
        })
        child = proc
        reaper.track(proc)
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
          if (restartsSuspended) {
            opts.logger(
              `[supervisor] sidecar exited code=${code} signal=${signal} during app quit — not restarting`
            )
            return
          }
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
    if (stopped || restartsSuspended) return
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
    await reaper.kill(proc, restartSigtermGraceMs)
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
        opts.logger(`[supervisor] build changed on disk (${diskBuildId}) — hot-restarting sidecar`)
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
        dbPath: opts.dbPath,
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
    suspendRestarts: () => {
      restartsSuspended = true
      // A pending backoff respawn is a restart too. Health polling stays: a
      // live child keeps reporting until stop().
      if (backoffTimer) clearTimeout(backoffTimer)
      backoffTimer = null
    },
    stop: () => {
      if (stopping) return stopping
      if (opts.hotRestartOnBuildChange) unwatchFile(manifestPath)
      stopped = true
      clearTimers()
      child = null
      // Every hub not yet gone, the one a mid-flight restart is killing included
      // (that kill is joined, not restarted); the `stopped` flag cancels any respawn.
      stopping = reaper.killAll(stopSigtermGraceMs)
      return stopping
    }
  }
}
