/**
 * Computer-side child-process exec handlers. Spawns non-pty processes on the computer
 * and streams their stdout/stderr back to the hub as `proc.data` notifications,
 * emitting `proc.exit` on completion. Sessions are tracked in a Map keyed by the
 * hub-assigned `sessionId` and cleaned up on exit.
 *
 * The frame contract is the SHARED one (`@slayzone/computer-transport/shared`) —
 * imported, not mirrored. It used to be re-declared locally with `id` as the key
 * while the hub sent `sessionId`, so every routed `proc.spawn` threw a zod error
 * and every `proc.data` notification was dropped on validation. That went
 * unnoticed because `ProcSpawnSpec.computerId` was hardcoded null, so the routing
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
 * Same lifecycle rules as `handlers/pty.ts`: a repeat of the same spawn attempt
 * (`spawnId`) returns the running process, and exits are remembered as tombstones
 * that `proc.list` reports — see `exit-tombstones.ts`.
 *
 * The working directory always lies inside `allowedRoots` (T-27, {@link spawnCwd}):
 * a supplied one passes the containment guard, an absent one becomes the first
 * allowed root. The command binary itself is NOT root-constrained (it typically
 * lives in /usr/bin etc.); containment is enforced on the directory the process
 * starts in — and only there, see `spawnCwd`.
 *
 * @module computer/handlers/proc
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { buildShellInvocation, killPidTree, PROCESS_TREE_DETACHED } from '@slayzone/platform'
import {
  HubToComputerMethods,
  procGetBufferSinceParamsSchema,
  type ProcListResult,
  procKillParamsSchema,
  procSpawnParamsSchema,
  procWriteParamsSchema,
  ComputerNotificationMethods
} from '@slayzone/computer-transport/shared'
import { spawnCwd } from '../config'
import { ExitTombstones } from '../exit-tombstones'
import { RingBuffer } from '../ring-buffer'
import { buildSpawnEnv } from './spawn-env'
import type { HandlerContext, HubMethodTable } from './types'

/** Matches the pty handler's per-session buffer cap (750 KiB). */
const MAX_BUFFER_SIZE = 750 * 1024

/** Re-exported for tests + main.ts wiring. Values come from the shared contract. */
export const ProcMethods = {
  procSpawn: HubToComputerMethods.procSpawn,
  procKill: HubToComputerMethods.procKill,
  procWrite: HubToComputerMethods.procWrite,
  procGetBufferSince: HubToComputerMethods.procGetBufferSince,
  procList: HubToComputerMethods.procList
} as const

export const ProcNotifications = {
  procData: ComputerNotificationMethods.procData,
  procExit: ComputerNotificationMethods.procExit
} as const

interface ProcSession {
  child: ChildProcess
  /** stdout only — the replayable stream. */
  buffer: RingBuffer
  /** The hub's idempotency key for the spawn attempt that started this process. */
  spawnId?: string
}

export interface ProcHandlers {
  handlers: HubMethodTable
  /** Kill every live process (called on computer shutdown). */
  disposeAll(): void
}

/**
 * `getProjectPaths` lets a cwd-less spawn resolve its own directory — the hub no
 * longer knows where a project lives on this machine. See `pty.ts`.
 */
