/**
 * Hub-side exec proxies — routing backends that forward OS-level exec work (ptys,
 * chat agents, child processes, git/fs worktree ops) to a runner over the runner
 * gateway, falling back to an in-process ("local") backend when no runner resolves.
 *
 * ── Runners run the agents ────────────────────────────────────────────────────
 * There is NO in-process fallback: an unresolved runner raises
 * {@link NoRunnerAvailableError} rather than silently executing on the hub. The old
 * fallback made "which machine ran this?" an invisible property of DB state — a
 * task with nothing bound looked identical to one deliberately pinned local, and a
 * chat agent could land on a different machine than its own worktree.
 *
 * This rests on `gateway.listUsableRunners()` (authenticated + inside the heartbeat
 * window) being the single presence authority. An earlier attempt at this
 * enforcement failed because it resolved through signals that lie — a DB row that
 * survives a runner which never connected, a socket map wiped on restart, a cache
 * that can name a dead runner.
 *
 * Two categories are hub-local by DESIGN, not by fallback, and must never route:
 * worktree COLOR state (`getWorktreeColor` is sync UI state) and HUB-STORAGE fs
 * ops (`hubPathExists` / `removeArtifactDir` — artifacts live under the hub's own
 * `<ROOT>/storage`, a path that does not exist on a runner).
 *
 * These are drop-in replacements for the terminal/processes/task exec backends:
 * `spawn(spec)` is served by a remote handle whose data/exit stream is demuxed
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
import type {
  ChatBackend,
  ChatProcHandle,
  ChatSpawnSpec,
  PtyBackend,
  PtyHandle,
  PtySpawnSpec
} from '@slayzone/terminal/server'
import {
  fsPathExistsResultSchema,
  gitGetCurrentBranchResultSchema,
  gitIsGitRepoResultSchema,
  gitRemoveWorktreeResultSchema,
  gitRunWorktreeSetupScriptResultSchema,
  HubToRunnerMethods,
  procGetBufferSinceResultSchema,
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

/**
 * Raised when exec work has no runner to go to.
 *
 * Runners run the agents — there is no in-process spawn path — so an unresolved
 * runner is a hard, visible failure rather than a silent degradation to the hub.
 * The message is user-facing: it says what to do, because the only fix is to
 * enroll or connect a runner.
 */
export class NoRunnerAvailableError extends Error {
  constructor(readonly what: string) {
    super(
      `No runner available to run ${what}. Agents, terminals and git work all run on runners — ` +
        `enroll one (Settings → Runners) or wait for the local runner to reconnect.`
    )
    this.name = 'NoRunnerAvailableError'
  }
}

// ===========================================================================
// Routing pty backend
// ===========================================================================

export interface RoutingPtyBackendOptions {
  gateway: RoutingGateway
  /** Route a spawn to a runnerId. `null` throws {@link NoRunnerAvailableError} —
   *  there is no in-process fallback. */
  resolveRunnerId: (spec: PtySpawnSpec) => string | null
}

interface PtyEntry {
  key: string
  runnerId: string
  sessionId: string
  /**
   * Highest contiguously-delivered seq. Starts at **-1**, not 0: the runner's
   * `RingBuffer` numbers its FIRST chunk seq 0 (`nextSeq = 0`), and `ingest`
   * drops `seq <= lastSeq` — so a 0 here silently discarded the opening chunk of
   * every remote pty session, which is where a shell's banner and first prompt
   * live. -1 also makes `getBufferSince(seq: -1)` include seq 0, since that
   * endpoint returns frames with `seq > params.seq`.
   */
  lastSeq: number
  /** Out-of-order frames awaiting a gap fill (seq → data). */
  pending: Map<number, string>
  /**
   * `lastSeq` value the in-flight/last backfill was issued for; `null` = never
   * backfilled. Deliberately NOT a numeric sentinel — `lastSeq` now starts at
   * -1, so a `-1` sentinel would compare equal on the very first gap and
   * suppress the one backfill that could recover seq 0.
   */
  backfilledAt: number | null
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
  const { gateway, resolveRunnerId } = options
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
    if (entry.backfilledAt === entry.lastSeq) {
      // A backfill already ran at this position and the gap is STILL unfilled, so
      // the missing seq is unrecoverable — evicted from the runner's ring buffer,
      // or never sent. Skip forward to the lowest pending seq and deliver rather
      // than waiting for a frame that will never arrive: holding the line would
      // stall the session permanently, which is strictly worse than a visible
      // gap. (Reachable in normal operation now that delivery starts at seq -1:
      // a session whose opening chunk aged out cannot produce seq 0.)
      const lowest = Math.min(...entry.pending.keys())
      if (lowest > entry.lastSeq + 1) {
        entry.lastSeq = lowest - 1
        drain(entry)
      }
      return
    }
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
      if (runnerId == null) throw new NoRunnerAvailableError(`terminal session ${spec.sessionId}`)

