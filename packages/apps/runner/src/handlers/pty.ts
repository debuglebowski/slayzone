/**
 * Runner-side pty exec handlers. Spawns node-pty processes on the runner
 * machine and streams their output back to the hub as `pty.data` notifications,
 * each carrying a MONOTONIC per-session sequence number (assigned by a
 * per-session {@link RingBuffer}). The hub detects gaps and replays them via
 * `pty.getBufferSince`; on process exit the runner emits `pty.exit`.
 *
 * This mirrors the terminal domain's pty-manager seq/buffer semantics, scoped
 * down to the exec surface the runner protocol exposes.
 *
 * @module runner/handlers/pty
 */

import {
  HubToRunnerMethods,
  ptyGetBufferSinceParamsSchema,
  ptyKillParamsSchema,
  ptyResizeParamsSchema,
  ptySpawnParamsSchema,
  ptyWriteParamsSchema,
  RunnerNotificationMethods
} from '@slayzone/runner-transport/shared'
import * as pty from 'node-pty'
import { RingBuffer } from '../ring-buffer'
import type { HandlerContext, HubMethodTable } from './types'

/** Matches the terminal domain's per-session buffer cap (750 KiB). */
const MAX_BUFFER_SIZE = 750 * 1024

interface PtySession {
  proc: pty.IPty
  buffer: RingBuffer
}

export interface PtyHandlers {
  handlers: HubMethodTable
  /** Kill every live pty (called on runner shutdown). */
  disposeAll(): void
}

/**
 * Build the pty handler table. Sessions are tracked in a Map keyed by
 * `sessionId` and cleaned up on process exit.
 */
export function createPtyHandlers(ctx: HandlerContext): PtyHandlers {
  const sessions = new Map<string, PtySession>()

  function buildEnv(overrides?: Record<string, string>): Record<string, string> {
    // Start from the runner's own environment so PATH/HOME/etc. are present,
    // then let the hub override specific keys.
    const base: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') base[k] = v
    }
    const merged = overrides ? { ...base, ...overrides } : base
    // Hub/runner split: force the agent's lifecycle hook to the runner's OWN
    // loopback relay (which forwards to the hub over the authed ws channel), and
    // strip any hub bearer the hub baked in — no per-agent token in subprocess
    // env, and the agent env is byte-identical to a local spawn's hook wiring.
    if (ctx.agentHookUrl) {
      merged.SLAYZONE_AGENT_HOOK_URL = ctx.agentHookUrl
      delete merged.SLAYZONE_HUB_TOKEN
    }
    return merged
  }

  function spawn(rawParams: unknown): { pid: number } {
    const params = ptySpawnParamsSchema.parse(rawParams)

    // Replace any pre-existing session with the same id (defensive against a
    // stale session that never signalled exit).
    const existing = sessions.get(params.sessionId)
    if (existing) {
      try {
        existing.proc.kill()
      } catch {
        // Already dead — ignore.
      }
      sessions.delete(params.sessionId)
    }

    const proc = pty.spawn(params.command, params.args ?? [], {
      name: 'xterm-color',
      cwd: params.cwd,
      env: buildEnv(params.env),
      cols: params.cols ?? 80,
      rows: params.rows ?? 24
    })

    const buffer = new RingBuffer(MAX_BUFFER_SIZE)
    const session: PtySession = { proc, buffer }
    sessions.set(params.sessionId, session)

    proc.onData((data) => {
      // Ignore output from a session that has since been superseded/disposed.
      if (sessions.get(params.sessionId) !== session) return
      const seq = buffer.append(data)
      ctx.dialer.notify(RunnerNotificationMethods.ptyData, {
        sessionId: params.sessionId,
        seq,
        data
      })
    })

    proc.onExit(({ exitCode, signal }) => {
      // Only the CURRENTLY-active session for this id may clear the map and
      // emit exit — a superseded/disposed pty exiting must stay silent, else it
      // would tear down the replacement and confuse the hub.
      if (sessions.get(params.sessionId) !== session) return
      sessions.delete(params.sessionId)
      ctx.dialer.notify(RunnerNotificationMethods.ptyExit, {
        sessionId: params.sessionId,
        exitCode: typeof exitCode === 'number' ? exitCode : null,
        signal: signal != null ? String(signal) : null
      })
    })

    ctx.log('pty spawned', { sessionId: params.sessionId, pid: proc.pid, command: params.command })
    return { pid: proc.pid }
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

  function getBufferSince(rawParams: unknown): { frames: Array<{ seq: number; data: string }> } {
    const params = ptyGetBufferSinceParamsSchema.parse(rawParams)
    const session = sessions.get(params.sessionId)
    if (!session) return { frames: [] }
    const frames = session.buffer.getChunksSince(params.seq).map((c) => ({ seq: c.seq, data: c.data }))
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
    [HubToRunnerMethods.ptySpawn]: spawn,
    [HubToRunnerMethods.ptyKill]: kill,
    [HubToRunnerMethods.ptyResize]: resize,
    [HubToRunnerMethods.ptyWrite]: write,
    [HubToRunnerMethods.ptyGetBufferSince]: getBufferSince
  }

  return { handlers, disposeAll }
}