export function createProcHandlers(
  ctx: HandlerContext,
  getProjectPaths?: () => { get(projectId: string): { path: string } | null } | null
): ProcHandlers {
  const procs = new Map<string, ProcSession>()
  const tombstones = new ExitTombstones()

  /**
   * Kill a spawned process AND everything it started. Signalling only the direct
   * child left a shell-wrapped command's descendants running with the stdout pipe
   * open, so its exit never arrived — on Linux even for `sh -c 'sleep 30'`, since
   * dash forks rather than execs a lone command. Same mechanism as the hub-local
   * process backend.
   */
  function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
    if (typeof child.pid === 'number') killPidTree(child.pid, signal)
    // Never got a pid (spawn failed): nothing to signal; `error` reports it.
  }

  function procSpawn(rawParams: unknown): { pid: number | null } {
    const params = procSpawnParamsSchema.parse(rawParams)
    if (params.spawnId !== undefined) {
      const live = procs.get(params.sessionId)
      // The hub re-sent an attempt whose reply it lost: this process IS it.
      if (live && live.spawnId === params.spawnId) return { pid: live.child.pid ?? null }
      if (tombstones.ran(params.sessionId, params.spawnId)) {
        throw new Error(
          `proc.spawn ${params.sessionId}: attempt ${params.spawnId} already ran and exited — not starting it twice`
        )
      }
    }
    // An explicit cwd wins (a worktree, or a task.base_dir the user set). Else
    // resolve the project's checkout here. Neither → the first allowed root, never
    // the computer's own launch directory (T-27: a hub-started process always
    // starts inside the jail).
    const resolved =
      params.cwd ??
      (params.projectId ? getProjectPaths?.()?.get(params.projectId)?.path : undefined)
    const cwd = spawnCwd(resolved, ctx.config.allowedRoots)

    // Replace any pre-existing process with the same sessionId.
    const existing = procs.get(params.sessionId)
    if (existing) {
      killTree(existing.child)
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
      env: buildSpawnEnv(ctx, params.env),
      // stdin PIPED (was 'ignore') so `proc.write` can reach the child.
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own process group, so a kill reaches everything it started (`pnpm dev`
      // → node → …), not just the shell — see `killTree`.
      detached: PROCESS_TREE_DETACHED
    })
    const buffer = new RingBuffer(MAX_BUFFER_SIZE)
    const session: ProcSession = {
      child,
      buffer,
      ...(params.spawnId !== undefined ? { spawnId: params.spawnId } : {})
    }
    procs.set(params.sessionId, session)

    // Emit proc.exit at most once, and only for the CURRENTLY-tracked process
    // for this sessionId. This dedupes the error+close double-fire on a failed
    // spawn (ENOENT emits both) and prevents a superseded process from tearing
    // down its replacement.
    const settle = (payload: {
      exitCode: number | null
      signal: string | null
      error?: string
    }): void => {
      if (procs.get(params.sessionId) !== session) return
      procs.delete(params.sessionId)
      const delivered = ctx.dialer.notify(ProcNotifications.procExit, {
        sessionId: params.sessionId,
        ...payload
      })
      tombstones.add(params.sessionId, {
        spawnId: session.spawnId,
        ...(typeof child.pid === 'number' ? { pid: child.pid } : {}),
        exitCode: payload.exitCode,
        signal: payload.signal,
        // The hub never got this exit, so it may be missing stdout too.
        ...(delivered ? {} : { buffer: session.buffer })
      })
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
    killTree(session.child, (params.signal as NodeJS.Signals | undefined) ?? 'SIGTERM')
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
    // An exited process's stdout is still served when its exit never reached the hub.
    const buffer = procs.get(params.sessionId)?.buffer ?? tombstones.get(params.sessionId)?.buffer
    if (!buffer) return { frames: [] }
    const frames = buffer.getChunksSince(params.seq).map((c) => ({ seq: c.seq, data: c.data }))
    return { frames }
  }

  /**
   * Every live child process this computer still holds, for hub reattach after a
   * dropped connection. The `proc.list` twin of the pty handler's `list` — the
   * computer is the authority on what survived, the hub's registry is only a
   * belief about it.
   */
  function procList(): ProcListResult {
    const sessions: ProcListResult['sessions'] = []
    for (const [sessionId, session] of procs) {
      sessions.push({
        sessionId,
        ...(session.spawnId !== undefined ? { spawnId: session.spawnId } : {}),
        ...(typeof session.child.pid === 'number' ? { pid: session.child.pid } : {}),
        seq: session.buffer.getCurrentSeq()
      })
    }
    return { sessions, exited: tombstones.list() }
  }

  function disposeAll(): void {
    for (const [sessionId, session] of procs) {
      killTree(session.child)
      ctx.log('proc disposed on shutdown', { sessionId })
    }
    procs.clear()
  }

  const handlers: HubMethodTable = {
    [ProcMethods.procSpawn]: procSpawn,
    [ProcMethods.procKill]: procKill,
    [ProcMethods.procWrite]: procWrite,
    [ProcMethods.procGetBufferSince]: procGetBufferSince,
    [ProcMethods.procList]: procList
  }

  return { handlers, disposeAll }
}
