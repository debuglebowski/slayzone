/**
 * Runner-side child-process exec handlers. Spawns non-pty processes on the runner
 * and streams their stdout/stderr back to the hub as `proc.data` notifications,
 * emitting `proc.exit` on completion. Sessions are tracked in a Map keyed by the
 * hub-assigned `sessionId` and cleaned up on exit.
 *
 * The frame contract is the SHARED one (`@slayzone/runner-transport/shared`) —
 * imported, not mirrored. It used to be re-declared locally with `id` as the key
 * while the hub sent `sessionId`, so every routed `proc.spawn` threw a zod error
 * and every `proc.data` notification was dropped on validation. That went
 * unnoticed because `ProcSpawnSpec.runnerId` was hardcoded null, so the routing
 * backend always fell through to a local spawn. Importing the schemas makes that
 * divergence unrepresentable.
 *
 * stdout is SEQUENCED through a per-session {@link RingBuffer} (same as
 * `handlers/pty.ts`): the hub detects gaps and replays via
 * `proc.getBufferSince`. Required because a routed chat agent's stdout is an
 * NDJSON protocol stream — one dropped or reordered chunk desynchronizes the
 * driver. stderr is diagnostic and streamed unsequenced.
 *
 * stdin is PIPED and writable via `proc.write`, which is what makes this channel
 * usable by a bidirectional agent protocol at all.
 *
 * The working directory (`cwd`), when supplied, passes the
 * {@link assertPathAllowed} containment guard. The command binary itself is NOT
 * root-constrained (it typically lives in /usr/bin etc.); containment is
 * enforced on the directory the process runs in.
 *
 * @module runner/handlers/proc
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { buildShellInvocation } from '@slayzone/platform'
import { sanitizeSpawnEnv } from '@slayzone/platform/env-manifest'
import {
  HubToRunnerMethods,
  procGetBufferSinceParamsSchema,
  procKillParamsSchema,
  procSpawnParamsSchema,
  procWriteParamsSchema,
  RunnerNotificationMethods
} from '@slayzone/runner-transport/shared'
import { assertPathAllowed } from '../config'
import { RingBuffer } from '../ring-buffer'
import type { HandlerContext, HubMethodTable } from './types'

/** Matches the pty handler's per-session buffer cap (750 KiB). */
const MAX_BUFFER_SIZE = 750 * 1024

/** Re-exported for tests + main.ts wiring. Values come from the shared contract. */
export const ProcMethods = {
  procSpawn: HubToRunnerMethods.procSpawn,
  procKill: HubToRunnerMethods.procKill,
  procWrite: HubToRunnerMethods.procWrite,
  procGetBufferSince: HubToRunnerMethods.procGetBufferSince
} as const

export const ProcNotifications = {
  procData: RunnerNotificationMethods.procData,
  procExit: RunnerNotificationMethods.procExit
} as const

interface ProcSession {
  child: ChildProcess
  /** stdout only — the replayable stream. */
  buffer: RingBuffer
}

export interface ProcHandlers {
  handlers: HubMethodTable
  /** Kill every live process (called on runner shutdown). */
  disposeAll(): void
}