      const key = sessionKey(runnerId, spec.sessionId)
      const dataEmitter = new BufferingEmitter<string>()
      const exitEmitter = new BufferingEmitter<PtyExitEvent>()
      const entry: PtyEntry = {
        key,
        runnerId,
        sessionId: spec.sessionId,
        lastSeq: -1,
        pending: new Map(),
        backfilledAt: null,
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
  /** Route a spawn to a runnerId. `null` throws {@link NoRunnerAvailableError}.
   *  Sync by necessity: the process manager's `doSpawn` is synchronous (also driven
   *  by restart timers), so it cannot await a reconnect. */
  resolveRunnerId: (spec: ProcSpawnSpec) => string | null
  /**
   * Override how a spec becomes `proc.spawn` params. Default: treat
   * `spec.command` as a shell STRING (`shell: true`, no argv) — correct for the
   * process domain, whose commands are `pnpm dev`-style lines.
   *
   * The routed CHAT backend supplies its own: an agent spawn is a resolved
   * binary + argv that must reach execve UNSPLIT, so it passes `args` and leaves
   * `shell` unset. Without this seam the chat spawn inherited the shell-string
   * behavior and its argv was silently dropped.
   */
  buildSpawnParams?: (spec: ProcSpawnSpec) => Record<string, unknown>
}

interface ProcEntry {
  key: string
  runnerId: string
  sessionId: string
  /** Highest contiguously-delivered stdout seq. Starts at **-1** for the same
   *  reason as {@link PtyEntry.lastSeq}: the runner's RingBuffer numbers its
   *  FIRST chunk 0, and `ingest` drops `seq <= lastSeq`, so a 0 here would
   *  silently discard the opening chunk of every routed session — which for a
   *  chat agent is its protocol handshake. */
  lastSeq: number
  /** Out-of-order stdout frames awaiting a gap fill (seq → data). */
  pending: Map<number, string>
  /** `lastSeq` the in-flight/last backfill was issued for; `null` = never. */
  backfilledAt: number | null
  disposed: boolean
  dataEmitter: BufferingEmitter<{ chunk: string; stream: 'stdout' | 'stderr' }>
  exitEmitter: BufferingEmitter<{ code: number | null; signal: string | null }>
}

/**
 * A `ProcessBackend` analogous to {@link createRoutingPtyBackend}, including the
 * same ordering guarantees: stdout carries a monotonic per-session `seq`, gaps
 * trigger a `proc.getBufferSince` backfill, and delivery to the consumer stays
 * contiguous. That matters because this backend now also carries routed CHAT
 * agents, whose stdout is an NDJSON protocol stream — a dropped or reordered
 * chunk desynchronizes the driver's request correlation irrecoverably.
 *
 * stderr is diagnostic, unsequenced, and passed through in arrival order.
 *
 * The process manager's `ProcSpawnSpec` keys by `id` (the session id here) and
 * carries a single `command` string; the routing spawn forwards those to the
 * `proc.spawn` frame.
 */
export function createRoutingProcessBackend(options: RoutingProcessBackendOptions): ProcessBackend {
  const { gateway, resolveRunnerId } = options
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

  function drain(entry: ProcEntry): void {
    while (!entry.disposed && entry.pending.has(entry.lastSeq + 1)) {
      const next = entry.lastSeq + 1
      const data = entry.pending.get(next)!
      entry.pending.delete(next)
      entry.lastSeq = next
      entry.dataEmitter.emit({ chunk: data, stream: 'stdout' })
    }
    if (entry.disposed || entry.pending.size === 0) return
    if (entry.pending.has(entry.lastSeq + 1)) return // filled by the loop above
    if (entry.backfilledAt === entry.lastSeq) {
      // A backfill already ran at this position and the gap is STILL unfilled, so
      // the missing seq is unrecoverable (evicted from the runner's ring buffer,
      // or never sent). Skip to the lowest pending seq rather than stalling the
      // session forever — a visible gap beats a permanent hang.
      const lowest = Math.min(...entry.pending.keys())
      if (lowest > entry.lastSeq + 1) {
        entry.lastSeq = lowest - 1
        drain(entry)
      }
      return
    }
    entry.backfilledAt = entry.lastSeq
    void backfill(entry)
  }

  async function backfill(entry: ProcEntry): Promise<void> {
    try {
      const res = await gateway.request(entry.runnerId, HubToRunnerMethods.procGetBufferSince, {
        sessionId: entry.sessionId,
        seq: entry.lastSeq
      })
      if (entry.disposed) return
      const parsed = procGetBufferSinceResultSchema.safeParse(res)
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

  gateway.events.on('proc.data', (payload) => {
    const entry = sessions.get(sessionKey(payload.runnerId, payload.sessionId))
    if (!entry || entry.disposed) return
    const stream = payload.stream ?? 'stdout'
    // stderr (and any legacy unsequenced frame) bypasses the ordering machinery.
    if (stream === 'stderr' || typeof payload.seq !== 'number') {
      entry.dataEmitter.emit({ chunk: payload.data, stream })
      return
    }
    if (payload.seq <= entry.lastSeq) return // duplicate / already delivered
    entry.pending.set(payload.seq, payload.data)
    drain(entry)
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
      if (runnerId == null) throw new NoRunnerAvailableError(`process ${spec.id}`)

      const key = sessionKey(runnerId, spec.id)
      const dataEmitter = new BufferingEmitter<{ chunk: string; stream: 'stdout' | 'stderr' }>()
      const exitEmitter = new BufferingEmitter<{ code: number | null; signal: string | null }>()
      const entry: ProcEntry = {
        key,
        runnerId,
        sessionId: spec.id,
        lastSeq: -1,
        pending: new Map(),
        backfilledAt: null,
        disposed: false,
        dataEmitter,
        exitEmitter
      }
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
        /**
         * Write to the routed child's stdin. Beyond the `ProcessBackend` seam
         * (background processes never needed stdin), but the routed CHAT backend
         * built on this channel does — so the capability lives on the handle
         * rather than forcing callers to reach for the gateway directly.
         */
        write: (data: string): void => {
          void gateway
            .request(runnerId, HubToRunnerMethods.procWrite, { sessionId: spec.id, data })
            .catch(noop)
        },
        kill: (signal?: string): void => {
          void gateway
            .request(runnerId, HubToRunnerMethods.procKill, {
              sessionId: spec.id,
              ...(signal ? { signal } : {})
            })
            .catch(noop)
        }
      }

      // Default: `ProcSpawnSpec.command` is a shell command STRING (e.g.
      // `pnpm dev`), so ask the runner to run it through a shell. `shell: true` —
      // NOT a hub-side `buildShellInvocation` — because that helper resolves the
      // HUB's `$SHELL`, a path that need not exist on the runner's machine (the
      // same hub-local assumption that makes `whichBinary` wrong for a routed
      // spawn). The runner wraps with ITS own shell. Overridable via
      // `buildSpawnParams` (the chat backend needs literal argv).
      void gateway
        .request(
          runnerId,
          HubToRunnerMethods.procSpawn,
          options.buildSpawnParams?.(spec) ?? {
            sessionId: spec.id,
            command: spec.command,
            shell: true,
            cwd: spec.cwd,
            env: spec.env
          }
        )
        .then(
          (res) => {
            const parsed = procSpawnResultSchema.safeParse(res)
            // `pid` is nullable on the wire (immediate spawn failure); the handle
            // exposes `number | undefined`, so map null → undefined.
            if (parsed.success) pid = parsed.data.pid ?? undefined
          },
          () => finalize(entry, null, 'spawn-failed')
        )

      return handle
    }
  }
}

// ===========================================================================
// Routing chat backend
// ===========================================================================

export interface RoutingChatBackendOptions {
  gateway: RoutingGateway
  /** Route a spawn to a runnerId. `null` throws {@link NoRunnerAvailableError}. */
  resolveRunnerId: (spec: ChatSpawnSpec) => string | null
}

/**
 * A `ChatBackend` that forwards remote spawns over the gateway, so a chat-mode
 * agent runs on a runner exactly as a terminal-mode agent already does.
 *
 * Rides the SAME sequenced duplex `proc.*` channel as
 * {@link createRoutingProcessBackend} — no `chat.*` namespace. A chat agent is
 * just a child process whose stdout happens to be NDJSON; giving it a private
 * namespace would mean two wire contracts to keep ordered and duplex-correct.
 *
 * Line framing is NOT done here: raw chunks are handed to the transport, which
 * reassembles lines hub-side (`createLineSplitter`) and feeds its
 * `ChatSessionDriver`. So the runner stays a byte pipe and all protocol state —
 * handshake, request correlation — remains on the hub.
 */
export function createRoutingChatBackend(options: RoutingChatBackendOptions): ChatBackend {
  const { gateway, resolveRunnerId } = options

  return {
    async spawn(spec: ChatSpawnSpec): Promise<ChatProcHandle> {
      const runnerId = resolveRunnerId(spec)
      if (runnerId == null) throw new NoRunnerAvailableError(`chat agent ${spec.binaryName}`)

      const backend = createRoutingProcessBackend({
        gateway,
        resolveRunnerId: () => runnerId,
        // An agent spawn is a resolved binary + argv, NOT a shell string: `sh
        // <script>` must stay two argv entries. The default sender would set
        // `shell: true` and drop `args`, so the runner would hand the binary to a
        // shell and the agent would never receive its arguments.
        buildSpawnParams: (procSpec) => ({
          sessionId: procSpec.id,
          command: spec.binaryName,
          args: spec.args,
          cwd: spec.cwd,
          env: spec.env
        })
      })

      const spawnCbs: Array<() => void> = []
      const errorCbs: Array<(err: Error) => void> = []
      // Latched: `spawn()` is async, so the readiness signal can fire before the
      // caller has had a chance to subscribe. A late `onSpawn` must still see it,
      // or the session sits in `starting` until the watchdog reaps it.
      let didSpawn = false

      const procHandle = backend.spawn({
        id: spec.sessionId,
        taskId: spec.taskId,
        projectId: null,
        runnerId,
        // The binary NAME, resolved against the RUNNER's PATH — never a
        // hub-resolved absolute path, which would not exist there. `shell` is
        // deliberately unset: argv must reach execve unsplit.
        command: spec.binaryName,
        args: spec.args,
        cwd: spec.cwd,
        env: spec.env
      } as never)

      // A routed spawn has no kernel `'spawn'` event. The remote `proc.spawn`
      // reply is the equivalent readiness signal — it means the runner has a pid
      // — so surface it as `onSpawn`, which is what promotes the session out of
      // `starting` and starts the protocol driver. Deferred a tick so a caller
      // that subscribes right after `spawn()` resolves still sees it.
      setImmediate(() => {
        didSpawn = true
        for (const cb of [...spawnCbs]) {
          try {
            cb()
          } catch (err) {
            console.error('[routing-chat] onSpawn listener threw:', err)
          }
        }
      })

      return {
        get pid(): number {
          return procHandle.pid ?? 0
        },
        onSpawn: (cb) => {
          // Already fired → replay to this late subscriber instead of dropping it.
          if (didSpawn) {
            setImmediate(() => {
              try {
                cb()
              } catch (err) {
                console.error('[routing-chat] onSpawn listener threw:', err)
              }
            })
            return { dispose: () => {} }
          }
          spawnCbs.push(cb)
          return {
            dispose: () => {
              const i = spawnCbs.indexOf(cb)
              if (i >= 0) spawnCbs.splice(i, 1)
            }
          }
        },
        onStdout: (cb) =>
          procHandle.onData((chunk, stream) => {
            if (stream !== 'stderr') cb(chunk)
          }),
        onStderr: (cb) =>
          procHandle.onData((chunk, stream) => {
            if (stream === 'stderr') cb(chunk)
          }),
        onExit: (cb) => procHandle.onExit((e) => cb({ code: e.code, signal: e.signal })),
        onError: (cb) => {
          errorCbs.push(cb)
          return {
            dispose: () => {
              const i = errorCbs.indexOf(cb)
              if (i >= 0) errorCbs.splice(i, 1)
            }
          }
        },
        write: (data) =>
          (procHandle as unknown as { write?: (d: string) => void }).write?.(data),
        kill: (signal) => procHandle.kill(signal)
      }
    }
  }
}

// ===========================================================================
// Remote worktree adapters
// ===========================================================================

export interface RemoteWorktreeAdaptersOptions {
  gateway: RoutingGateway
  /** In-process adapters. Used ONLY for the two color ops, which are hub-local UI
   *  state and never routed — every other method requires a runner. */
  /** In-process adapters. Used ONLY for the ops that are hub-owned by design —
   *  worktree colors and the `<ROOT>/storage` artifact paths (see
   *  docs/exec-boundary.md). Every workspace op requires a runner. */
  local: Pick<
    WorktreeExecAdapters,
    'getWorktreeColor' | 'ensureProjectWorktreeColors' | 'hubPathExists' | 'removeArtifactDir'
  >
  /**
   * The runner a given TASK's worktree work belongs to, or null for hub-local.
   * Takes the taskId because that is the only thing a runner can be resolved
   * from (`resolveTaskRunnerId`). Previously argument-less, which is why the
   * composition root had to pin it to `() => null` and every method degraded to
   * local — so a task whose agent ran on a runner got its worktree on the hub.
   */
  resolveRunnerId: (taskId: string) => string | null | Promise<string | null>
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
    async createWorktree(taskId, repoPath, worktreePath, branch, sourceBranch) {
      const runnerId = await resolveRunnerId(taskId)
      if (runnerId == null) throw new NoRunnerAvailableError(`worktree create for task ${taskId}`)
      await gateway.request(runnerId, HubToRunnerMethods.gitCreateWorktree, {
        repoPath,
        worktreePath,
        branch,
        sourceBranch
      })
    },

    async removeWorktree(taskId, projectPath, worktreePath) {
      const runnerId = await resolveRunnerId(taskId)
      if (runnerId == null) throw new NoRunnerAvailableError(`worktree remove for task ${taskId}`)
      const res = await gateway.request(runnerId, HubToRunnerMethods.gitRemoveWorktree, {
        projectPath,
        worktreePath
      })
      return gitRemoveWorktreeResultSchema.parse(res)
    },

    async runWorktreeSetupScript(taskId, worktreePath, repoPath, sourceBranch) {
      const runnerId = await resolveRunnerId(taskId)
      if (runnerId == null) throw new NoRunnerAvailableError(`worktree setup for task ${taskId}`)
      const res = await gateway.request(runnerId, HubToRunnerMethods.gitRunWorktreeSetupScript, {
        worktreePath,
        repoPath,
        sourceBranch
      })
      return gitRunWorktreeSetupScriptResultSchema.parse(res)
    },

    async copyIgnoredFiles(taskId, repoPath, worktreePath, behavior, customPaths) {
      const runnerId = await resolveRunnerId(taskId)
      if (runnerId == null)
        throw new NoRunnerAvailableError(`ignored-file copy for task ${taskId}`)
      await gateway.request(runnerId, HubToRunnerMethods.gitCopyIgnoredFiles, {
        repoPath,
        worktreePath,
        behavior,
        customPaths
      })
    },

    async getCurrentBranch(taskId, repoPath) {
      const runnerId = await resolveRunnerId(taskId)
      if (runnerId == null) throw new NoRunnerAvailableError(`git branch read for task ${taskId}`)
      const res = await gateway.request(runnerId, HubToRunnerMethods.gitGetCurrentBranch, { repoPath })
      return gitGetCurrentBranchResultSchema.parse(res).branch
    },

    async isGitRepo(taskId, path) {
      const runnerId = await resolveRunnerId(taskId)
      if (runnerId == null) throw new NoRunnerAvailableError(`git repo probe for task ${taskId}`)
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

    // WORKSPACE path probe → routed (the workspace lives on the runner).
    async pathExists(taskId, path) {
      const runnerId = await resolveRunnerId(taskId)
      if (runnerId == null) throw new NoRunnerAvailableError(`path probe for task ${taskId}`)
      const res = await gateway.request(runnerId, HubToRunnerMethods.fsPathExists, { path })
      return fsPathExistsResultSchema.parse(res).exists
    },

    // HUB-storage ops: always local, never routed, and never require a runner.
    // Artifacts live under the hub's own <ROOT>/storage — that directory does not
    // exist on a runner, and routing these made archiving a task impossible
    // whenever no runner was connected.
    hubPathExists(absPath) {
      return local.hubPathExists(absPath)
    },

    removeArtifactDir(absDir) {
      return local.removeArtifactDir(absDir)
    }
  }
}
