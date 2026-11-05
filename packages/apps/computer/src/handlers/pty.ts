/**
 * Computer-side pty exec handlers. Spawns node-pty processes on the computer
 * machine and streams their output back to the hub as `pty.data` notifications,
 * each carrying a MONOTONIC per-session sequence number (assigned by a
 * per-session {@link RingBuffer}). The hub detects gaps and replays them via
 * `pty.getBufferSince`; on process exit the computer emits `pty.exit`.
 *
 * This mirrors the terminal domain's pty-manager seq/buffer semantics, scoped
 * down to the exec surface the computer protocol exposes.
 *
 * The computer also OWNS each session's lifecycle verdicts, because it is the only
 * side that sees the output directly and the only side whose view survives a
 * dropped hub connection:
 *   - the startup deadline (`startupTimeoutMs`): no output at all in time ⇒ killed,
 *     with `pty.exit` saying `reason: 'startup-timeout'`;
 *   - exits, remembered as tombstones and reported by `pty.list`, so a hub that
 *     was away settles them with the real code;
 *   - spawn idempotency (`spawnId`): a repeat of the same attempt — the hub
 *     re-sending a spawn whose reply it lost — returns the running process.
 *   - agent-start admission (`admission`): an agent spawn waits for a slot in the
 *     computer-wide queue (spawn-admission.ts) before it is started; the reply and
 *     the startup deadline both begin when it LEAVES the queue. Input, resizes and
 *     kills sent meanwhile apply to the queued start — see {@link QueuedSpawn}.
 *
 * @module computer/handlers/pty
 */

