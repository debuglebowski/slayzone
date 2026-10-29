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
 * usable by a bidirectional agent protocol at all. A write is CONFIRMED: the reply
 * comes only once the bytes reached the child's stdin, and a write that cannot be
 * delivered (unknown session, replaced attempt, closed pipe) is refused with a
 * `ProcRefusalReasons` code — never acked. A retried write (same `writeId`) is
 * written once.
 *
 * Output is decoded with one `StringDecoder` per stream: a multi-byte character
 * split across two reads stays intact (per-chunk `toString()` turned it into
 * U+FFFD, which corrupted the agent's NDJSON text).
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
import { StringDecoder } from 'node:string_decoder'
import { buildShellInvocation, killPidTree, PROCESS_TREE_DETACHED } from '@slayzone/platform'
import {
  ComputerTransportErrorCodes,
  HubToComputerMethods,
  procGetBufferSinceParamsSchema,
  type ProcListResult,
  procKillParamsSchema,
  ProcRefusalReasons,
  type ProcSpawnParams,
  procSpawnParamsSchema,
  type ProcWriteResult,
  procWriteParamsSchema,
  ComputerNotificationMethods,
  RpcError
} from '@slayzone/computer-transport/shared'
import { spawnCwd } from '../config'
import { ExitTombstones } from '../exit-tombstones'
import { RingBuffer } from '../ring-buffer'
import {
  createSpawnAdmission,
  type AdmissionSlot,
  type AdmissionTicket,
  type SpawnAdmission
} from '../spawn-admission'
import { resolveCommand } from './resolve-command'
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

/** How many recent `writeId`s a session remembers for retry dedupe. */
const WRITE_ID_MEMORY = 256

interface ProcSession {
  child: ChildProcess
  /** stdout only — the replayable stream. */
  buffer: RingBuffer
  /** The hub's idempotency key for the spawn attempt that started this process. */
  spawnId?: string
  /** Set once stdin errored (EPIPE …): later writes are refused, not attempted. */
  stdinBroken: string | null
  /** Recent `writeId`s, oldest first (bounded by {@link WRITE_ID_MEMORY}). */
  writeIds: string[]
  /** Agent-start slot held until first output or exit (admitted spawns only). */
  slot: AdmissionSlot | null
}

/** An admitted spawn waiting for its start slot. */
interface QueuedProcSpawn {
  spawnId?: string
  ticket: AdmissionTicket
  promise: Promise<{ pid: number | null }>
  resolve: (value: { pid: number | null } | Promise<{ pid: number | null }>) => void
  reject: (err: unknown) => void
}

export interface ProcHandlers {
  handlers: HubMethodTable
  /** Kill every live process (called on computer shutdown). */
  disposeAll(): void
}

export interface ProcHandlerOptions {
  /** The computer-wide agent-start queue (see spawn-admission.ts); tests get a private one. */
  admission?: SpawnAdmission
}

function refuse(reason: string, message: string, data: Record<string, unknown> = {}): RpcError {
  return new RpcError(ComputerTransportErrorCodes.refusedByComputer, message, {
    reason,
    ...data
  })
}

/**
 * `getProjectPaths` lets a cwd-less spawn resolve its own directory — the hub no
 * longer knows where a project lives on this machine. See `pty.ts`.
 */
export function createProcHandlers(
  ctx: HandlerContext,
  getProjectPaths?: () => { get(projectId: string): { path: string } | null } | null,
  options: ProcHandlerOptions = {}
): ProcHandlers {
  const procs = new Map<string, ProcSession>()
  const tombstones = new ExitTombstones()
  const admission = options.admission ?? createSpawnAdmission()
  const queued = new Map<string, QueuedProcSpawn>()

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

  function releaseSlot(session: ProcSession): void {
    const slot = session.slot
    session.slot = null
    slot?.release()
  }

  function procSpawn(rawParams: unknown): { pid: number | null } | Promise<{ pid: number | null }> {
    const params = procSpawnParamsSchema.parse(rawParams)
    if (!params.admission) return startProc(params, null)
    // An agent start: wait for a slot in the computer-wide queue (restoring many
    // chat tabs must not start every agent at once). The reply waits with it.
    const prior = queued.get(params.sessionId)
    if (prior && params.spawnId !== undefined && prior.spawnId === params.spawnId) {
      return prior.promise
    }
    let resolve!: QueuedProcSpawn['resolve']
    let reject!: QueuedProcSpawn['reject']
    const promise = new Promise<{ pid: number | null }>((res, rej) => {
      resolve = res
      reject = rej
    })
    const item: QueuedProcSpawn = {
      ...(params.spawnId !== undefined ? { spawnId: params.spawnId } : {}),
      ticket: undefined as unknown as AdmissionTicket,
      promise,
      resolve,
      reject
    }
    if (prior) {
      // Superseded while waiting: it did not fail, it was replaced — same reply.
      admission.cancel(prior.ticket)
      prior.resolve(promise)
    }
    queued.set(params.sessionId, item)
    item.ticket = admission.enqueue(params.admission, (slot) => {
      if (queued.get(params.sessionId) !== item) {
        slot.release()
        return
      }
      queued.delete(params.sessionId)
      try {
        item.resolve(startProc(params, slot))
      } catch (err) {
        slot.release()
        item.reject(err)
      }
    })
    return promise
  }

  function startProc(params: ProcSpawnParams, slot: AdmissionSlot | null): { pid: number | null } {
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
    const env = buildSpawnEnv(ctx, params.env)
    // A literal command is looked up first, so a missing one is refused with its
    // name (the hub shows "Claude Code isn't installed") instead of a bare exit.
    if (!params.shell && resolveCommand(params.command, env, cwd) === null) {
      throw refuse(
        ProcRefusalReasons.binaryNotFound,
        `${params.command} was not found on this computer's PATH`,
        { binary: params.command }
      )
    }
    const invocation = params.shell
      ? buildShellInvocation(params.command)
      : { file: params.command, args: params.args ?? [] }
    const child = spawn(invocation.file, invocation.args, {
      ...(cwd ? { cwd } : {}),
      env,
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
      ...(params.spawnId !== undefined ? { spawnId: params.spawnId } : {}),
      stdinBroken: null,
      writeIds: [],
      slot
    }
    procs.set(params.sessionId, session)
    const tag = params.spawnId !== undefined ? { spawnId: params.spawnId } : {}
    // Without a listener a broken pipe (the child closed stdin, or died) is an
    // unhandled 'error' event — it would take the whole computer down.
    child.stdin?.on('error', (err) => {
      session.stdinBroken = err.message
      ctx.log('proc stdin error', { sessionId: params.sessionId, error: err.message })
    })

    // Emit proc.exit at most once, and only for the CURRENTLY-tracked process
    // for this sessionId. This dedupes the error+close double-fire on a failed
    // spawn (ENOENT emits both) and prevents a superseded process from tearing
    // down its replacement.
    const settle = (payload: {
      exitCode: number | null
      signal: string | null
      error?: string
    }): void => {
      releaseSlot(session)
      if (procs.get(params.sessionId) !== session) return
      procs.delete(params.sessionId)
      const delivered = ctx.dialer.notify(ProcNotifications.procExit, {
        sessionId: params.sessionId,
        ...tag,
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

    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    const emitStdout = (data: string): void => {
      // A chunk that ended mid-character decodes to '' until the rest arrives.
      if (!data || procs.get(params.sessionId) !== session) return
      // Buffer + stream the SAME text under the same seq: the hub's demux keeps
      // whichever copy of a seq arrives first (live or backfilled) and emits it
      // once, so any per-seq divergence would make output depend on timing.
      const seq = buffer.append(data)
      ctx.dialer.notify(ProcNotifications.procData, {
        sessionId: params.sessionId,
        ...tag,
        seq,
        stream: 'stdout',
        data
      })
    }
    const emitStderr = (data: string): void => {
      if (!data || procs.get(params.sessionId) !== session) return
      // Unsequenced: stderr is diagnostic, never protocol, and is not replayable.
      ctx.dialer.notify(ProcNotifications.procData, {
        sessionId: params.sessionId,
        ...tag,
        stream: 'stderr',
        data
      })
    }
    child.stdout?.on('data', (d: Buffer) => {
      // First output: the agent got past its expensive start — free the slot.
      releaseSlot(session)
      emitStdout(stdoutDecoder.write(d))
    })
    child.stderr?.on('data', (d: Buffer) => {
      releaseSlot(session)
      emitStderr(stderrDecoder.write(d))
    })
    child.on('close', (code, signal) => {
      emitStdout(stdoutDecoder.end())
      emitStderr(stderrDecoder.end())
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
    if (params.spawnId !== undefined && session.spawnId !== params.spawnId) {
      // Meant for a process this session no longer runs: that one is already gone.
      ctx.log('proc kill for a replaced attempt', { sessionId: params.sessionId })
      return { ok: true }
    }
    killTree(session.child, (params.signal as NodeJS.Signals | undefined) ?? 'SIGTERM')
    return { ok: true }
  }

  function procWrite(rawParams: unknown): Promise<ProcWriteResult> {
    const params = procWriteParamsSchema.parse(rawParams)
    const session = procs.get(params.sessionId)
    if (!session) {
      ctx.log('proc write on unknown session', { sessionId: params.sessionId })
      return Promise.reject(
        refuse(ProcRefusalReasons.unknownSession, `proc.write: no process ${params.sessionId}`)
      )
    }
    if (params.spawnId !== undefined && session.spawnId !== params.spawnId) {
      return Promise.reject(
        refuse(
          ProcRefusalReasons.staleSpawn,
          `proc.write: ${params.sessionId} now runs a different process`
        )
      )
    }
    if (params.writeId !== undefined && session.writeIds.includes(params.writeId)) {
      return Promise.resolve({ ok: true, delivered: true, duplicate: true })
    }
    const stdin = session.child.stdin
    if (!stdin || session.stdinBroken !== null || stdin.destroyed || stdin.writableEnded) {
      return Promise.reject(
        refuse(
          ProcRefusalReasons.stdinClosed,
          `proc.write: ${params.sessionId} stdin is closed${
            session.stdinBroken ? ` (${session.stdinBroken})` : ''
          }`
        )
      )
    }
    if (params.writeId !== undefined) {
      session.writeIds.push(params.writeId)
      if (session.writeIds.length > WRITE_ID_MEMORY) session.writeIds.shift()
    }
    return new Promise((resolve, reject) => {
      const fail = (err: unknown): void => {
        // Not delivered: forget the id so a retry is attempted, not deduped.
        if (params.writeId !== undefined) {
          session.writeIds = session.writeIds.filter((id) => id !== params.writeId)
        }
        const message = err instanceof Error ? err.message : String(err)
        session.stdinBroken ??= message
        ctx.log('proc write failed', { sessionId: params.sessionId, error: message })
        reject(
          refuse(ProcRefusalReasons.stdinClosed, `proc.write: ${params.sessionId}: ${message}`)
        )
      }
      try {
        // The callback fires once the chunk is handed to the OS pipe (or failed).
        stdin.write(params.data, (err) =>
          err ? fail(err) : resolve({ ok: true, delivered: true })
        )
      } catch (err) {
        fail(err)
      }
    })
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
    for (const item of queued.values()) {
      admission.cancel(item.ticket)
      item.reject(new Error('computer shutting down'))
    }
    queued.clear()
    for (const [sessionId, session] of procs) {
      releaseSlot(session)
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
