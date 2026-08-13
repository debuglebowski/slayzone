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
 * @module computer/handlers/pty
 */

import {
  HubToComputerMethods,
  ptyGetBufferSinceParamsSchema,
  ptyKillParamsSchema,
  type PtyListResult,
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
import { RingBuffer } from '../ring-buffer'
import type { HandlerContext, HubMethodTable } from './types'

/** Matches the terminal domain's per-session buffer cap (750 KiB). */
const MAX_BUFFER_SIZE = 750 * 1024

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
}

export interface PtyHandlers {
  handlers: HubMethodTable
  /** Kill every live pty (called on computer shutdown). */
  disposeAll(): void
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
  getProjectPaths?: () => { get(projectId: string): { path: string } | null } | null
): PtyHandlers {
  const sessions = new Map<string, PtySession>()

  /**
   * An explicit `cwd` wins: it is either a worktree this computer created or a
   * `task.base_dir` the user set, never a hub guess about someone else's disk.
   * Otherwise resolve the project's own checkout here.
   *
   * A project with no mapping fails LOUDLY. Falling back to the computer's launch
   * directory would start the agent in the wrong tree and look like it worked,
   * which is the exact failure this whole seam removes.
   */
  function resolveCwd(opts: { cwd?: string; projectId?: string }): string {
    if (opts.cwd) return opts.cwd
    if (!opts.projectId) throw new Error('pty.spawn needs either cwd or projectId')
    const entry = getProjectPaths?.()?.get(opts.projectId)
    if (!entry) {
      throw new Error(
        `project ${opts.projectId} is not checked out on this computer — adopt a folder or enable remote git for it`
      )
    }
    return entry.path
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
    }
  ): PtySession {
    const cwd = resolveCwd(opts)
    // Replace any pre-existing session with the same id (defensive against a
    // stale session that never signalled exit).
    const existing = sessions.get(id)
    if (existing) {
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
    const session: PtySession = { proc, buffer, id, ...(opts.warm ? { warm: opts.warm } : {}) }
    sessions.set(id, session)

    proc.onData((data) => {
      // Ignore output from a session that has since been superseded/disposed.
      // `session.id` is read LIVE so a rekey (warm adopt) redirects the stream.
      if (sessions.get(session.id) !== session) return
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
      // Only the CURRENTLY-active session for this id may clear the map and
      // emit exit — a superseded/disposed pty exiting must stay silent, else it
      // would tear down the replacement and confuse the hub.
      if (sessions.get(session.id) !== session) return
      sessions.delete(session.id)
      // A warm session dying before adoption is the computer's business: the hub
      // holds no session for it. It re-warms on its own reconcile.
      if (session.warm) {
        ctx.log('warm pty exited before adoption', { warmId: session.id })
        return
      }
      ctx.dialer.notify(ComputerNotificationMethods.ptyExit, {
        sessionId: session.id,
        exitCode: typeof exitCode === 'number' ? exitCode : null,
        signal: signal != null ? String(signal) : null
      })
    })

    return session
  }

  function spawn(rawParams: unknown): { pid: number } {
    const params = ptySpawnParamsSchema.parse(rawParams)
    const session = spawnSession(params.sessionId, params)
    ctx.log('pty spawned', {
      sessionId: params.sessionId,
      pid: session.proc.pid,
      command: params.command
    })
    return { pid: session.proc.pid }
  }

  function warmSpawn(rawParams: unknown): { pid: number } {
    const params = ptyWarmSpawnParamsSchema.parse(rawParams)
    const session = spawnSession(params.warmId, {
      ...params,
      warm: { cwd: params.cwd, startedAt: Date.now() }
    })
    // Pre-boot the agent inside the warm shell. Written to stdin rather than
    // spawned directly so the shell's rc init (PATH, toolchain shims) has already
    // run — the whole point of warming.
    if (params.postSpawnCommand) session.proc.write(`${params.postSpawnCommand}\r`)
    ctx.log('warm pty spawned', { warmId: params.warmId, pid: session.proc.pid })
    return { pid: session.proc.pid }
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
    sessions.delete(params.warmId)
    session.id = params.sessionId
    delete session.warm
    sessions.set(params.sessionId, session)
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
        pid: session.proc.pid,
        // -1 on an empty buffer — the same "nothing seen yet" sentinel the hub's
        // gap detector starts from, so a session that has emitted nothing needs
        // no special case on either side.
        seq: session.buffer.getCurrentSeq()
      })
    }
    return { sessions: live }
  }

  function getBufferSince(rawParams: unknown): { frames: Array<{ seq: number; data: string }> } {
    const params = ptyGetBufferSinceParamsSchema.parse(rawParams)
    const session = sessions.get(params.sessionId)
    if (!session) return { frames: [] }
    const frames = session.buffer
      .getChunksSince(params.seq)
      .map((c) => ({ seq: c.seq, data: c.data }))
    return { frames }
  }

  function disposeAll(): void {
    for (const [sessionId, session] of sessions) {
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
    [HubToComputerMethods.ptyWarmSpawn]: warmSpawn,
    [HubToComputerMethods.ptyWarmAdopt]: warmAdopt,
    [HubToComputerMethods.ptyWarmKill]: warmKill,
    [HubToComputerMethods.ptyWarmList]: warmList
  }

  return { handlers, disposeAll }
}
