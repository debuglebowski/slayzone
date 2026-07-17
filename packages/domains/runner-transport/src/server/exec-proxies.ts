/**
 * Hub-side exec proxies — routing backends that forward OS-level exec work
 * (ptys, child processes, git/fs worktree ops) to a remote runner over the
 * runner gateway, transparently falling back to an in-process ("local") backend
 * when no runner is assigned.
 *
 * These are drop-in replacements for the terminal/processes/task exec backends:
 * `spawn(spec)` dispatches per-spec — a null resolved runnerId runs locally,
 * anything else is served by a remote handle whose data/exit stream is demuxed
 * from the shared gateway event bus and whose write/resize/kill translate to
 * hub → runner requests.
 *
 * ── Seam types (wave-2B reconciliation) ───────────────────────────────────
 * The consumed backend contracts are imported from the REAL seams they mirror,
 * not re-declared here: `PtyBackend`/`PtyHandle`/`PtySpawnSpec` from
 * `@slayzone/terminal/server`, `ProcessBackend`/`ProcHandle`/`ProcSpawnSpec`
 * from `@slayzone/processes/server`, `WorktreeExecAdapters` from
 * `@slayzone/task/server`, and the gateway surface (`RoutingGateway`, a `Pick`
 * of `HubRunnerGateway`) from this package. The two remoting divergences the
 * earlier dark landing flagged are now resolved at their source:
 *   1. The gateway emits `proc.data`/`proc.exit` (added to `RunnerGatewayEvents`).
 *   2. `WorktreeExecAdapters.pathExists`/`removeArtifactDir` were widened to
 *      `boolean | Promise<boolean>` / `void | Promise<void>` so a remote
 *      (async) impl is valid alongside the sync local default. `getWorktreeColor`
 *      stays SYNC and is always served locally — a documented cosmetic
 *      degradation for remote worktrees.
 *
 * @module runner/server/exec-proxies
 */

import type { ProcessBackend, ProcHandle, ProcSpawnSpec } from '@slayzone/processes/server'
import type { WorktreeExecAdapters } from '@slayzone/task/server'
import type { PtyBackend, PtyHandle, PtySpawnSpec } from '@slayzone/terminal/server'
import {
  fsPathExistsResultSchema,
  gitGetCurrentBranchResultSchema,
  gitIsGitRepoResultSchema,
  gitRemoveWorktreeResultSchema,
  gitRunWorktreeSetupScriptResultSchema,
  HubToRunnerMethods,
  procSpawnResultSchema,
  ptyGetBufferSinceResultSchema,
  ptySpawnResultSchema
} from '../shared/frames'
import type { HubRunnerGateway } from './hub-gateway'

// ===========================================================================
// Gateway surface
// ===========================================================================

/**
 * The slice of the runner hub gateway the routing backends consume: addressed
 * request/notify plus the demux event bus. A `Pick` of the real
 * `HubRunnerGateway` (not a re-declared mirror) so it can never drift from the
 * gateway the composition root injects.
 */
export type RoutingGateway = Pick<HubRunnerGateway, 'request' | 'events'>

// ===========================================================================
// Internal helpers
// ===========================================================================

/** Disposable returned by event-registration methods (mirrors node-pty IEvent). */
interface ExecDisposable {
  dispose: () => void
}

/**
 * Terminal exit payload streamed by the routing pty handle. Wider than the
 * terminal seam's `onExit` param (`{ exitCode: number; signal?: number }`):
 * a remote runner can report a null exit code (signal death) and a string
 * signal (`runner-lost` / `runner-disconnected`). The handle stays assignable
 * to the terminal `PtyHandle` because `onExit` is a method (bivariant params);
 * pty-manager only reads `exitCode`, so the extra breadth is lossless there.
 */
export interface PtyExitEvent {
  exitCode: number | null
  signal?: number | string
}

/**
 * Emitter that buffers emissions until the first listener attaches (then flushes
 * to it and stops buffering). Bridges the race where a remote data/exit frame
 * can arrive before the consumer has called `onData`/`onExit`.
 */
class BufferingEmitter<T> {
  private readonly listeners = new Set<(value: T) => void>()
  private buffer: T[] | null = []