import {
  HubToComputerMethods,
  ptyBackgroundJobsParamsSchema,
  type PtyBackgroundJobsResult,
  ptyGetBufferSinceParamsSchema,
  ptyKillParamsSchema,
  type PtyListResult,
  ptyPrioritizeParamsSchema,
  type PtySpawnParams,
  type PtyWarmSpawnParams,
  ptyResizeParamsSchema,
  ptyDoctorParamsSchema,
  type PtyDoctorResult,
  ptySpawnParamsSchema,
  ptyWarmAdoptParamsSchema,
  ptyWarmKillParamsSchema,
  ptyWarmSpawnParamsSchema,
  ptyWriteParamsSchema,
  type PtyDetectionParams,
  type PtyTheme,
  ptySetThemeParamsSchema,
  ptyGetReplayParamsSchema,
  type PtyGetReplayResult,
  ptyClearBufferParamsSchema,
  type PtyClearBufferResult,
  ptyRelayParamsSchema,
  type PtyRelayResult,
  PTY_SIGNAL_EVENT_NAME,
  PTY_INPUT_EVENT_NAME,
  type PtyInputPayload,
  RpcError,
  ComputerNotificationMethods,
  ComputerTransportErrorCodes,
  projectNotPlacedError
} from '@slayzone/computer-transport/shared'
import { writeSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import type * as pty from 'node-pty'
import { spawnNodePty } from '../node-pty'
import { findOnPath, getShellStartupArgs, resolveUserShell, shellExists } from '@slayzone/platform'
import {
  nodePtyInstallProblems as readNodePtyInstallProblems,
  type NodePtyInstallProblem
} from '@slayzone/platform/node-pty-install'
import { armStartupDeadline, type StartupDeadline } from '@slayzone/platform/startup-deadline'
import { probeBackgroundJobs } from '../background-jobs'
import { spawnCwd } from '../path-jail'
import { CARRY_WINDOW_MS, ExitTombstones } from '../exit-tombstones'
import {
  analyzePtyInput,
  DEFAULT_SESSION_ID_COMMAND,
  filterBufferData,
  RingBuffer,
  SESSION_ERROR_WINDOW_MS
} from '@slayzone/terminal/pty-detection'
import type { BufferSinceResult } from '@slayzone/terminal-contracts'
import {
  createSpawnAdmission,
  type AdmissionLane,
  type AdmissionSlot,
  type AdmissionTicket,
  type SpawnAdmission
} from '../spawn-admission'
import { buildPtySpawnEnv } from './spawn-env'
import { createPtySessionSignals, type PtySessionSignals } from '../pty-signals'
import type { HandlerContext, HubMethodTable } from './types'

/** Matches the terminal domain's per-session buffer cap (750 KiB). */
const MAX_BUFFER_SIZE = 750 * 1024

/**
 * After a startup-timeout SIGKILL, how long to wait for node-pty's own exit before
 * reaping the session here — so a process whose exit is never reported cannot sit
 * in `pty.list` as live forever. The same net the hub used to run.
 */
const STARTUP_KILL_REAP_MS = 2_000

/** One direct-link client streaming a session (docs/direct-link.md). */
interface DirectWatcher {
  onData(chunk: { seq: number; data: string }): void
  /** `exit`: the process ended; `replaced`: a new process took the session id. */
  onEnd(reason: 'exit' | 'replaced' | 'disposed'): void
}

/**
 * What a direct-link client reaches on this computer: the session's ONLY
 * scrollback and its live output, independent of whether the hub relays it.
 */
export interface DirectPtyService {
  /** Cold attach (`afterSeq` -1) or reattach; `size` null when no live process. */
  attach(
    sessionId: string,
    afterSeq: number
  ): {
    exists: boolean
    size: { cols: number; rows: number } | null
    buffer: BufferSinceResult
  }
  /** Replay after `afterSeq` (a cold `-1` includes the eviction prelude). */
  getBufferSince(sessionId: string, afterSeq: number): BufferSinceResult
  /**
   * A client's keystrokes, written to the process. Submits and Esc presses are
   * reported to the hub as a journaled `pty-input` event, so the hub's input
   * effects (attention, turn tracking, running) match a write it relayed. False
   * when there is no live session.
   */
  write(sessionId: string, data: string): boolean
  /** Stream a live session's output; null when there is none. Returns unsubscribe. */
  watch(
    sessionId: string,
    onData: DirectWatcher['onData'],
    onEnd: DirectWatcher['onEnd']
  ): (() => void) | null
}

interface PtySession {
  /** What direct writes typed since their last submit (see `analyzePtyInput`). */
  directInput: string
  /** Direct-link clients streaming this session; independent of {@link relay}. */
  directWatchers: Set<DirectWatcher>
  /**
   * A stale-resume error was detected inside the session-error window: like the
   * hub (pty-manager's `suppressOutput`), direct watchers do not see the raw
   * error line before the exit overlay. Released when the window closes.
   */
  suppressDirect?: boolean
  revokeCli?: () => void
  proc: pty.IPty
  buffer: RingBuffer
  /**
   * Output detection the hub asked for (`detection` on spawn/adopt): what the
   * output says goes to the hub as `pty-signal` events. Absent: the hub detects.
   */
  signals?: PtySessionSignals
  /** Stream output to the hub (`pty.data`); off while nobody watches (`pty.relay`). */
  relay: boolean
  /** Where and when the process started (disk conversation-id detection matches on it). */
  cwd: string
  startedAt: number
  /**
   * The key this session is currently filed under, read by its own onData/onExit.
   *
   * MUTABLE and read live, not captured: `pty.warmAdopt` promotes a warm session
   * by rekeying it (`warmId` → real `sessionId`) so the process, pid, buffer and
   * seq counter all survive. Closures that had captured the spawn-time id would
   * keep emitting under the dead `warmId` after that swap.
   */
  id: string
  taskId?: string
  /** Set for a warm (unadopted) session; cleared on adopt. */
  warm?: { cwd: string; startedAt: number }
  /** The hub's idempotency key for the spawn attempt that started this process. */
  spawnId?: string
  /** Present iff the spawn asked for a startup deadline; the first output clears it. */
  deadline?: StartupDeadline
  /** Why the COMPUTER ended this session (`startup-timeout`); absent otherwise. */
  exitReason?: string
  /** The agent-start slot this session holds until its first output (admitted spawns only). */
  admissionSlot?: AdmissionSlot
  /** Settled by node-pty onExit even after this object has been superseded. */
  exited: Promise<void>
  resolveExit: () => void
  replacing?: boolean
  stopping?: Promise<void>
}

/**
 * A spawn waiting for an agent-start slot. The hub already holds a handle for it
 * and talks to it like any session, so whatever it sends meanwhile is applied
 * here: input is kept and written right after the spawn (where it would have
 * landed had the spawn been immediate), a resize updates the size it starts at,
 * a kill cancels it. Never listed by `pty.list` — it has no process yet; a hub
 * that loses its reply re-sends it (same `spawnId`), which re-attaches here.
 */
interface QueuedSpawn {
  /** Session key (`sessionId`, or `warmId` for a warm spawn). */
  id: string
  taskId?: string
  spawnId?: string
  ticket: AdmissionTicket
  cols?: number
  rows?: number
  writes: string[]
  /** A queued write submitted `/status`: watch for a conversation id once started. */
  watchConversationId?: boolean
  /** Starts the process once admitted; returns the reply. */
  run: (slot: AdmissionSlot) => unknown
  promise: Promise<unknown>
  resolve: (value: unknown) => void
  reject: (err: unknown) => void
}

export interface PtyHandlers {
  /** What direct-link clients reach (docs/direct-link.md). */
  direct: DirectPtyService
  hasWork(): boolean
  hasTaskWork(taskId: string): boolean
  stopTask(taskId: string): Promise<void>
  handlers: HubMethodTable
  /** Kill every live pty (called on computer shutdown). */
  disposeAll(): void
  /**
   * The hub connection went away: drop spawns still waiting for a slot. Their
   * replies can no longer be delivered, and the hub settles each lost spawn on
   * reconnect against `pty.list` — re-sending it if nothing holds it — so a start
   * that ran anyway would only be a process nothing tracks.
   */
  dropQueued(reason: string): void
}

export interface PtyHandlerOptions {
  /** Rechecked at the actual start/adoption, after admission waits. */
  assertTaskActive?(taskId: string): void
  /**
   * Agent-start admission queue. Production passes ONE instance shared by every
   * hub connection (the contention is the machine's); absent, this handler set
   * gets a private one.
   */
  admission?: SpawnAdmission
  /** node-pty's `spawn`; replaced in tests to model a spawn it refuses. */
  spawnPty?: typeof pty.spawn
  /** Why the node-pty install can't start processes; defaults to reading it off disk. */
  nodePtyInstallProblems?: () => NodePtyInstallProblem[]
  /**
   * Settles once the login-shell PATH is adopted into `process.env` (computer
   * main). Spawns never wait for it — a pty's login shell builds its own PATH —
   * but Doctor's binary lookups read `process.env.PATH`, so they do.
   */
  pathReady?: Promise<unknown>
}

/**
 * The node-pty package this computer loads, resolved as its import is: `require`
 * in the CJS bundle (relative to the bundle, like the external it keeps); from the
 * entry script under unbundled ESM (tests), where `import.meta` is off limits —
 * the bundle compiles this file too and would empty it.
 */
function nodePtyDir(): string {
  const resolve =
    typeof require === 'function'
      ? require.resolve
      : createRequire(process.argv[1] ?? path.join(process.cwd(), 'index.js')).resolve
  return path.dirname(resolve('node-pty/package.json'))
}

const installProblemsOnDisk = (): NodePtyInstallProblem[] =>
  readNodePtyInstallProblems(nodePtyDir())

/**
 * Build the pty handler table. Sessions are tracked in a Map keyed by
 * `sessionId` and cleaned up on process exit.
 */
/**
 * `getProjectPaths` lets a cwd-less spawn resolve its own directory. The hub no
 * longer knows where a project lives on this machine — it held one path column
 * covering every computer — so `pty.spawn` may arrive carrying `projectId` instead
 * of `cwd`, and this side does the lookup.
 */
export function createPtyHandlers(
  ctx: HandlerContext,
  getProjectPaths?: () => {
    get(projectId: string): { path: string } | null
  } | null,
  options: PtyHandlerOptions = {}
): PtyHandlers {
  const sessions = new Map<string, PtySession>()
  /** The hub's terminal theme, as last pushed (`pty.setTheme`); new pipelines start with it. */
  let theme: PtyTheme | undefined
  const tombstones = new ExitTombstones()
  const admission = options.admission ?? createSpawnAdmission()
  // node-pty loads at the first spawn: a missing one fails terminals, not the computer.
  const spawnPty = options.spawnPty ?? spawnNodePty
  const installProblems = options.nodePtyInstallProblems ?? installProblemsOnDisk
  /** Spawns waiting for an agent-start slot, keyed like `sessions`. */
  const queued = new Map<string, QueuedSpawn>()
  const starts = new Map<
    string,
    { spawnId?: string; taskId?: string; promise: Promise<unknown>; cancelled: boolean }
  >()
  /**
   * `pty.relay` for an attempt that has no session yet (queued for a slot, or
   * waiting out a replacement): applied when it starts, so a change made while it
   * waited is not lost — the hub never sends it again.
   */
  const relayBeforeStart = new Map<string, { spawnId?: string; on: boolean }>()

  function serializeStart<T>(
    id: string,
    spawnId: string | undefined,
    taskId: string | undefined,
    run: (assertActive: () => void) => Promise<T>
  ): Promise<T> {
    const prior = starts.get(id)?.promise ?? Promise.resolve()
    const record = {
      spawnId,
      taskId,
      promise: undefined as unknown as Promise<T>,
      cancelled: false
    }
    const assertActive = (): void => {
      if (record.cancelled) throw new Error(`pty ${id}: spawn killed before start`)
    }
    const current = prior
      .catch(() => {
        // A refused predecessor must not block a later attempt.
      })
      .then(() => {
        assertActive()
        return run(assertActive)
      })
    record.promise = current
    starts.set(id, record)
    void current
      .finally(() => {
        if (starts.get(id)?.promise === current) starts.delete(id)
      })
      .catch(() => {
        // Rejection belongs to caller; cleanup still ran.
      })
    return current
  }

  async function waitForExit(session: PtySession, timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        session.exited.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs)
          timer.unref?.()
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  function stopPty(session: PtySession, signal?: string): Promise<void> {
    if (session.stopping) return session.stopping
    session.stopping = (async () => {
      try {
        session.proc.kill(signal)
      } catch {
        // Exit may already be in flight.
      }
      if (await waitForExit(session, 2_000)) return
      try {
        session.proc.kill('SIGKILL')
      } catch {
        // Exit may already be in flight.
      }
      if (!(await waitForExit(session, 2_000))) {
        throw new Error(`pty ${session.id}: process ${session.proc.pid} did not exit`)
      }
    })()
    void session.stopping.catch(() => {
      // A later kill may retry when the process did not exit.
      session.stopping = undefined
    })
    return session.stopping
  }

  async function stopBeforeReplacement(id: string): Promise<void> {
    const old = sessions.get(id)
    if (!old) return
    old.replacing = true
    try {
      await stopPty(old)
    } catch (err) {
      old.replacing = false
      throw err
    }
  }

  /**
   * An explicit `cwd` wins: it is either a worktree this computer created or a
   * `task.base_dir` the user set, never a hub guess about someone else's disk.
   * Otherwise resolve the project's own checkout here.
   *
   * A project with no mapping fails LOUDLY. Falling back to the computer's launch
   * directory would start the agent in the wrong tree and look like it worked,
   * which is the exact failure this whole seam removes.
   *
   * Either way the result passes the jail (T-27, `spawnCwd`): a cwd outside
   * `allowedRoots` is refused, never started.
   */
  function resolveCwd(opts: { cwd?: string; projectId?: string }): string {
    if (opts.cwd) return spawnCwd(opts.cwd, ctx.config.allowedRoots)
    if (!opts.projectId) throw new Error('pty.spawn needs either cwd or projectId')
    const entry = getProjectPaths?.()?.get(opts.projectId)
    if (!entry) throw projectNotPlacedError(opts.projectId)
    return spawnCwd(entry.path, ctx.config.allowedRoots)
  }

  /**
   * Spawn a pty and file it under `id`. Shared by `pty.spawn` and
   * `pty.warmSpawn` so a warm session is byte-for-byte an ordinary session —
   * same buffering, same seq assignment, same exit handling — differing only in
   * the key it is filed under and (until adopted) the `warm` marker.
   */
  function spawnSession(
    id: string,
    opts: {
      command: string
      args?: string[]
      cwd?: string
      env?: Record<string, string>
      cols?: number
      rows?: number
      projectId?: string
      warm?: { cwd: string; startedAt: number }
      spawnId?: string
      startupTimeoutMs?: number
      taskId?: string
      detection?: PtyDetectionParams
      relay?: boolean
      /** A continued buffer (`carryOutput`); absent = a fresh one. */
      buffer?: RingBuffer
    }
  ): PtySession {
    if (opts.taskId) options.assertTaskActive?.(opts.taskId)
    const cwd = resolveCwd(opts)
    if (sessions.has(id)) throw new Error(`pty ${id}: old process still live`)

    const capability = ctx.cliRelay?.issue()
    let proc: pty.IPty
    try {
      proc = spawnPty(opts.command, opts.args ?? [], {
        name: 'xterm-color',
        cwd,
        env: buildPtySpawnEnv(ctx, opts.env, capability),
        cols: opts.cols ?? 80,
        rows: opts.rows ?? 24
      })
    } catch (err) {
      capability?.revoke()
      throw explainSpawnFailure(err)
    }

    const buffer = opts.buffer ?? new RingBuffer(MAX_BUFFER_SIZE)
    let resolveExit!: () => void
    const exited = new Promise<void>((resolve) => (resolveExit = resolve))
    const session: PtySession = {
      directInput: '',
      directWatchers: new Set(),
      revokeCli: capability?.revoke,
      proc,
      buffer,
      id,
      relay: relayAtStart(id, opts.spawnId, opts.relay),
      cwd,
      startedAt: Date.now(),
      ...(opts.taskId ? { taskId: opts.taskId } : {}),
      exited,
      resolveExit,
      ...(opts.warm ? { warm: opts.warm } : {}),
      ...(opts.spawnId !== undefined ? { spawnId: opts.spawnId } : {})
    }
    sessions.set(id, session)
    if (opts.detection && !opts.warm) attachSignals(session, opts.detection)
    if (opts.startupTimeoutMs !== undefined) {
      // Armed at the REAL spawn, on the machine that sees the output — see the
      // module doc. Its verdict reads pending output first (drain-before-verdict).
      session.deadline = armStartupDeadline({
        timeoutMs: opts.startupTimeoutMs,
        onExpire: () => expireStartup(session)
      })
    }

    proc.onData((data) => {
      // Ignore output from a session that has since been superseded/disposed.
      // `session.id` is read LIVE so a rekey (warm adopt) redirects the stream.
      if (sessions.get(session.id) !== session) return
      session.deadline?.markOutput()
      // An agent's first output means it is past its expensive start. Not so for a
      // warm session: its first output is the SHELL's, and the agent it then execs
      // boots after that — so a warm start keeps its slot until the cap, exit or
      // adoption, and the pool's agents boot one at a time.
      if (!session.warm) releaseAdmission(session)
      // Output is buffered and streamed BYTE-IDENTICALLY, deliberately. The two
      // are interchangeable by contract, not redundant: the hub's demux keeps
      // whichever copy of a seq arrives first and drops the other, then emits that
      // seq exactly once, so a stream can be assembled from live frame 3 +
      // backfilled frame 4 + live frame 5. Any per-seq divergence corrupts the
      // result. So whatever transforms a chunk runs ONCE, before the append, and
      // the same string is both buffered and streamed.
      //
      // For a session the hub asked to run the output pipeline (`detection`), that
      // transform happens here: terminal queries answered at once, detection run,
      // the replay filter applied (`pty-signals.ts`, stateless per chunk). Without
      // it (an older hub) the raw bytes go out and the hub's own pty onData answers
      // and filters them, as it always did.
      const processed = session.signals?.process(data)
      const out = processed ? processed.clean : data
      const seq = buffer.append(out)
      // A WARM session buffers but does not stream: the hub has no session to
      // route it to yet, and `pty.warmAdopt` hands the whole buffer over at
      // adopt. Emitting under a `warmId` the hub never registered would be
      // dropped anyway — and would burn a seq the adopt handover then replays.
      if (session.warm) return
      // What the chunk says goes FIRST: a stale-resume error suppresses this very
      // chunk on the hub, which must know before the bytes arrive.
      if (processed) session.signals?.report(processed.detection, seq)
      // Direct-link clients first, whatever the hub relays: the same bytes, the same seq.
      if (processed?.detection?.suppressOutput) session.suppressDirect = true
      if (session.suppressDirect && Date.now() >= session.startedAt + SESSION_ERROR_WINDOW_MS)
        session.suppressDirect = false
      if (!session.suppressDirect) {
        for (const watcher of session.directWatchers) watcher.onData({ seq, data: out })
      }
      // Nobody watches it: buffered and detected, not streamed (the hub reads the
      // buffer when someone attaches, and turns relay on).
      if (!session.relay) return
      ctx.dialer.notify(ComputerNotificationMethods.ptyData, {
        sessionId: session.id,
        ...(session.spawnId ? { spawnId: session.spawnId } : {}),
        seq,
        data: out
      })
    })

    proc.onExit(({ exitCode, signal }) => {
      capability?.revoke()
      session.resolveExit()
      reap(
        session,
        typeof exitCode === 'number' ? exitCode : null,
        signal != null ? String(signal) : null
      )
    })

    return session
  }

  /** Start output detection for a session; ids are read live (warm adopt rekeys). */
  function attachSignals(session: PtySession, detection: PtyDetectionParams): void {
    session.signals?.dispose()
    session.signals = createPtySessionSignals({
      // The latest theme the hub pushed wins over the one it spawned with.
      params: { ...detection, ...(theme ? { theme } : {}) },
      ids: { sessionId: () => session.id, spawnId: () => session.spawnId },
      emit: (payload) => {
        if (sessions.get(session.id) !== session) return
        ctx.dialer.notify(ComputerNotificationMethods.event, {
          name: PTY_SIGNAL_EVENT_NAME,
          payload
        })
      },
      // Synchronously when the pty exposes its fd, so the answer reaches the program
      // in the same read loop iteration (as the hub did); else node-pty's write.
      respond: (answer) => {
        const fd = (session.proc as unknown as { fd?: number }).fd
        try {
          if (typeof fd !== 'number') throw new Error('no fd')
          writeSync(fd, answer)
        } catch {
          session.proc.write(answer)
        }
      },
      disk: { cwd: session.cwd, startedAt: session.startedAt },
      size: { cols: session.proc.cols, rows: session.proc.rows }
    })
  }

  /**
   * node-pty refused to start a process. Its message names no cause ("posix_spawnp
   * failed." means it could not exec its own spawn-helper), so append whatever the
   * install check finds, each with its fix. This text is what the hub shows under
   * "The computer couldn't start the agent.".
   */
  function explainSpawnFailure(err: unknown): Error {
    const original = err instanceof Error ? err : new Error(String(err))
    let problems: NodePtyInstallProblem[]
    try {
      problems = installProblems()
    } catch {
      return original // The check is a diagnosis; it must never mask the refusal.
    }
    if (problems.length === 0) return original
    const why = problems.map((p) => `${p.detail} Fix: ${p.fix}`).join(' ')
    return new Error(`${original.message} ${why}`, { cause: original })
  }

  /** Report a session's exit and remember it. Idempotent per session object. */
  function endDirectWatchers(session: PtySession, reason: 'exit' | 'replaced' | 'disposed'): void {
    const watchers = [...session.directWatchers]
    session.directWatchers.clear()
    for (const watcher of watchers) watcher.onEnd(reason)
  }

  function reap(session: PtySession, exitCode: number | null, signal: string | null): void {
    // Only the CURRENTLY-active session for this id may clear the map and
    // emit exit — a superseded/disposed pty exiting must stay silent, else it
    // would tear down the replacement and confuse the hub.
    if (sessions.get(session.id) !== session) return
    endDirectWatchers(session, session.replacing ? 'replaced' : 'exit')
    // A failed resume's cause rides a signal that lands just before the exit frame.
    if (!session.replacing && !session.warm)
      session.signals?.exited(exitCode, session.buffer.toString())
    sessions.delete(session.id)
    session.signals?.dispose()
    session.deadline?.cancel()
    releaseAdmission(session)
    if (session.replacing) {
      tombstones.add(session.id, {
        spawnId: session.spawnId,
        pid: session.proc.pid,
        exitCode,
        signal,
        reason: 'replaced'
      })
      return
    }
    // A warm session dying before adoption is the computer's business: the hub
    // holds no session for it. It re-warms on its own reconcile.
    if (session.warm) {
      ctx.log('warm pty exited before adoption', { warmId: session.id })
      return
    }
    const reason = session.exitReason
    const delivered = ctx.dialer.notify(ComputerNotificationMethods.ptyExit, {
      sessionId: session.id,
      ...(session.spawnId ? { spawnId: session.spawnId } : {}),
      exitCode,
      signal,
      ...(reason ? { reason } : {})
    })
    tombstones.add(session.id, {
      spawnId: session.spawnId,
      pid: session.proc.pid,
      exitCode,
      signal,
      reason,
      // The hub never got this exit, so it may be missing output too. A piped
      // session's buffer is the ONLY copy: kept briefly for a continuing spawn.
      ...(delivered
        ? session.signals
          ? { buffer: session.buffer, bufferUntil: Date.now() + CARRY_WINDOW_MS }
          : {}
        : { buffer: session.buffer })
    })
  }

  /** No output at all within the spawn's `startupTimeoutMs`: the session is hung. */
  function expireStartup(session: PtySession): void {
    if (sessions.get(session.id) !== session) return
    session.exitReason = 'startup-timeout'
    ctx.log('pty startup deadline expired with no output — killing', {
      sessionId: session.id,
      pid: session.proc.pid
    })
    try {
      session.proc.kill('SIGKILL')
    } catch {
      // Already gone — its exit (or the net below) reports it.
    }
    const net = setTimeout(() => reap(session, null, null), STARTUP_KILL_REAP_MS)
    net.unref?.()
  }

  /** Hand back a session's agent-start slot (first output, exit, replacement). */
  function releaseAdmission(session: PtySession): void {
    const slot = session.admissionSlot
    if (!slot) return
    session.admissionSlot = undefined
    slot.release()
  }

  type SpawnReply = { pid: number; startupDeadline?: true; detection?: true; seq?: number }

  function startSession(params: PtySpawnParams): SpawnReply {
    const shell = params.computerShell ? resolveUserShell() : params.command
    const args = params.computerShell
      ? [
          ...getShellStartupArgs(shell),
          ...(params.computerShellCommand ? ['-c', params.computerShellCommand] : [])
        ]
      : params.args
    // A continuing spawn keeps the session's scrollback: the reaped attempt's
    // buffer (seq continues), then the hub's preamble, then the new process.
    let carried: RingBuffer | undefined
    if (params.carryOutput) {
      carried =
        tombstones.takeBuffer(params.sessionId, params.carryOutput.fromSpawnId) ??
        new RingBuffer(MAX_BUFFER_SIZE)
      if (params.carryOutput.preamble) carried.append(params.carryOutput.preamble)
    }
    const session = spawnSession(params.sessionId, {
      ...params,
      command: shell,
      args,
      ...(carried ? { buffer: carried } : {})
    })
    ctx.log('pty spawned', {
      sessionId: params.sessionId,
      pid: session.proc.pid,
      command: shell
    })
    return {
      pid: session.proc.pid,
      ...(session.deadline ? { startupDeadline: true as const } : {}),
      ...(session.signals ? { detection: true as const } : {}),
      ...(carried ? { seq: carried.getCurrentSeq() } : {})
    }
  }

  /**
   * Queue `run` behind an agent-start slot under `id`. A start already queued
   * under the same id is the same attempt when its `spawnId` matches (the hub
   * re-sent a request whose reply it lost: answer both with the one start), and
   * is superseded otherwise — exactly as a live session is replaced by a new
   * spawn for its id. The superseded request is answered with the replacement's
   * reply, never an error: it did not fail, it was replaced.
   */
  function enqueueSpawn(
    id: string,
    lane: AdmissionLane,
    spec: { spawnId?: string; taskId?: string; cols?: number; rows?: number },
    run: (slot: AdmissionSlot, item: QueuedSpawn) => unknown
  ): Promise<unknown> {
    const prior = queued.get(id)
    if (prior && spec.spawnId !== undefined && prior.spawnId === spec.spawnId) {
      return prior.promise
    }
    let resolve!: (value: unknown) => void
    let reject!: (err: unknown) => void
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res
      reject = rej
    })
    const item: QueuedSpawn = {
      id,
      ...(spec.taskId ? { taskId: spec.taskId } : {}),
      ...(spec.spawnId !== undefined ? { spawnId: spec.spawnId } : {}),
      ...(spec.cols !== undefined ? { cols: spec.cols } : {}),
      ...(spec.rows !== undefined ? { rows: spec.rows } : {}),
      writes: [],
      ticket: undefined as unknown as AdmissionTicket,
      run: (slot) => run(slot, item),
      promise,
      resolve,
      reject
    }
    if (prior) {
      admission.cancel(prior.ticket)
      prior.resolve(promise)
    }
    queued.set(id, item)
    const enqueuedAt = Date.now()
    item.ticket = admission.enqueue(lane, (slot) => {
      // Cancelled or superseded while the slot was being granted: hand it back.
      if (queued.get(id) !== item) {
        slot.release()
        return
      }
      queued.delete(id)
      let reply: unknown
      try {
        reply = item.run(slot)
      } catch (err) {
        slot.release()
        item.reject(err)
        return
      }
      const waitedMs = Date.now() - enqueuedAt
      if (waitedMs >= 1_000) ctx.log('agent start admitted after queueing', { id, lane, waitedMs })
      Promise.resolve(reply).then(item.resolve, (err) => {
        slot.release()
        item.reject(err)
      })
    })
    return promise
  }

  function spawn(rawParams: unknown): SpawnReply | Promise<unknown> {
    const params = ptySpawnParamsSchema.parse(rawParams)
    if (
      params.taskId &&
      params.env?.SLAYZONE_TASK_ID &&
      params.taskId !== params.env.SLAYZONE_TASK_ID
    )
      throw new Error('PTY task identity mismatch')
    params.taskId ??= params.env?.SLAYZONE_TASK_ID
    if (params.taskId) options.assertTaskActive?.(params.taskId)
    const starting = starts.get(params.sessionId)
    if (starting && params.spawnId !== undefined && starting.spawnId === params.spawnId) {
      return starting.promise
    }
    if (params.spawnId !== undefined) {
      const live = sessions.get(params.sessionId)
      if (live && !live.warm && live.spawnId === params.spawnId) {
        // The hub re-sent an attempt whose reply it lost. This process IS that
        // attempt — answer with it rather than killing it to start a twin.
        return {
          pid: live.proc.pid,
          ...(live.deadline ? { startupDeadline: true as const } : {}),
          ...(live.signals ? { detection: true as const } : {})
        }
      }
      if (tombstones.ran(params.sessionId, params.spawnId)) {
        // Unreachable by the hub's reconcile order (it reads `pty.list` first and
        // settles a reaped attempt from its tombstone). Refused rather than run
        // twice should that ever not hold.
        throw new Error(
          `pty.spawn ${params.sessionId}: attempt ${params.spawnId} already ran and exited — not starting it twice`
        )
      }
    }
    if (params.admission === undefined) {
      // Not an agent start (or an older hub): start now. A start still queued
      // under this id is superseded by this one, like a live session would be.
      const prior = queued.get(params.sessionId)
      const reply =
        sessions.has(params.sessionId) || starts.has(params.sessionId)
          ? serializeStart(
              params.sessionId,
              params.spawnId,
              params.taskId,
              async (assertActive) => {
                await stopBeforeReplacement(params.sessionId)
                assertActive()
                return startSession(params)
              }
            )
          : startSession(params)
      if (prior) {
        queued.delete(params.sessionId)
        admission.cancel(prior.ticket)
        prior.resolve(reply)
      }
      return reply
    }
    return enqueueSpawn(params.sessionId, params.admission, params, async (slot, item) => {
      const reply = await serializeStart(
        params.sessionId,
        params.spawnId,
        params.taskId,
        async (assertActive) => {
          await stopBeforeReplacement(params.sessionId)
          assertActive()
          return startSession({
            ...params,
            ...(item.cols !== undefined ? { cols: item.cols } : {}),
            ...(item.rows !== undefined ? { rows: item.rows } : {})
          })
        }
      )
      const session = sessions.get(params.sessionId)!
      session.admissionSlot = slot
      // Input the hub sent while this waited, in order — where it would have
      // landed had the spawn been immediate.
      for (const data of item.writes) session.proc.write(data)
      if (item.watchConversationId) session.signals?.watchConversationId()
      return reply
    })
  }

  function startWarm(params: PtyWarmSpawnParams, cols?: number, rows?: number): PtySession {
    const shell = params.computerShell ? resolveUserShell() : params.command
    const session = spawnSession(params.warmId, {
      ...params,
      command: shell,
      args: params.computerShell ? getShellStartupArgs(shell) : params.args,
      ...(cols !== undefined ? { cols } : {}),
      ...(rows !== undefined ? { rows } : {}),
      warm: { cwd: params.cwd, startedAt: Date.now() }
    })
    // Pre-boot the agent inside the warm shell. Written to stdin rather than
    // spawned directly so the shell's rc init (PATH, toolchain shims) has already
    // run — the whole point of warming.
    if (params.postSpawnCommand) session.proc.write(`${params.postSpawnCommand}\r`)
    ctx.log('warm pty spawned', {
      warmId: params.warmId,
      pid: session.proc.pid
    })
    return session
  }

  /**
   * A warm agent is an agent start like any other, so it goes through admission —
   * in the `warm` lane, which waits until no task's agent is starting. The pool is
   * a speed-up for the next task; it must never slow down the ones being opened.
   */
  function warmSpawn(rawParams: unknown): Promise<unknown> {
    const params = ptyWarmSpawnParamsSchema.parse(rawParams)
    const live = sessions.get(params.warmId)
    if (live?.warm) return Promise.resolve({ pid: live.proc.pid })
    const waiting = queued.get(params.warmId)
    if (waiting) return waiting.promise
    return enqueueSpawn(params.warmId, 'warm', params, (slot, item) => {
      const session = startWarm(params, item.cols, item.rows)
      session.admissionSlot = slot
      for (const data of item.writes) session.proc.write(data)
      return { pid: session.proc.pid }
    })
  }

  /** Remove a still-queued start, answering its request. True when one was queued. */
  function cancelQueued(id: string, reason: string): QueuedSpawn | null {
    const item = queued.get(id)
    if (!item) return null
    queued.delete(id)
    admission.cancel(item.ticket)
    item.reject(new Error(`${id}: ${reason} before it started`))
    return item
  }

  function prioritize(rawParams: unknown): { ok: true; queued: boolean } {
    const params = ptyPrioritizeParamsSchema.parse(rawParams)
    const item = queued.get(params.sessionId)
    return {
      ok: true,
      queued:
        item && (params.spawnId === undefined || item.spawnId === params.spawnId)
          ? admission.prioritize(item.ticket)
          : false
    }
  }

  /** Which of claude's background jobs still run under this session's process
   *  (claude fires no hook when one exits — see background-jobs.ts). A session
   *  this computer no longer holds has none. */
  async function backgroundJobs(rawParams: unknown): Promise<PtyBackgroundJobsResult> {
    const params = ptyBackgroundJobsParamsSchema.parse(rawParams)
    const session = sessions.get(params.sessionId)
    const pid =
      session && (params.spawnId === undefined || session.spawnId === params.spawnId)
        ? session.proc.pid
        : undefined
    if (pid === undefined) return { ok: true, supported: true, alive: [] }
    const alive = await probeBackgroundJobs(pid, params.jobs)
    return alive === null
      ? { ok: true, supported: false, alive: [] }
      : { ok: true, supported: true, alive }
  }

  /** Doctor's facts about this computer (see `ptyDoctorResultSchema`). */
  async function doctor(rawParams: unknown): Promise<PtyDoctorResult> {
    const params = ptyDoctorParamsSchema.parse(rawParams)
    await options.pathReady
    // The env a spawn gets (bin override dir first), so the answer is the binary
    // an agent started here would run.
    const env = buildPtySpawnEnv(ctx)
    const binaries = await Promise.all(
      params.binaries.map(async (binary) => ({
        binary,
        path: await findOnPath(binary, env)
      }))
    )
    return {
      ok: true,
      problems: installProblems(),
      shellExists: shellExists(resolveUserShell()),
      binaries
    }
  }

  function dropQueued(reason: string): void {
    for (const id of [...queued.keys()]) cancelQueued(id, reason)
  }

  function warmAdopt(rawParams: unknown): {
    pid: number
    data: string
    seq: number
    detection?: true
  } {
    const params = ptyWarmAdoptParamsSchema.parse(rawParams)
    if (params.taskId) options.assertTaskActive?.(params.taskId)
    const adopted = sessions.get(params.sessionId)
    if (adopted?.taskId && params.taskId && adopted.taskId !== params.taskId)
      throw new Error('PTY task identity mismatch')
    if (adopted?.spawnId === params.warmId) {
      return {
        pid: adopted.proc.pid,
        data: adopted.buffer.toString(),
        seq: adopted.buffer.getCurrentSeq(),
        ...(adopted.signals ? { detection: true as const } : {})
      }
    }
    const session = sessions.get(params.warmId)
    if (!session || !session.warm) {
      throw new RpcError(
        ComputerTransportErrorCodes.unknownComputer,
        `no warm session ${params.warmId} to adopt`
      )
    }
    // Rekey in place. The process, pid, RingBuffer and seq counter all carry
    // over, so the hub's gap detection continues across the boundary instead of
    // restarting under a stream it is already tracking.
    // Leak diagnostics: adopting onto a session id that already has a live
    // process silently orphans that process (it keeps running, its output is
    // dropped by the identity check in onData). Should never happen — log it.
    const displaced = sessions.get(params.sessionId)
    if (displaced) {
      throw new RpcError(
        ComputerTransportErrorCodes.unknownComputer,
        `session ${params.sessionId} already has live process ${displaced.proc.pid}`
      )
    }
    sessions.delete(params.warmId)
    session.id = params.sessionId
    session.taskId = params.taskId
    delete session.warm
    session.spawnId = params.warmId
    sessions.set(params.sessionId, session)
    releaseAdmission(session)
    if (params.relay !== undefined) session.relay = params.relay
    if (params.detection) {
      attachSignals(session, params.detection)
      // What the warm output said, so the hub's mirror starts from it — read raw,
      // THEN replay-filtered in place like everything after it. Safe to rewrite: a
      // warm session never streamed, so no seq of it has reached anyone.
      session.signals?.absorb(session.buffer.toString())
      session.buffer.rewriteUnstreamed(filterBufferData)
    }
    // `getCurrentSeq()` is -1 on an empty buffer — the same "nothing seen yet"
    // sentinel the hub's gap detector starts from, so an adopt with no output
    // needs no special case.
    const data = session.buffer.toString()
    const seq = session.buffer.getCurrentSeq()
    ctx.log('warm pty adopted', {
      warmId: params.warmId,
      sessionId: params.sessionId,
      pid: session.proc.pid
    })
    return {
      pid: session.proc.pid,
      data,
      seq,
      ...(session.signals ? { detection: true as const, detected: session.signals.snapshot() } : {})
    }
  }

  async function warmKill(rawParams: unknown): Promise<{ ok: true }> {
    const params = ptyWarmKillParamsSchema.parse(rawParams)
    // A warm start still waiting for its slot never runs.
    cancelQueued(params.warmId, 'killed')
    const session = sessions.get(params.warmId)
    if (!session) return { ok: true }
    await stopPty(session)
    return { ok: true }
  }

  function warmList(): {
    warms: Array<{
      warmId: string
      cwd: string
      pid: number
      startedAt: number
    }>
  } {
    const warms: Array<{
      warmId: string
      cwd: string
      pid: number
      startedAt: number
    }> = []
    for (const [id, session] of sessions) {
      if (!session.warm) continue
      warms.push({
        warmId: id,
        cwd: session.warm.cwd,
        pid: session.proc.pid,
        startedAt: session.warm.startedAt
      })
    }
    return { warms }
  }

  async function kill(rawParams: unknown): Promise<{ ok: true }> {
    const params = ptyKillParamsSchema.parse(rawParams)
    const starting = starts.get(params.sessionId)
    if (starting && (params.spawnId === undefined || starting.spawnId === params.spawnId)) {
      starting.cancelled = true
    }
    const live = sessions.get(params.sessionId)
    const pending = queued.get(params.sessionId)
    if (pending && (params.spawnId === undefined || pending.spawnId === params.spawnId)) {
      relayBeforeStart.delete(params.sessionId)
      // Killed while waiting for its slot: it never runs, and ends exactly as a
      // killed process would — with an exit the hub's session settles on. The
      // exit goes out BEFORE the spawn's (error) reply, so the hub has already
      // closed the session when that reply lands and ignores it.
      const delivered = ctx.dialer.notify(ComputerNotificationMethods.ptyExit, {
        sessionId: params.sessionId,
        ...(pending.spawnId ? { spawnId: pending.spawnId } : {}),
        exitCode: null,
        signal: params.signal ?? 'SIGHUP',
        reason: 'killed-before-start'
      })
      tombstones.add(params.sessionId, {
        spawnId: pending.spawnId,
        exitCode: null,
        signal: params.signal ?? 'SIGHUP',
        reason: 'killed-before-start'
      })
      if (!delivered)
        ctx.log('kill of a queued start not delivered', {
          sessionId: params.sessionId
        })
      cancelQueued(params.sessionId, 'killed')
      // A generation-scoped kill cancels only that queued start. Legacy
      // session-wide kills also stop any older process still running.
      if (live && params.spawnId === undefined) await stopPty(live, params.signal)
      return { ok: true }
    }
    if (!live || (params.spawnId !== undefined && live.spawnId !== params.spawnId)) {
      // Idempotent: the session may already have exited (network race).
      ctx.log('pty kill on unknown session', { sessionId: params.sessionId })
      return { ok: true }
    }
    await stopPty(live, params.signal)
    return { ok: true }
  }

  function resize(rawParams: unknown): { ok: true } {
    const params = ptyResizeParamsSchema.parse(rawParams)
    const waiting = queued.get(params.sessionId)
    if (waiting) {
      if (params.spawnId !== undefined && waiting.spawnId !== params.spawnId) return { ok: true }
      // Starts at the size the terminal has by then.
      waiting.cols = params.cols
      waiting.rows = params.rows
      return { ok: true }
    }
    const session = sessions.get(params.sessionId)
    if (session && params.spawnId !== undefined && session.spawnId !== params.spawnId)
      return { ok: true }
    if (!session) {
      ctx.log('pty resize on unknown session', { sessionId: params.sessionId })
      return { ok: true }
    }
    session.proc.resize(params.cols, params.rows)
    session.signals?.resize(params.cols, params.rows)
    return { ok: true }
  }

  function setTheme(rawParams: unknown): { ok: true } {
    theme = ptySetThemeParamsSchema.parse(rawParams).theme
    for (const session of sessions.values()) session.signals?.setTheme(theme)
    return { ok: true }
  }

  function write(rawParams: unknown): { ok: true } {
    const params = ptyWriteParamsSchema.parse(rawParams)
    const waiting = queued.get(params.sessionId)
    if (waiting) {
      if (params.spawnId !== undefined && waiting.spawnId !== params.spawnId) return { ok: true }
      // Queued, not lost: written right after the spawn (see `QueuedSpawn`).
      waiting.writes.push(params.data)
      if (params.watchConversationId) waiting.watchConversationId = true
      return { ok: true }
    }
    const session = sessions.get(params.sessionId)
    if (session && params.spawnId !== undefined && session.spawnId !== params.spawnId)
      return { ok: true }
    if (!session) {
      ctx.log('pty write on unknown session', { sessionId: params.sessionId })
      return { ok: true }
    }
    session.proc.write(params.data)
    if (params.watchConversationId) session.signals?.watchConversationId()
    return { ok: true }
  }

  /**
   * Every live session this computer still holds, for hub reattach after a
   * dropped connection. The computer is the authority here — the hub's registry
   * is only a belief about this list, and a disconnect lets the two diverge in
   * both directions (sessions the hub gave up on that are still running;
   * sessions it still tracks that have since exited).
   *
   * Warm sessions are excluded by design: the hub holds no identity for one
   * until `pty.warmAdopt`, so offering it here would invent a session the hub
   * never had. They keep their own reconcile path.
   */
  function list(): PtyListResult {
    const live: PtyListResult['sessions'] = []
    for (const [id, session] of sessions) {
      if (session.warm) continue
      live.push({
        sessionId: id,
        ...(session.spawnId !== undefined ? { spawnId: session.spawnId } : {}),
        pid: session.proc.pid,
        // -1 on an empty buffer — the same "nothing seen yet" sentinel the hub's
        // gap detector starts from, so a session that has emitted nothing needs
        // no special case on either side.
        seq: session.buffer.getCurrentSeq(),
        ...(session.signals
          ? { detection: true as const, detected: session.signals.snapshot() }
          : {})
      })
    }
    return { sessions: live, exited: tombstones.list() }
  }

  /** The buffer for `sessionId` + attempt `spawnId`: live, else a reaped one still kept. */
  function bufferFor(sessionId: string, spawnId: string | undefined): RingBuffer | undefined {
    const live = sessions.get(sessionId)
    if (live && (spawnId === undefined || live.spawnId === spawnId)) return live.buffer
    const exited = tombstones.get(sessionId)
    if (exited && (spawnId === undefined || exited.spawnId === spawnId)) return exited.buffer
    return undefined
  }

  function replayOf(buffer: RingBuffer | undefined, afterSeq: number): BufferSinceResult {
    if (!buffer) return { chunks: [], prelude: '', currentSeq: -1 }
    const { chunks, prelude } = buffer.getReplaySince(afterSeq)
    return {
      chunks: chunks.map((c) => ({ seq: c.seq, data: c.data })),
      prelude,
      currentSeq: buffer.getCurrentSeq()
    }
  }

  /** Replay for a hub client (fresh terminal or reattach): this buffer is the only one. */
  function getReplay(rawParams: unknown): PtyGetReplayResult {
    const params = ptyGetReplayParamsSchema.parse(rawParams)
    const buffer = bufferFor(params.sessionId, params.spawnId)
    if (!buffer) return { chunks: [], prelude: '', currentSeq: -1 }
    const { chunks, prelude } = buffer.getReplaySince(params.afterSeq)
    return {
      chunks: chunks.map((c) => ({ seq: c.seq, data: c.data })),
      prelude,
      currentSeq: buffer.getCurrentSeq()
    }
  }

  /** The relay a new session starts with: a change made while it waited wins. */
  function relayAtStart(id: string, spawnId: string | undefined, requested?: boolean): boolean {
    const early = relayBeforeStart.get(id)
    relayBeforeStart.delete(id)
    if (early && (early.spawnId === undefined || early.spawnId === spawnId)) return early.on
    return requested !== false
  }

  function relay(rawParams: unknown): PtyRelayResult {
    const params = ptyRelayParamsSchema.parse(rawParams)
    const id = params.sessionId
    const matches = (spawnId: string | undefined) =>
      params.spawnId === undefined || spawnId === params.spawnId
    // Not started yet (queued for a slot, or replacing a session): remembered.
    const waiting = queued.get(id) ?? starts.get(id)
    if (waiting && matches(waiting.spawnId)) {
      relayBeforeStart.set(id, {
        ...(waiting.spawnId !== undefined ? { spawnId: waiting.spawnId } : {}),
        on: params.on
      })
    }
    const session = sessions.get(id)
    if (!session || !matches(session.spawnId)) return { seq: -1 }
    session.relay = params.on
    return { seq: session.buffer.getCurrentSeq() }
  }

  function clearBuffer(rawParams: unknown): PtyClearBufferResult {
    const params = ptyClearBufferParamsSchema.parse(rawParams)
    const buffer = bufferFor(params.sessionId, params.spawnId)
    if (!buffer) return { clearedSeq: -1 }
    const clearedSeq = buffer.getCurrentSeq()
    buffer.clear()
    return { clearedSeq }
  }

  function getBufferSince(rawParams: unknown): {
    frames: Array<{ seq: number; data: string }>
  } {
    const params = ptyGetBufferSinceParamsSchema.parse(rawParams)
    // A reaped session's output is still served when its exit never reached the
    // hub — the tail it missed while away (see exit-tombstones.ts).
    const live = sessions.get(params.sessionId)
    const exited = tombstones.get(params.sessionId)
    const buffer =
      live && (params.spawnId === undefined || live.spawnId === params.spawnId)
        ? live.buffer
        : exited && (params.spawnId === undefined || exited.spawnId === params.spawnId)
          ? exited.buffer
          : undefined
    if (!buffer) return { frames: [] }
    const frames = buffer.getChunksSince(params.seq).map((c) => ({ seq: c.seq, data: c.data }))
    return { frames }
  }

  function disposeAll(): void {
    dropQueued('computer shutting down')
    for (const [sessionId, session] of sessions) {
      endDirectWatchers(session, 'disposed')
      session.revokeCli?.()
      session.signals?.dispose()
      session.deadline?.cancel()
      releaseAdmission(session)
      try {
        session.proc.kill()
      } catch {
        // ignore
      }
      ctx.log('pty disposed on shutdown', { sessionId })
    }
    sessions.clear()
  }

  const handlers: HubMethodTable = {
    [HubToComputerMethods.ptySpawn]: spawn,
    [HubToComputerMethods.ptyKill]: kill,
    [HubToComputerMethods.ptyResize]: resize,
    [HubToComputerMethods.ptyWrite]: write,
    [HubToComputerMethods.ptySetTheme]: setTheme,
    [HubToComputerMethods.ptyGetReplay]: getReplay,
    [HubToComputerMethods.ptyClearBuffer]: clearBuffer,
    [HubToComputerMethods.ptyRelay]: relay,
    [HubToComputerMethods.ptyGetBufferSince]: getBufferSince,
    [HubToComputerMethods.ptyList]: list,
    [HubToComputerMethods.ptyPrioritize]: prioritize,
    [HubToComputerMethods.ptyBackgroundJobs]: backgroundJobs,
    [HubToComputerMethods.ptyDoctor]: doctor,
    [HubToComputerMethods.ptyWarmSpawn]: warmSpawn,
    [HubToComputerMethods.ptyWarmAdopt]: warmAdopt,
    [HubToComputerMethods.ptyWarmKill]: warmKill,
    [HubToComputerMethods.ptyWarmList]: warmList
  }

  const belongsToTask = (id: string, taskId: string, recordedTask?: string) =>
    recordedTask ? recordedTask === taskId : id === taskId || id.startsWith(taskId + ':')
  const direct: DirectPtyService = {
    attach(sessionId, afterSeq) {
      const live = sessions.get(sessionId)
      const isLive = live !== undefined && !live.warm
      const buffer = isLive ? live.buffer : tombstones.get(sessionId)?.buffer
      return {
        exists: isLive,
        size: isLive ? { cols: live.proc.cols, rows: live.proc.rows } : null,
        buffer: replayOf(buffer, afterSeq)
      }
    },
    getBufferSince(sessionId, afterSeq) {
      const live = sessions.get(sessionId)
      return replayOf(
        live && !live.warm ? live.buffer : tombstones.get(sessionId)?.buffer,
        afterSeq
      )
    },
    write(sessionId, data) {
      const session = sessions.get(sessionId)
      if (!session || session.warm) return false
      const { buffer, facts } = analyzePtyInput(
        session.directInput,
        data,
        session.signals?.sessionIdCommand() ?? DEFAULT_SESSION_ID_COMMAND
      )
      session.directInput = buffer
      session.proc.write(data)
      // What a relayed write tells this computer with `watchConversationId`.
      if (facts.statusCommand) session.signals?.watchConversationId()
      if (facts.esc || facts.submitted !== null) {
        const payload: PtyInputPayload = {
          sessionId: session.id,
          ...(session.spawnId ? { spawnId: session.spawnId } : {}),
          submitted: facts.submitted,
          esc: facts.esc,
          statusCommand: facts.statusCommand
        }
        ctx.dialer.notify(ComputerNotificationMethods.event, {
          name: PTY_INPUT_EVENT_NAME,
          payload
        })
      }
      return true
    },
    watch(sessionId, onData, onEnd) {
      const session = sessions.get(sessionId)
      if (!session || session.warm) return null
      const watcher: DirectWatcher = { onData, onEnd }
      session.directWatchers.add(watcher)
      return () => {
        session.directWatchers.delete(watcher)
      }
    }
  }

  return {
    direct,
    hasWork: () => [...sessions.values()].some((session) => !session.warm) || queued.size > 0,
    hasTaskWork: (taskId: string) =>
      [...sessions.values(), ...queued.values()].some((s) =>
        belongsToTask(s.id, taskId, s.taskId)
      ) || [...starts.entries()].some(([id, s]) => belongsToTask(id, taskId, s.taskId)),
    async stopTask(taskId) {
      const waiting = [...starts.entries()].filter(([id, s]) => belongsToTask(id, taskId, s.taskId))
      for (const [, s] of waiting) s.cancelled = true
      for (const s of [...queued.values()])
        if (belongsToTask(s.id, taskId, s.taskId)) cancelQueued(s.id, 'task-paused')
      await Promise.all(
        [...sessions.values()]
          .filter((s) => belongsToTask(s.id, taskId, s.taskId))
          .map((s) => stopPty(s))
      )
      await Promise.allSettled(waiting.map(([, s]) => s.promise))
    },
    handlers,
    disposeAll,
    dropQueued
  }
}
