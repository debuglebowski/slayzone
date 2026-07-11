/**
 * Runner-side child-process exec handlers. Spawns non-pty background processes
 * on the runner and streams their stdout/stderr back to the hub as `proc.data`
 * notifications, emitting `proc.exit` on completion. Processes are tracked in a
 * Map keyed by the hub-assigned `id` and cleaned up on exit.
 *
 * The proc.* frame method/notification names + param shapes are OWNED by the
 * parallel Wave2-A2 unit and are not yet in `@slayzone/fleet/shared`; the names
 * and schemas below MIRROR the agreed contract and a later integration
 * reconciles them.
 *
 * The working directory (`cwd`), when supplied, passes the
 * {@link assertPathAllowed} containment guard. The command binary itself is NOT
 * root-constrained (it typically lives in /usr/bin etc.); containment is
 * enforced on the directory the process runs in.
 *
 * @module runner/handlers/proc
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { z } from 'zod'
import { assertPathAllowed } from '../config'
import type { HandlerContext, HubMethodTable } from './types'

/** proc.* method names. Mirrors the Wave2-A2 frame contract. */
export const ProcMethods = {
  procSpawn: 'proc.spawn',
  procKill: 'proc.kill'
} as const

/** proc.* notification names streamed via `dialer.notify`. */
export const ProcNotifications = {
  procData: 'proc.data',
  procExit: 'proc.exit'
} as const

const procSpawnParams = z.object({
  id: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional()
})
const procKillParams = z.object({
  id: z.string().min(1),
  signal: z.string().optional()
})

export interface ProcHandlers {
  handlers: HubMethodTable
  /** Kill every live process (called on runner shutdown). */
  disposeAll(): void
}

export function createProcHandlers(ctx: HandlerContext): ProcHandlers {
  const procs = new Map<string, ChildProcess>()

  function buildEnv(overrides?: Record<string, string>): Record<string, string> {
    const base: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') base[k] = v
    }
    return overrides ? { ...base, ...overrides } : base
  }

  function procSpawn(rawParams: unknown): { pid: number | null } {
    const params = procSpawnParams.parse(rawParams)
    const cwd = params.cwd ? assertPathAllowed(params.cwd, ctx.config.allowedRoots) : undefined

    // Replace any pre-existing process with the same id.
    const existing = procs.get(params.id)
    if (existing) {
      try {
        existing.kill()
      } catch {
        // ignore
      }
      procs.delete(params.id)
    }

    const child = spawn(params.command, params.args ?? [], {
      ...(cwd ? { cwd } : {}),
      env: buildEnv(params.env),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    procs.set(params.id, child)

    // Emit proc.exit at most once, and only for the CURRENTLY-tracked process
    // for this id. This dedupes the error+close double-fire on a failed spawn
    // (ENOENT emits both) and prevents a superseded process from tearing down
    // its replacement.
    const settle = (payload: Record<string, unknown>): void => {
      if (procs.get(params.id) !== child) return
      procs.delete(params.id)
      ctx.dialer.notify(ProcNotifications.procExit, { id: params.id, ...payload })
    }

    child.stdout?.on('data', (d: Buffer) => {
      if (procs.get(params.id) !== child) return
      ctx.dialer.notify(ProcNotifications.procData, {
        id: params.id,
        stream: 'stdout',
        data: d.toString()
      })
    })
    child.stderr?.on('data', (d: Buffer) => {
      if (procs.get(params.id) !== child) return
      ctx.dialer.notify(ProcNotifications.procData, {
        id: params.id,
        stream: 'stderr',
        data: d.toString()
      })
    })
    child.on('close', (code, signal) => {
      settle({
        exitCode: typeof code === 'number' ? code : null,
        signal: signal != null ? String(signal) : null
      })
    })
    child.on('error', (err) => {
      settle({ exitCode: null, signal: null, error: err.message })
    })

    ctx.log('proc spawned', { id: params.id, pid: child.pid, command: params.command })
    return { pid: child.pid ?? null }
  }

  function procKill(rawParams: unknown): { ok: true } {
    const params = procKillParams.parse(rawParams)
    const child = procs.get(params.id)
    if (!child) {
      ctx.log('proc kill on unknown id', { id: params.id })
      return { ok: true }
    }
    try {
      child.kill((params.signal as NodeJS.Signals | undefined) ?? 'SIGTERM')
    } catch (err) {
      ctx.log('proc kill failed', { id: params.id, error: String(err) })
    }
    return { ok: true }
  }

  function disposeAll(): void {
    for (const [id, child] of procs) {
      try {
        child.kill()
      } catch {
        // ignore
      }
      ctx.log('proc disposed on shutdown', { id })
    }
    procs.clear()
  }

  const handlers: HubMethodTable = {
    [ProcMethods.procSpawn]: procSpawn,
    [ProcMethods.procKill]: procKill
  }

  return { handlers, disposeAll }
}
