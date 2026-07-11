/**
 * Hub-side exec proxies — routing backends that forward OS-level exec work
 * (ptys, child processes, git/fs worktree ops) to a remote runner over the
 * fleet gateway, transparently falling back to an in-process ("local") backend
 * when no runner is assigned.
 *
 * These are drop-in replacements for the terminal/processes/task exec backends:
 * `spawn(spec)` dispatches per-spec — a null resolved runnerId runs locally,
 * anything else is served by a remote handle whose data/exit stream is demuxed
 * from the shared gateway event bus and whose write/resize/kill translate to
 * hub → runner requests.
 *
 * LANDS DARK: nothing constructs these yet; a later serial unit wires them into
 * composition (and reconciles the local-mirror seam types below to the real
 * terminal/processes/task exports).
 *
 * ── Local-mirror seams ────────────────────────────────────────────────────
 * The consumed backend contracts (`PtyBackend`, `PtyHandle`, `PtySpawnSpec`,
 * `ProcessBackend`/`ProcHandle`/`ProcSpawnSpec`, `WorktreeExecAdapters`) and the
 * gateway surface (`RoutingGateway`) are declared here as structural mirrors of
 * the real exports (terminal `runtime/pty-backend`, processes `ProcessBackend`,
 * task `WorktreeExecAdapters`, fleet `HubFleetGateway`). They are ADDED by
 * sibling/earlier units and may not all exist in this base yet; a later
 * integration reconciles these mirrors to the canonical types. Two deliberate
 * divergences from the real interfaces, forced by remoting:
 *   1. `RoutingGateway.events` includes `proc.data`/`proc.exit` which the
 *      current `HubFleetGateway` does not yet emit — the wiring unit extends the
 *      gateway to surface them.
 *   2. `WorktreeExecAdapters.pathExists`/`removeArtifactDir` are async here; the
 *      real seams are sync (`boolean` / `void`). A network call cannot be
 *      synchronous, so remoting requires promoting them (or a hub-local sync
 *      fallback) at reconciliation. `getWorktreeColor` stays SYNC and is always
 *      served locally — a documented cosmetic degradation for remote worktrees.
 *
 * @module fleet/server/exec-proxies
 */

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

// ===========================================================================
// Local-mirror seam types (reconciled to real exports later — see module doc)
// ===========================================================================

/** Disposable returned by event-registration methods (mirrors node-pty IEvent). */
export interface ExecDisposable {
  dispose: () => void
}

/** Terminal exit payload (mirrors node-pty IPty `onExit`). */
export interface PtyExitEvent {
  exitCode: number | null
  signal?: number | string
}

/**
 * Mirror of the terminal `PtySpawnSpec`. `runnerId` (when present) is the
 * default routing hint; `resolveRunnerId` has the final say.
 */
export interface PtySpawnSpec {
  sessionId: string
  taskId?: string | null
  runnerId?: string | null
  file: string
  args: string[]
  options: {
    cwd: string
    env?: Record<string, string>
    cols?: number
    rows?: number
    name?: string
  }
  transport?: unknown
}

/** Mirror of the terminal `PtyHandle` (structural subset consumed here). */
export interface PtyHandle {
  /** 0 until the remote `pty.spawn` reply lands (remote ptys key by sessionId). */
  pid: number
  process: string
  fd?: number
  onData: (listener: (data: string) => void) => ExecDisposable
  onExit: (listener: (event: PtyExitEvent) => void) => ExecDisposable
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: (signal?: string) => void
}

/** Mirror of the terminal `PtyBackend`. */
export interface PtyBackend {
  spawn: (spec: PtySpawnSpec) => PtyHandle
}

/** Mirror of the processes `ProcSpawnSpec` (structural subset). */
export interface ProcSpawnSpec {
  sessionId: string
  taskId?: string | null
  runnerId?: string | null
  file: string
  args: string[]
  options: {
    cwd?: string
    env?: Record<string, string>
  }
  transport?: unknown
}

/** Mirror of the processes `ProcHandle`. */
export interface ProcHandle {
  pid: number
  onData: (listener: (data: string) => void) => ExecDisposable
  onExit: (listener: (event: PtyExitEvent) => void) => ExecDisposable
  kill: (signal?: string) => void
}

/** Mirror of the processes `ProcessBackend`. */
export interface ProcessBackend {
  spawn: (spec: ProcSpawnSpec) => ProcHandle
}

/**
 * Mirror of the task-domain `WorktreeExecAdapters` (10-method seam). Divergence:
 * `pathExists`/`removeArtifactDir` are async here (network); see module doc.
 */