export function createProcHandlers(ctx: HandlerContext): ProcHandlers {
  const procs = new Map<string, ProcSession>()

  function buildEnv(overrides?: Record<string, string>): Record<string, string> {
    // Sanitize the inherited runner env through the shared manifest: keep the
    // user env (PATH/HOME) but strip every SlayZone infra/secret/identity var
    // (and any unmanifested SLAYZONE_*, fail closed) so a runner-hosted process
    // never inherits the runner's own creds/wiring. Hub-passed `overrides` layer
    // on top as the authoritative per-spawn values.
    const merged: Record<string, string> = overrides
      ? { ...sanitizeSpawnEnv(process.env), ...overrides }
      : sanitizeSpawnEnv(process.env)
    // Same override channel as handlers/pty.ts: force the agent's lifecycle hook
    // to the runner's OWN loopback relay (which forwards to the hub over the
    // authed ws channel) and strip any hub bearer the hub baked into `overrides`.
    // Without this a runner-hosted CHAT agent would post its hooks at a hub URL
    // that does not resolve from this machine — no spinner, no unread dot — and
    // could carry a hub token into a subprocess env.
    if (ctx.agentHookUrl) {
      merged.SLAYZONE_AGENT_HOOK_URL = ctx.agentHookUrl
      delete merged.SLAYZONE_HUB_TOKEN
    }
    return merged
  }

  function procSpawn(rawParams: unknown): { pid: number | null } {
    const params = procSpawnParamsSchema.parse(rawParams)
    const cwd = params.cwd ? assertPathAllowed(params.cwd, ctx.config.allowedRoots) : undefined

    // Replace any pre-existing process with the same sessionId.
    const existing = procs.get(params.sessionId)
    if (existing) {
      try {
        existing.child.kill()
      } catch {
        // ignore
      }
      procs.delete(params.sessionId)
    }

    // Shell wrapping is OPT-IN per spawn (`params.shell`), resolved with THIS
    // machine's shell — the hub's `$SHELL` may not exist here. A process-domain
    // spawn sets it (its command is a shell string like `pnpm dev`); an agent
    // spawn does not, so its resolved binary + argv reach execve untouched and a
    // missing binary still reports ENOENT via `error` (null exitCode + message)
    // rather than being flattened to a shell's exit 127.
    const invocation = params.shell
      ? buildShellInvocation(params.command)
      : { file: params.command, args: params.args ?? [] }
    const child = spawn(invocation.file, invocation.args, {
      ...(cwd ? { cwd } : {}),
      env: buildEnv(params.env),
      // stdin PIPED (was 'ignore') so `proc.write` can reach the child.
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const buffer = new RingBuffer(MAX_BUFFER_SIZE)
    const session: ProcSession = { child, buffer }
    procs.set(params.sessionId, session)

    // Emit proc.exit at most once, and only for the CURRENTLY-tracked process
    // for this sessionId. This dedupes the error+close double-fire on a failed
    // spawn (ENOENT emits both) and prevents a superseded process from tearing
    // down its replacement.
    const settle = (payload: Record<string, unknown>): void => {
      if (procs.get(params.sessionId) !== session) return
      procs.delete(params.sessionId)
      ctx.dialer.notify(ProcNotifications.procExit, { sessionId: params.sessionId, ...payload })
    }

    child.stdout?.on('data', (d: Buffer) => {
      if (procs.get(params.sessionId) !== session) return
      const data = d.toString()
      // Buffer + stream the SAME bytes under the same seq: the hub's demux keeps
      // whichever copy of a seq arrives first (live or backfilled) and emits it
      // once, so any per-seq divergence would make output depend on timing.
      const seq = buffer.append(data)
      ctx.dialer.notify(ProcNotifications.procData, {
        sessionId: params.sessionId,
        seq,
        stream: 'stdout',
        data
      })
    })
    child.stderr?.on('data', (d: Buffer) => {
      if (procs.get(params.sessionId) !== session) return
      // Unsequenced: stderr is diagnostic, never protocol, and is not replayable.
      ctx.dialer.notify(ProcNotifications.procData, {
        sessionId: params.sessionId,
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

    ctx.log('proc spawned', {
      sessionId: params.sessionId,
      pid: child.pid,
      command: params.command
    })
    return { pid: child.pid ?? null }
  }

  function procKill(rawParams: unknown): { ok: true } {
    const params = procKillParamsSchema.parse(rawParams)
    const session = procs.get(params.sessionId)
    if (!session) {
      // Idempotent: the process may already have exited (network race).
      ctx.log('proc kill on unknown session', { sessionId: params.sessionId })
      return { ok: true }
    }
    try {
      session.child.kill((params.signal as NodeJS.Signals | undefined) ?? 'SIGTERM')
    } catch (err) {
      ctx.log('proc kill failed', { sessionId: params.sessionId, error: String(err) })
    }
    return { ok: true }
  }

  function procWrite(rawParams: unknown): { ok: true } {
    const params = procWriteParamsSchema.parse(rawParams)
    const session = procs.get(params.sessionId)
    if (!session) {
      ctx.log('proc write on unknown session', { sessionId: params.sessionId })
      return { ok: true }
    }
    try {
      session.child.stdin?.write(params.data)
    } catch (err) {
      // A dead pipe surfaces via `close`/`error` → proc.exit; nothing to add here.
      ctx.log('proc write failed', { sessionId: params.sessionId, error: String(err) })
    }
    return { ok: true }
  }

  function procGetBufferSince(rawParams: unknown): {
    frames: Array<{ seq: number; data: string }>
  } {
    const params = procGetBufferSinceParamsSchema.parse(rawParams)
    const session = procs.get(params.sessionId)
    if (!session) return { frames: [] }
    const frames = session.buffer
      .getChunksSince(params.seq)
      .map((c) => ({ seq: c.seq, data: c.data }))
    return { frames }
  }

  function disposeAll(): void {
    for (const [sessionId, session] of procs) {
      try {
        session.child.kill()
      } catch {
        // ignore
      }
      ctx.log('proc disposed on shutdown', { sessionId })
    }
    procs.clear()
  }

  const handlers: HubMethodTable = {
    [ProcMethods.procSpawn]: procSpawn,
    [ProcMethods.procKill]: procKill,
    [ProcMethods.procWrite]: procWrite,
    [ProcMethods.procGetBufferSince]: procGetBufferSince
  }

  return { handlers, disposeAll }
}