  emit(value: T): void {
    if (this.listeners.size > 0) {
      for (const listener of [...this.listeners]) listener(value)
    } else if (this.buffer) {
      this.buffer.push(value)
    }
  }

  on(listener: (value: T) => void): ExecDisposable {
    this.listeners.add(listener)
    if (this.buffer && this.buffer.length > 0) {
      const pending = this.buffer
      this.buffer = null
      for (const value of pending) listener(value)
    } else {
      // Once any listener exists, stop buffering (keep any not-yet-flushed
      // single exit event intact for a late onExit — see finalize* below).
      if (this.buffer && this.buffer.length === 0) this.buffer = null
    }
    return { dispose: () => this.listeners.delete(listener) }
  }
}

const sessionKey = (runnerId: string, sessionId: string): string => `${runnerId}:${sessionId}`

const noop = (): void => {}

// ===========================================================================
// Routing pty backend
// ===========================================================================

export interface RoutingPtyBackendOptions {
  gateway: RoutingGateway
  /** In-process backend used when `resolveRunnerId` returns null. */
  local: PtyBackend
  /** Route a spawn to a runnerId, or null to run locally. */
  resolveRunnerId: (spec: PtySpawnSpec) => string | null
}

interface PtyEntry {
  key: string
  runnerId: string
  sessionId: string
  /** Highest contiguously-delivered seq (delivery starts at seq 1). */
  lastSeq: number
  /** Out-of-order frames awaiting a gap fill (seq → data). */
  pending: Map<number, string>
  /** `lastSeq` value the in-flight/last backfill was issued for (`-1` = none). */
  backfilledAt: number
  disposed: boolean
  dataEmitter: BufferingEmitter<string>
  exitEmitter: BufferingEmitter<PtyExitEvent>
}

/**
 * A `PtyBackend` that forwards remote spawns over the gateway. Maintains ONE
 * `pty.data` + ONE `pty.exit` gateway listener and a per-session demux Map;
 * out-of-order frames trigger a `pty.getBufferSince` backfill so delivery stays
 * monotonic. Sessions are disposed on `pty.exit` and on runner loss/disconnect.
 */
