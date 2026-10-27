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
  ptyGetBufferSinceParamsSchema,
  ptyKillParamsSchema,
  type PtyListResult,
  ptyPrioritizeParamsSchema,
  type PtySpawnParams,
  type PtyWarmSpawnParams,
  ptyResizeParamsSchema,
  ptySpawnParamsSchema,
  ptyWarmAdoptParamsSchema,
  ptyWarmKillParamsSchema,
  ptyWarmSpawnParamsSchema,
  ptyWriteParamsSchema,
  RpcError,
  ComputerNotificationMethods,
  ComputerTransportErrorCodes
} from '@slayzone/computer-transport/shared'
import * as pty from 'node-pty'
import { sanitizeSpawnEnv } from '@slayzone/platform/env-manifest'
import { armStartupDeadline, type StartupDeadline } from '@slayzone/platform/startup-deadline'
import { spawnCwd } from '../config'
import { ExitTombstones } from '../exit-tombstones'
import { RingBuffer } from '../ring-buffer'
import {
  createSpawnAdmission,
  type AdmissionLane,
  type AdmissionSlot,
  type AdmissionTicket,
  type SpawnAdmission
} from '../spawn-admission'
import type { HandlerContext, HubMethodTable } from './types'

/** Matches the terminal domain's per-session buffer cap (750 KiB). */
const MAX_BUFFER_SIZE = 750 * 1024

/**
 * After a startup-timeout SIGKILL, how long to wait for node-pty's own exit before
 * reaping the session here — so a process whose exit is never reported cannot sit
 * in `pty.list` as live forever. The same net the hub used to run.
 */
const STARTUP_KILL_REAP_MS = 2_000

interface PtySession {
  proc: pty.IPty
  buffer: RingBuffer
  /**
   * The key this session is currently filed under, read by its own onData/onExit.
   *
   * MUTABLE and read live, not captured: `pty.warmAdopt` promotes a warm session
   * by rekeying it (`warmId` → real `sessionId`) so the process, pid, buffer and
   * seq counter all survive. Closures that had captured the spawn-time id would
   * keep emitting under the dead `warmId` after that swap.
   */
  id: string
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
  spawnId?: string
  ticket: AdmissionTicket
  cols?: number
  rows?: number
  writes: string[]
  /** Starts the process once admitted; returns the reply. */
  run: (slot: AdmissionSlot) => unknown
  promise: Promise<unknown>
  resolve: (value: unknown) => void
  reject: (err: unknown) => void
}