export interface WorktreeExecAdapters {
  createWorktree: (
    repoPath: string,
    worktreePath: string,
    branch: string,
    sourceBranch?: string
  ) => Promise<void>
  removeWorktree: (
    projectPath: string,
    worktreePath: string
  ) => Promise<{ branchDeleted?: boolean; branchError?: string }>
  runWorktreeSetupScript: (
    worktreePath: string,
    repoPath: string,
    sourceBranch?: string | null
  ) => Promise<{ ran: boolean; success?: boolean; output?: string }>
  copyIgnoredFiles: (
    repoPath: string,
    worktreePath: string,
    behavior: 'all' | 'custom',
    customPaths: string[]
  ) => Promise<void>
  getCurrentBranch: (repoPath: string) => Promise<string | null>
  isGitRepo: (path: string) => Promise<boolean>
  getWorktreeColor: (projectPath: string, worktreePath: string) => string | undefined
  ensureProjectWorktreeColors: (projectPath: string) => Promise<ReadonlyMap<string, string>>
  pathExists: (path: string) => Promise<boolean>
  removeArtifactDir: (absDir: string) => Promise<void>
}

/**
 * Gateway event payloads the routing backends demux on. Structural mirror of a
 * superset of `FleetGatewayEvents` — includes `proc.*` which the current
 * gateway does not yet emit (reconciled by the wiring unit).
 */
export interface RoutingGatewayEvents {
  'pty.data': { runnerId: string; sessionId: string; seq: number; data: string }
  'pty.exit': { runnerId: string; sessionId: string; exitCode: number | null; signal?: string | null }
  'proc.data': { runnerId: string; sessionId: string; data: string; stream?: 'stdout' | 'stderr' }
  'proc.exit': { runnerId: string; sessionId: string; exitCode: number | null; signal?: string | null }
  'runner-lost': { runnerId: string; reason: string }
  'runner-disconnected': { runnerId: string; reason: string }
}

/**
 * Structural mirror of the fleet `HubFleetGateway` surface the routing backends
 * consume — request/notify addressed by runnerId plus the demux event bus.
 */
export interface RoutingGateway {
  request<T = unknown>(runnerId: string, method: string, params?: unknown, timeoutMs?: number): Promise<T>
  notify(runnerId: string, method: string, params?: unknown): void
  listRunners(): Array<{ runnerId: string }>
  readonly events: {
    on<K extends keyof RoutingGatewayEvents>(
      event: K,
      listener: (payload: RoutingGatewayEvents[K]) => void
    ): () => void
  }
}

// ===========================================================================
// Internal helpers
// ===========================================================================

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
    spawn(spec: PtySpawnSpec): PtyHandle {
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

      const handle: PtyHandle = {
        pid: 0,
        process: spec.file,
        onData: (listener) => dataEmitter.on(listener),
        onExit: (listener) => exitEmitter.on(listener),
        write: (data) => {
          void gateway
            .request(runnerId, HubToRunnerMethods.ptyWrite, { sessionId: spec.sessionId, data })
            .catch(noop)
        },
        resize: (cols, rows) => {
          void gateway
            .request(runnerId, HubToRunnerMethods.ptyResize, { sessionId: spec.sessionId, cols, rows })
            .catch(noop)
        },
        kill: (signal) => {
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
            if (parsed.success) handle.pid = parsed.data.pid
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
  dataEmitter: BufferingEmitter<string>
  exitEmitter: BufferingEmitter<PtyExitEvent>
}

/**
 * A `ProcessBackend` analogous to {@link createRoutingPtyBackend}. Child-process
 * output is not sequenced (no `proc.getBufferSince`), so `proc.data` is
 * delivered in arrival order — no gap detection/backfill.
 */
export function createRoutingProcessBackend(options: RoutingProcessBackendOptions): ProcessBackend {
  const { gateway, local, resolveRunnerId } = options
  const sessions = new Map<string, ProcEntry>()

  function finalize(entry: ProcEntry, exitCode: number | null, signal: string | null): void {
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

  gateway.events.on('proc.data', (payload) => {
    const entry = sessions.get(sessionKey(payload.runnerId, payload.sessionId))
    if (entry && !entry.disposed) entry.dataEmitter.emit(payload.data)
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

      const key = sessionKey(runnerId, spec.sessionId)
      const dataEmitter = new BufferingEmitter<string>()
      const exitEmitter = new BufferingEmitter<PtyExitEvent>()
      const entry: ProcEntry = { key, runnerId, sessionId: spec.sessionId, disposed: false, dataEmitter, exitEmitter }
      sessions.set(key, entry)

      const handle: ProcHandle = {
        pid: 0,
        onData: (listener) => dataEmitter.on(listener),
        onExit: (listener) => exitEmitter.on(listener),
        kill: (signal) => {
          void gateway
            .request(runnerId, HubToRunnerMethods.procKill, {
              sessionId: spec.sessionId,
              ...(signal ? { signal } : {})
            })
            .catch(noop)
        }
      }

      void gateway
        .request(runnerId, HubToRunnerMethods.procSpawn, {
          sessionId: spec.sessionId,
          command: spec.file,
          args: spec.args,
          cwd: spec.options.cwd,
          env: spec.options.env
        })
        .then(
          (res) => {
            const parsed = procSpawnResultSchema.safeParse(res)
            if (parsed.success) handle.pid = parsed.data.pid
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