export function createRoutingPtyBackend(options: RoutingPtyBackendOptions): PtyBackend {
  const { gateway, local, resolveRunnerId } = options
  const sessions = new Map<string, PtyEntry>()

  function drain(entry: PtyEntry): void {
    while (!entry.disposed && entry.pending.has(entry.lastSeq + 1)) {
      const next = entry.lastSeq + 1
      const data = entry.pending.get(next)!
      entry.pending.delete(next)
      entry.lastSeq = next
      entry.dataEmitter.emit(data)
    }
    if (entry.disposed || entry.pending.size === 0) return
    if (entry.pending.has(entry.lastSeq + 1)) return // filled by the loop above
    if (entry.backfilledAt === entry.lastSeq) return // already tried at this position
    entry.backfilledAt = entry.lastSeq
    void backfill(entry)
  }

  async function backfill(entry: PtyEntry): Promise<void> {
    try {
      const res = await gateway.request(entry.runnerId, HubToRunnerMethods.ptyGetBufferSince, {
        sessionId: entry.sessionId,
        seq: entry.lastSeq
      })
      if (entry.disposed) return
      const parsed = ptyGetBufferSinceResultSchema.safeParse(res)
      if (parsed.success) {
        for (const frame of parsed.data.frames) {
          if (frame.seq > entry.lastSeq && !entry.pending.has(frame.seq)) {
            entry.pending.set(frame.seq, frame.data)
          }
        }
      }
    } catch {
      // Best-effort: a later frame re-triggers backfill once lastSeq advances.
    }
    if (!entry.disposed) drain(entry)
  }

  function ingest(entry: PtyEntry, seq: number, data: string): void {
    if (entry.disposed) return
    if (seq <= entry.lastSeq) return // duplicate / already delivered
    entry.pending.set(seq, data)
    drain(entry)
  }

  function finalize(entry: PtyEntry, exitCode: number | null, signal: string | null): void {
    if (entry.disposed) return
    entry.disposed = true
    sessions.delete(entry.key)
    entry.exitEmitter.emit({ exitCode, signal: signal ?? undefined })
  }

  function disposeRunner(runnerId: string, reason: string): void {
    for (const entry of [...sessions.values()]) {
      if (entry.runnerId === runnerId) finalize(entry, null, reason)
    }
  }

  gateway.events.on('pty.data', (payload) => {
    const entry = sessions.get(sessionKey(payload.runnerId, payload.sessionId))
    if (entry) ingest(entry, payload.seq, payload.data)
  })
  gateway.events.on('pty.exit', (payload) => {
    const entry = sessions.get(sessionKey(payload.runnerId, payload.sessionId))
    if (entry) finalize(entry, payload.exitCode, payload.signal ?? null)
  })
  gateway.events.on('runner-lost', (payload) => disposeRunner(payload.runnerId, 'runner-lost'))
  gateway.events.on('runner-disconnected', (payload) => disposeRunner(payload.runnerId, 'runner-disconnected'))

  return {
    spawn(spec: PtySpawnSpec): PtyHandle | Promise<PtyHandle> {
      const runnerId = resolveRunnerId(spec)
      if (runnerId == null) return local.spawn(spec)

      const key = sessionKey(runnerId, spec.sessionId)
      const dataEmitter = new BufferingEmitter<string>()
      const exitEmitter = new BufferingEmitter<PtyExitEvent>()
      const entry: PtyEntry = {
        key,
        runnerId,
        sessionId: spec.sessionId,
        lastSeq: 0,
        pending: new Map(),
        backfilledAt: -1,
        disposed: false,
        dataEmitter,
        exitEmitter
      }
      sessions.set(key, entry)

      // `pid` is 0 until the remote `pty.spawn` reply lands (remote ptys key by
      // sessionId, not pid). Exposed via a getter so the returned handle stays a
      // valid `readonly pid` under the terminal `PtyHandle` seam.
      let pid = 0
      // Annotated `PtyHandle` so the object is checked against the terminal seam
      // directly. `onExit` adapts the wider remote `PtyExitEvent` (exitCode may be
      // null on signal death / runner-loss; signal may be a string like
      // 'runner-lost') to the seam's `{ exitCode: number; signal?: number }`:
      // null exit code → 1 (abnormal), string signals dropped. Lossless for
      // pty-manager, which only reads `exitCode`.
      const handle: PtyHandle = {
        get pid(): number {
          return pid
        },
        process: spec.file,
        onData: (listener: (data: string) => void): ExecDisposable => dataEmitter.on(listener),
        onExit: (cb: (e: { exitCode: number; signal?: number }) => void): ExecDisposable =>
          exitEmitter.on((event) =>
            cb({
              exitCode: event.exitCode ?? 1,
              signal: typeof event.signal === 'number' ? event.signal : undefined
            })
          ),
        write: (data: string): void => {
          void gateway
            .request(runnerId, HubToRunnerMethods.ptyWrite, { sessionId: spec.sessionId, data })
            .catch(noop)
        },
        resize: (cols: number, rows: number): void => {
          void gateway
            .request(runnerId, HubToRunnerMethods.ptyResize, { sessionId: spec.sessionId, cols, rows })
            .catch(noop)
        },
        kill: (signal?: string): void => {
          void gateway
            .request(runnerId, HubToRunnerMethods.ptyKill, {
              sessionId: spec.sessionId,
              ...(signal ? { signal } : {})
            })
            .catch(noop)
        }
      }

      void gateway
        .request(runnerId, HubToRunnerMethods.ptySpawn, {
          sessionId: spec.sessionId,
          command: spec.file,
          args: spec.args,
          cwd: spec.options.cwd,
          env: spec.options.env,
          cols: spec.options.cols,
          rows: spec.options.rows
        })
        .then(
          (res) => {
            const parsed = ptySpawnResultSchema.safeParse(res)
            if (parsed.success) pid = parsed.data.pid
          },
          () => finalize(entry, null, 'spawn-failed')
        )

      return handle
    }
  }
}

// ===========================================================================
// Routing process backend
// ===========================================================================