export interface PtyHandlers {
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
  /**
   * Agent-start admission queue. Production passes ONE instance shared by every
   * hub connection (the contention is the machine's); absent, this handler set
   * gets a private one.
   */
  admission?: SpawnAdmission
}

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
  getProjectPaths?: () => { get(projectId: string): { path: string } | null } | null,
  options: PtyHandlerOptions = {}
): PtyHandlers {
  const sessions = new Map<string, PtySession>()
  const tombstones = new ExitTombstones()
  const admission = options.admission ?? createSpawnAdmission()
  /** Spawns waiting for an agent-start slot, keyed like `sessions`. */
  const queued = new Map<string, QueuedSpawn>()

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
    if (!entry) {
      throw new Error(
        `project ${opts.projectId} is not checked out on this computer — adopt a folder or enable remote git for it`
      )
    }
    return spawnCwd(entry.path, ctx.config.allowedRoots)
  }

  function buildEnv(overrides?: Record<string, string>): Record<string, string> {
    // Base channel: the computer inherits its parent (supervisor) process.env, so
    // sanitize it through the shared manifest — keep the user env (PATH/HOME/
    // toolchains) but strip every SlayZone infra/secret/identity var (and any
    // unmanifested SLAYZONE_*, fail closed) so nothing the computer was configured
    // with leaks into a spawned agent, which would reinterpret it. The hub's
    // per-spawn `overrides` (the identity overlay) apply AFTER and are the
    // authoritative source for anything an agent legitimately needs.
    const merged: Record<string, string> = overrides
      ? { ...sanitizeSpawnEnv(process.env), ...overrides }
      : sanitizeSpawnEnv(process.env)
    // Override channel: force the agent's lifecycle hook to the computer's OWN
    // loopback relay (which forwards to the hub over the authed ws channel), and
    // strip any hub bearer the hub baked into `overrides` — no per-agent token in
    // subprocess env, and the agent env is byte-identical to a local spawn's hook
    // wiring. Distinct from the base sanitize above: this guards a token the HUB
    // passed in, which sanitizeSpawnEnv (base-only) never sees.
    if (ctx.agentHookUrl) {
      merged.SLAYZONE_AGENT_HOOK_URL = ctx.agentHookUrl
      delete merged.SLAYZONE_HUB_TOKEN
    }
    return merged
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
    }
  ): PtySession {
    const cwd = resolveCwd(opts)
    // Replace any pre-existing session with the same id (defensive against a
    // stale session that never signalled exit).
    const existing = sessions.get(id)
    if (existing) {
      existing.deadline?.cancel()
      releaseAdmission(existing)
      try {
        existing.proc.kill()
      } catch {
        // Already dead — ignore.
      }
      sessions.delete(id)
    }

    const proc = pty.spawn(opts.command, opts.args ?? [], {
      name: 'xterm-color',
      cwd,
      env: buildEnv(opts.env),
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24
    })

    const buffer = new RingBuffer(MAX_BUFFER_SIZE)
    const session: PtySession = {
      proc,
      buffer,
      id,
      ...(opts.warm ? { warm: opts.warm } : {}),
      ...(opts.spawnId !== undefined ? { spawnId: opts.spawnId } : {})
    }
    sessions.set(id, session)
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
      // result — and a filter that holds a torn escape tail diverges by
      // construction (`two` vs `two ESC [ ? 6`), losing bytes in one interleaving
      // and stranding a half-sequence in the other.
      //
      // So device-status filtering does NOT belong here. It belongs where the
      // stream is consumed, and it already lives there: every remote frame —
      // live or backfilled — re-enters the hub's own pty onData
      // (`attachPtyHandlers` wraps remote handles too), which answers what it
      // answers via `interceptSyncQueries` and strips cursor-status queries via
      // `filterBufferData` before anything is buffered or rendered. Stripping on
      // the computer would only risk starving a remote program of an answer the hub
      // would otherwise have given it.
      const seq = buffer.append(data)
      // A WARM session buffers but does not stream: the hub has no session to
      // route it to yet, and `pty.warmAdopt` hands the whole buffer over at
      // adopt. Emitting under a `warmId` the hub never registered would be
      // dropped anyway — and would burn a seq the adopt handover then replays.
      if (session.warm) return
      ctx.dialer.notify(ComputerNotificationMethods.ptyData, {
        sessionId: session.id,
        seq,
        data
      })
    })

    proc.onExit(({ exitCode, signal }) => {
      reap(
        session,
        typeof exitCode === 'number' ? exitCode : null,
        signal != null ? String(signal) : null
      )
    })

    return session
  }

  /** Report a session's exit and remember it. Idempotent per session object. */
  function reap(session: PtySession, exitCode: number | null, signal: string | null): void {
    // Only the CURRENTLY-active session for this id may clear the map and
    // emit exit — a superseded/disposed pty exiting must stay silent, else it
    // would tear down the replacement and confuse the hub.
    if (sessions.get(session.id) !== session) return
    sessions.delete(session.id)
    session.deadline?.cancel()
    releaseAdmission(session)
    // A warm session dying before adoption is the computer's business: the hub
    // holds no session for it. It re-warms on its own reconcile.
    if (session.warm) {
      ctx.log('warm pty exited before adoption', { warmId: session.id })
      return
    }
    const reason = session.exitReason
    const delivered = ctx.dialer.notify(ComputerNotificationMethods.ptyExit, {
      sessionId: session.id,
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
      // The hub never got this exit, so it may be missing output too.
      ...(delivered ? {} : { buffer: session.buffer })
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

  type SpawnReply = { pid: number; startupDeadline?: true }

  function startSession(params: PtySpawnParams): SpawnReply {
    const session = spawnSession(params.sessionId, params)
    ctx.log('pty spawned', {
      sessionId: params.sessionId,
      pid: session.proc.pid,
      command: params.command
    })
    return {
      pid: session.proc.pid,
      ...(session.deadline ? { startupDeadline: true as const } : {})
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
    spec: { spawnId?: string; cols?: number; rows?: number },
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
      item.resolve(reply)
    })
    return promise
  }

  function spawn(rawParams: unknown): SpawnReply | Promise<unknown> {
    const params = ptySpawnParamsSchema.parse(rawParams)
    if (params.spawnId !== undefined) {
      const live = sessions.get(params.sessionId)
      if (live && !live.warm && live.spawnId === params.spawnId) {
        // The hub re-sent an attempt whose reply it lost. This process IS that
        // attempt — answer with it rather than killing it to start a twin.
        return { pid: live.proc.pid, ...(live.deadline ? { startupDeadline: true as const } : {}) }
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
      const reply = startSession(params)
      if (prior) {
        queued.delete(params.sessionId)
        admission.cancel(prior.ticket)
        prior.resolve(reply)
      }
      return reply
    }
    return enqueueSpawn(params.sessionId, params.admission, params, (slot, item) => {
      const reply = startSession({
        ...params,
        ...(item.cols !== undefined ? { cols: item.cols } : {}),
        ...(item.rows !== undefined ? { rows: item.rows } : {})
      })
      const session = sessions.get(params.sessionId)!
      session.admissionSlot = slot
      // Input the hub sent while this waited, in order — where it would have
      // landed had the spawn been immediate.
      for (const data of item.writes) session.proc.write(data)
      return reply
    })
  }

  function startWarm(params: PtyWarmSpawnParams, cols?: number, rows?: number): PtySession {
    const session = spawnSession(params.warmId, {
      ...params,
      ...(cols !== undefined ? { cols } : {}),
      ...(rows !== undefined ? { rows } : {}),
      warm: { cwd: params.cwd, startedAt: Date.now() }
    })
    // Pre-boot the agent inside the warm shell. Written to stdin rather than
    // spawned directly so the shell's rc init (PATH, toolchain shims) has already
    // run — the whole point of warming.
    if (params.postSpawnCommand) session.proc.write(`${params.postSpawnCommand}\r`)
    ctx.log('warm pty spawned', { warmId: params.warmId, pid: session.proc.pid })
    return session
  }

  /**
   * A warm agent is an agent start like any other, so it goes through admission —
   * in the `warm` lane, which waits until no task's agent is starting. The pool is
   * a speed-up for the next task; it must never slow down the ones being opened.
   */
  function warmSpawn(rawParams: unknown): Promise<unknown> {
    const params = ptyWarmSpawnParamsSchema.parse(rawParams)
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
    return { ok: true, queued: item ? admission.prioritize(item.ticket) : false }
  }

  function dropQueued(reason: string): void {
    for (const id of [...queued.keys()]) cancelQueued(id, reason)
  }

  function warmAdopt(rawParams: unknown): { pid: number; data: string; seq: number } {
    const params = ptyWarmAdoptParamsSchema.parse(rawParams)
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
      ctx.log('warm adopt displaced a live session', {
        warmId: params.warmId,
        sessionId: params.sessionId,
        displacedPid: displaced.proc.pid,
        displacedWarm: !!displaced.warm
      })
    }
    sessions.delete(params.warmId)
    session.id = params.sessionId
    delete session.warm
    sessions.set(params.sessionId, session)
    releaseAdmission(session)
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
    return { pid: session.proc.pid, data, seq }
  }

  function warmKill(rawParams: unknown): { ok: true } {
    const params = ptyWarmKillParamsSchema.parse(rawParams)
    // A warm start still waiting for its slot never runs.
    cancelQueued(params.warmId, 'killed')
    const session = sessions.get(params.warmId)
    if (!session) return { ok: true }
    sessions.delete(params.warmId)
    try {
      session.proc.kill()
    } catch {
      // Already dead — ignore.
    }
    return { ok: true }
  }

  function warmList(): {
    warms: Array<{ warmId: string; cwd: string; pid: number; startedAt: number }>
  } {
    const warms: Array<{ warmId: string; cwd: string; pid: number; startedAt: number }> = []
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

  function kill(rawParams: unknown): { ok: true } {
    const params = ptyKillParamsSchema.parse(rawParams)
    const waiting = queued.get(params.sessionId)
    if (waiting) {
      // Killed while waiting for its slot: it never runs, and ends exactly as a
      // killed process would — with an exit the hub's session settles on. The
      // exit goes out BEFORE the spawn's (error) reply, so the hub has already
      // closed the session when that reply lands and ignores it.
      const delivered = ctx.dialer.notify(ComputerNotificationMethods.ptyExit, {
        sessionId: params.sessionId,
        exitCode: null,
        signal: params.signal ?? 'SIGHUP',
        reason: 'killed-before-start'
      })
      tombstones.add(params.sessionId, {
        spawnId: waiting.spawnId,
        exitCode: null,
        signal: params.signal ?? 'SIGHUP',
        reason: 'killed-before-start'
      })
      if (!delivered)
        ctx.log('kill of a queued start not delivered', { sessionId: params.sessionId })
      cancelQueued(params.sessionId, 'killed')
      // An older process still filed under this id was due to be replaced by the
      // queued start; end it silently, as that replacement would have.
      const superseded = sessions.get(params.sessionId)
      if (superseded) {
        sessions.delete(params.sessionId)
        superseded.deadline?.cancel()
        releaseAdmission(superseded)
        try {
          superseded.proc.kill(params.signal)
        } catch {
          // Already dead — ignore.
        }
      }
      return { ok: true }
    }
    const session = sessions.get(params.sessionId)
    if (!session) {
      // Idempotent: the session may already have exited (network race).
      ctx.log('pty kill on unknown session', { sessionId: params.sessionId })
      return { ok: true }
    }
    try {
      session.proc.kill(params.signal)
    } catch (err) {
      ctx.log('pty kill failed', { sessionId: params.sessionId, error: String(err) })
    }
    return { ok: true }
  }

  function resize(rawParams: unknown): { ok: true } {
    const params = ptyResizeParamsSchema.parse(rawParams)
    const waiting = queued.get(params.sessionId)
    if (waiting) {
      // Starts at the size the terminal has by then.
      waiting.cols = params.cols
      waiting.rows = params.rows
      return { ok: true }
    }
    const session = sessions.get(params.sessionId)
    if (!session) {
      ctx.log('pty resize on unknown session', { sessionId: params.sessionId })
      return { ok: true }
    }
    session.proc.resize(params.cols, params.rows)
    return { ok: true }
  }

  function write(rawParams: unknown): { ok: true } {
    const params = ptyWriteParamsSchema.parse(rawParams)
    const waiting = queued.get(params.sessionId)
    if (waiting) {
      // Queued, not lost: written right after the spawn (see `QueuedSpawn`).
      waiting.writes.push(params.data)
      return { ok: true }
    }
    const session = sessions.get(params.sessionId)
    if (!session) {
      ctx.log('pty write on unknown session', { sessionId: params.sessionId })
      return { ok: true }
    }
    session.proc.write(params.data)
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
        seq: session.buffer.getCurrentSeq()
      })
    }
    return { sessions: live, exited: tombstones.list() }
  }

  function getBufferSince(rawParams: unknown): { frames: Array<{ seq: number; data: string }> } {
    const params = ptyGetBufferSinceParamsSchema.parse(rawParams)
    // A reaped session's output is still served when its exit never reached the
    // hub — the tail it missed while away (see exit-tombstones.ts).
    const buffer =
      sessions.get(params.sessionId)?.buffer ?? tombstones.get(params.sessionId)?.buffer
    if (!buffer) return { frames: [] }
    const frames = buffer.getChunksSince(params.seq).map((c) => ({ seq: c.seq, data: c.data }))
    return { frames }
  }

  function disposeAll(): void {
    dropQueued('computer shutting down')
    for (const [sessionId, session] of sessions) {
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
    [HubToComputerMethods.ptyGetBufferSince]: getBufferSince,
    [HubToComputerMethods.ptyList]: list,
    [HubToComputerMethods.ptyPrioritize]: prioritize,
    [HubToComputerMethods.ptyWarmSpawn]: warmSpawn,
    [HubToComputerMethods.ptyWarmAdopt]: warmAdopt,
    [HubToComputerMethods.ptyWarmKill]: warmKill,
    [HubToComputerMethods.ptyWarmList]: warmList
  }

  return { handlers, disposeAll, dropQueued }
}