export interface RoutingProcessBackendOptions {
  gateway: RoutingGateway
  local: ProcessBackend
  resolveRunnerId: (spec: ProcSpawnSpec) => string | null
}

interface ProcEntry {
  key: string
  runnerId: string
  sessionId: string
  disposed: boolean
  dataEmitter: BufferingEmitter<{ chunk: string; stream: 'stdout' | 'stderr' }>
  exitEmitter: BufferingEmitter<{ code: number | null; signal: string | null }>
}

/**
 * A `ProcessBackend` analogous to {@link createRoutingPtyBackend}. Child-process
 * output is not sequenced (no `proc.getBufferSince`), so `proc.data` is
 * delivered in arrival order — no gap detection/backfill. The process manager's
 * `ProcSpawnSpec` keys by `id` (the session id here) and carries a single
 * `command` string; the routing spawn forwards those to the `proc.spawn` frame.
 */
export function createRoutingProcessBackend(options: RoutingProcessBackendOptions): ProcessBackend {
  const { gateway, local, resolveRunnerId } = options
  const sessions = new Map<string, ProcEntry>()

  function finalize(entry: ProcEntry, code: number | null, signal: string | null): void {
    if (entry.disposed) return
    entry.disposed = true
    sessions.delete(entry.key)
    entry.exitEmitter.emit({ code, signal })
  }

  function disposeRunner(runnerId: string, reason: string): void {
    for (const entry of [...sessions.values()]) {
      if (entry.runnerId === runnerId) finalize(entry, null, reason)
    }
  }

  gateway.events.on('proc.data', (payload) => {
    const entry = sessions.get(sessionKey(payload.runnerId, payload.sessionId))
    if (entry && !entry.disposed) {
      entry.dataEmitter.emit({ chunk: payload.data, stream: payload.stream ?? 'stdout' })
    }
  })
  gateway.events.on('proc.exit', (payload) => {
    const entry = sessions.get(sessionKey(payload.runnerId, payload.sessionId))
    if (entry) finalize(entry, payload.exitCode, payload.signal ?? null)
  })
  gateway.events.on('runner-lost', (payload) => disposeRunner(payload.runnerId, 'runner-lost'))
  gateway.events.on('runner-disconnected', (payload) => disposeRunner(payload.runnerId, 'runner-disconnected'))

  return {
    spawn(spec: ProcSpawnSpec): ProcHandle {
      const runnerId = resolveRunnerId(spec)
      if (runnerId == null) return local.spawn(spec)

      const key = sessionKey(runnerId, spec.id)
      const dataEmitter = new BufferingEmitter<{ chunk: string; stream: 'stdout' | 'stderr' }>()
      const exitEmitter = new BufferingEmitter<{ code: number | null; signal: string | null }>()
      const entry: ProcEntry = { key, runnerId, sessionId: spec.id, disposed: false, dataEmitter, exitEmitter }
      sessions.set(key, entry)

      let pid: number | undefined
      const handle = {
        get pid(): number | undefined {
          return pid
        },
        onData: (
          cb: (chunk: string, stream: 'stdout' | 'stderr') => void
        ): ExecDisposable => dataEmitter.on((v) => cb(v.chunk, v.stream)),
        onExit: (
          cb: (e: { code: number | null; signal: string | null }) => void
        ): ExecDisposable => exitEmitter.on(cb),
        kill: (signal?: string): void => {
          void gateway
            .request(runnerId, HubToRunnerMethods.procKill, {
              sessionId: spec.id,
              ...(signal ? { signal } : {})
            })
            .catch(noop)
        }
      }

      void gateway
        .request(runnerId, HubToRunnerMethods.procSpawn, {
          sessionId: spec.id,
          command: spec.command,
          cwd: spec.cwd,
          env: spec.env
        })
        .then(
          (res) => {
            const parsed = procSpawnResultSchema.safeParse(res)
            if (parsed.success) pid = parsed.data.pid
          },
          () => finalize(entry, null, 'spawn-failed')
        )

      return handle
    }
  }
}

// ===========================================================================
// Remote worktree adapters
// ===========================================================================

export interface RemoteWorktreeAdaptersOptions {
  gateway: RoutingGateway
  /** In-process adapters — fallback when unrouted, plus always-local color ops. */
  local: WorktreeExecAdapters
  /** The runner these adapters route to, or null when it is hub-local. */
  resolveRunnerId: () => string | null
}

/**
 * A COMPLETE `WorktreeExecAdapters` that forwards git/fs work to a runner.
 * `getWorktreeColor` (SYNC) and `ensureProjectWorktreeColors` are always served
 * by `local` — worktree colors are hub-local UI state, and a sync getter cannot
 * be a network call (documented cosmetic degradation for remote worktrees).
 * When `resolveRunnerId()` is null every method degrades to `local`.
 */
export function createRemoteWorktreeAdapters(options: RemoteWorktreeAdaptersOptions): WorktreeExecAdapters {
  const { gateway, local, resolveRunnerId } = options

  return {
    async createWorktree(repoPath, worktreePath, branch, sourceBranch) {
      const runnerId = resolveRunnerId()
      if (runnerId == null) return local.createWorktree(repoPath, worktreePath, branch, sourceBranch)
      await gateway.request(runnerId, HubToRunnerMethods.gitCreateWorktree, {
        repoPath,
        worktreePath,
        branch,
        sourceBranch
      })
    },

    async removeWorktree(projectPath, worktreePath) {
      const runnerId = resolveRunnerId()
      if (runnerId == null) return local.removeWorktree(projectPath, worktreePath)
      const res = await gateway.request(runnerId, HubToRunnerMethods.gitRemoveWorktree, {
        projectPath,
        worktreePath
      })
      return gitRemoveWorktreeResultSchema.parse(res)
    },

    async runWorktreeSetupScript(worktreePath, repoPath, sourceBranch) {
      const runnerId = resolveRunnerId()
      if (runnerId == null) return local.runWorktreeSetupScript(worktreePath, repoPath, sourceBranch)
      const res = await gateway.request(runnerId, HubToRunnerMethods.gitRunWorktreeSetupScript, {
        worktreePath,
        repoPath,
        sourceBranch
      })
      return gitRunWorktreeSetupScriptResultSchema.parse(res)
    },

    async copyIgnoredFiles(repoPath, worktreePath, behavior, customPaths) {
      const runnerId = resolveRunnerId()
      if (runnerId == null) return local.copyIgnoredFiles(repoPath, worktreePath, behavior, customPaths)
      await gateway.request(runnerId, HubToRunnerMethods.gitCopyIgnoredFiles, {
        repoPath,
        worktreePath,
        behavior,
        customPaths
      })
    },

    async getCurrentBranch(repoPath) {
      const runnerId = resolveRunnerId()
      if (runnerId == null) return local.getCurrentBranch(repoPath)
      const res = await gateway.request(runnerId, HubToRunnerMethods.gitGetCurrentBranch, { repoPath })
      return gitGetCurrentBranchResultSchema.parse(res).branch
    },

    async isGitRepo(path) {
      const runnerId = resolveRunnerId()
      if (runnerId == null) return local.isGitRepo(path)
      const res = await gateway.request(runnerId, HubToRunnerMethods.gitIsGitRepo, { path })
      return gitIsGitRepoResultSchema.parse(res).isGitRepo
    },

    // SYNC + hub-local: worktree colors are UI state; cannot be a network call.
    getWorktreeColor(projectPath, worktreePath) {
      return local.getWorktreeColor(projectPath, worktreePath)
    },

    ensureProjectWorktreeColors(projectPath) {
      return local.ensureProjectWorktreeColors(projectPath)
    },

    async pathExists(path) {
      const runnerId = resolveRunnerId()
      if (runnerId == null) return local.pathExists(path)
      const res = await gateway.request(runnerId, HubToRunnerMethods.fsPathExists, { path })
      return fsPathExistsResultSchema.parse(res).exists
    },

    async removeArtifactDir(absDir) {
      const runnerId = resolveRunnerId()
      if (runnerId == null) return local.removeArtifactDir(absDir)
      await gateway.request(runnerId, HubToRunnerMethods.fsRemoveDir, { path: absDir })
    }
  }
}
