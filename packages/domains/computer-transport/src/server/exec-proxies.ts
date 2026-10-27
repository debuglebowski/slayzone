/**
 * Hub-side exec proxies — routing backends that forward OS-level exec work (ptys,
 * chat agents, child processes, git/fs worktree ops) to a computer over the computer
 * gateway. A computer is REQUIRED; see the next paragraph.
 *
 * ── Computers run the agents ────────────────────────────────────────────────────
 * There is NO in-process fallback: an unresolved computer raises
 * {@link NoComputerAvailableError} rather than silently executing on the hub. The old
 * fallback made "which machine ran this?" an invisible property of DB state — a
 * task with nothing bound looked identical to one deliberately pinned local, and a
 * chat agent could land on a different machine than its own worktree.
 *
 * This rests on `gateway.listUsableComputers()` (authenticated + inside the heartbeat
 * window) being the single presence authority. An earlier attempt at this
 * enforcement failed because it resolved through signals that lie — a DB row that
 * survives a computer which never connected, a socket map wiped on restart, a cache
 * that can name a dead computer.
 *
 * Two categories are hub-local by DESIGN, not by fallback, and must never route:
 * worktree COLOR state (`getWorktreeColor` is sync UI state) and HUB-STORAGE fs
 * ops (`hubPathExists` / `removeArtifactDir` — artifacts live under the hub's own
 * `<ROOT>/storage`, a path that does not exist on a computer).
 *
 * These are drop-in replacements for the terminal/processes/task exec backends:
 * `spawn(spec)` is served by a remote handle whose data/exit stream is demuxed
 * from the shared gateway event bus and whose write/resize/kill translate to
 * hub → computer requests.
 *
 * ── Seam types (wave-2B reconciliation) ───────────────────────────────────
 * The consumed backend contracts are imported from the REAL seams they mirror,
 * not re-declared here: `PtyBackend`/`PtyHandle`/`PtySpawnSpec` from
 * `@slayzone/terminal/server`, `ProcessBackend`/`ProcHandle`/`ProcSpawnSpec`
 * from `@slayzone/processes/server`, `WorktreeExecAdapters` from
 * `@slayzone/task/server`, and the gateway surface (`RoutingGateway`, a `Pick`
 * of `HubComputerGateway`) from this package. The two remoting divergences the
 * earlier dark landing flagged are now resolved at their source:
 *   1. The gateway emits `proc.data`/`proc.exit` (added to `ComputerGatewayEvents`).
 *   2. `WorktreeExecAdapters.pathExists`/`removeArtifactDir` were widened to
 *      `boolean | Promise<boolean>` / `void | Promise<void>` so a remote
 *      (async) impl is valid alongside the sync local default. `getWorktreeColor`
 *      stays SYNC and is always served locally — a documented cosmetic
 *      degradation for remote worktrees.
 *
 * @module computer/server/exec-proxies
 */

import { randomUUID } from 'node:crypto'
import type { ProcessBackend, ProcHandle, ProcSpawnSpec } from '@slayzone/processes/server'
import type { LocalWorkspaceFs, WorkspaceFsAdapters } from '@slayzone/file-editor/server'
import type { WorktreeExecAdapters } from '@slayzone/task/server'
import type {
  ChatBackend,
  ChatProcHandle,
  ChatSpawnSpec,
  PtyBackend,
  PtyHandle,
  PtySpawnConfirmation,
  PtySpawnSpec
} from '@slayzone/terminal/server'
import {
  ComputerTransportErrorCodes,
  fsCopyInResultSchema,
  fsDiscoverReposResultSchema,
  projectResolvePathResultSchema,
  projectSetPathResultSchema,
  fsGitStatusResultSchema,
  fsListAllFilesResultSchema,
  fsListDirResultSchema,
  fsListRootsResultSchema,
  fsMkdirResultSchema,
  fsOkResultSchema,
  fsPathExistsResultSchema,
  fsReadDirResultSchema,
  fsReadFileResultSchema,
  fsSearchFilesResultSchema,
  gitGetCurrentBranchResultSchema,
  gitIsGitRepoResultSchema,
  gitRemoveWorktreeResultSchema,
  gitRunWorktreeSetupScriptResultSchema,
  HubToComputerMethods,
  procGetBufferSinceResultSchema,
  procListResultSchema,
  procSpawnResultSchema,
  ptyGetBufferSinceResultSchema,
  ptyListResultSchema,
  ptySpawnResultSchema,
  ptyWarmAdoptResultSchema,
  ptyWarmListResultSchema,
  ptyWarmSpawnResultSchema,
  computerSetAllowedRootsResultSchema
} from '../shared/frames'
import { RpcDisposedError, RpcError } from '../shared/rpc'
import { recordDiagnosticEvent } from '@slayzone/diagnostics/server'
import type { HubComputerGateway } from './hub-gateway'

// ===========================================================================
// Gateway surface
// ===========================================================================

/**
 * The slice of the computer hub gateway the routing backends consume: addressed
 * request/notify, the demux event bus, and the connected-computer roster. A `Pick`
 * of the real `HubComputerGateway` (not a re-declared mirror) so it can never
 * drift from the gateway the composition root injects.
 *
 * `listComputers` is here for the detach controller's epoch baseline: the chat
 * backend builds its routing backend at SPAWN time, long after the computer
 * connected, so a controller that learned epochs only from `computer-connected`
 * events would have no baseline for exactly those sessions and would finalize
 * them on the first disconnect. Reading the roster at construction closes that.
 */
export type RoutingGateway = Pick<HubComputerGateway, 'request' | 'events' | 'listComputers'>

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
 * a remote computer can report a null exit code (signal death) and a string
 * signal (`computer-lost` / `computer-disconnected`). The handle stays assignable
 * to the terminal `PtyHandle` because `onExit` is a method (bivariant params);
 * pty-manager only reads `exitCode`, so the extra breadth is lossless there.
 */
export interface PtyExitEvent {
  exitCode: number | null
  signal?: number | string
  /** Lifecycle cause: the computer's own (`startup-timeout`) or a transport outcome. */
  reason?: string
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

const sessionKey = (computerId: string, sessionId: string): string => `${computerId}:${sessionId}`

/**
 * Did this request fail because the CONNECTION went away, rather than because the
 * computer answered with a refusal?
 *
 * The distinction is the whole point. A refusal is the computer's verdict. A lost
 * connection is no verdict at all: the request may have run, may be running, or
 * may never have arrived — and treating it as a failure is how a dropped socket
 * used to turn a batch of healthy agents into "Process exited with code -1".
 * `unknownComputer` is the gateway's own answer for a computer it has no socket
 * for (the computer never raises it for a spawn).
 */
function isConnectionLoss(err: unknown): boolean {
  if (err instanceof RpcDisposedError) return true
  return err instanceof RpcError && err.code === ComputerTransportErrorCodes.unknownComputer
}

const noop = (): void => {
  // Shared rejection sink for the fire-and-forget gateway calls below (write,
  // resize, kill, …). Each is a best-effort nudge at a session that may already
  // be gone; nothing waits on the reply and the authoritative teardown arrives
  // as an exit/close frame regardless. Swallowing here is what keeps a
  // disconnected computer from raising an unhandled rejection in the hub.
}

/**
 * Raised when exec work has no computer to go to.
 *
 * Computers run the agents — there is no in-process spawn path — so an unresolved
 * computer is a hard, visible failure rather than a silent degradation to the hub.
 * The message is user-facing: it says what to do, because the only fix is to
 * enroll or connect a computer.
 */
export class NoComputerAvailableError extends Error {
  constructor(readonly what: string) {
    super(
      `No computer available to run ${what}. Agents, terminals and git work all run on computers — ` +
        `enroll one (Settings → Computers) or wait for the local computer to reconnect.`
    )
    this.name = 'NoComputerAvailableError'
  }
}

/**
 * What a request to a computer is FOR (T-19): the task or agent session it works on,
 * or `null` when a caller names a computer directly with nothing behind it (the
 * directory picker, the file editor) — then it is that caller's own request.
 */
export type ComputerWork = { readonly kind: 'task' | 'session'; readonly id: string } | null

/**
 * Asked before every request that starts work on, or reads from, a computer: a spawn,
 * a warm adopt, git work for a task, a filesystem read or write. Throws to refuse,
 * and then nothing reaches the computer. The hub decides (a computer works only for
 * its owner — transport `computer-access.ts`); absent, nothing is asked, which is the
 * hub without login (the desktop app's) and every test that predates it.
 */
export type ComputerWorkGate = (computerId: string, work: ComputerWork) => Promise<void>

// ===========================================================================
// Detach / reattach across a dropped computer connection
// ===========================================================================

/**
 * How long the hub keeps tracking sessions on a computer it cannot reach.
 *
 * This is NOT a claim that the computer is dead when it expires — the hub cannot
 * know that, and a timer is not evidence. It bounds the hub's own bookkeeping:
 * without it, a computer that never returns leaks its entries forever and every
 * task it owned hangs in "reconnecting" with nothing able to resolve it.
 *
 * Long enough to cover a lunch-break lid close, short enough not to hoard dead
 * state. A reconnect inside the window resolves each session for real (see
 * {@link createDetachController}), so this only ever fires when nothing better
 * was available.
 */
const DETACH_GRACE_MS = 10 * 60_000

/** The entry shape the detach controller needs, common to pty and proc. */
interface DetachableEntry {
  computerId: string
  sessionId: string
  disposed: boolean
  /** Computer unreachable: outcome unknown, still tracked, NOT finalized. */
  detached: boolean
  /** The spawn attempt this entry belongs to — the idempotency key it was sent with. */
  spawnId?: string
  /**
   * Set while the spawn ITSELF has an unknown outcome: its reply was lost to a
   * dropped connection, so the computer may or may not be running it. Settled on
   * reconnect exactly like a detached session — by asking the computer.
   */
  pendingSpawn?: PendingSpawn
}

interface PendingSpawn {
  /** Re-issue the identical request. Same `spawnId`, so a duplicate is harmless. */
  resend: () => void
  /**
   * The computer holds (or held) this attempt: settle the spawn with its pid.
   * `listedBySpawnId` — the computer named the attempt by its key, i.e. it is new
   * enough to have honoured everything the request asked of it.
   */
  confirm: (pid: number | null, listedBySpawnId: boolean) => void
}

/** A live session as the computer reports it in `pty.list` / `proc.list`. */
interface ListedSession {
  pid?: number
  spawnId?: string
}

/** A session the computer reaped and remembers (a tombstone). */
interface ListedExit extends ListedSession {
  exitCode: number | null
  signal: string | null
  reason?: string
}

/** The computer's own account of what it holds, keyed by session id. */
interface ComputerSessionList {
  live: Map<string, ListedSession>
  /** Empty for a computer too old to keep tombstones. */
  exited: Map<string, ListedExit>
}

/**
 * Is a listed process this entry's spawn ATTEMPT, not merely the same session id?
 *
 * Session ids repeat — an agent tab reuses its id on every restart — so an older
 * process can be listed under the id a newer spawn is waiting on. An unknown key on
 * either side (an older computer, or an entry that never had one) counts as a
 * match: presence is then the strongest evidence available, as it always was.
 */
function sameAttempt(entry: DetachableEntry, listed: ListedSession): boolean {
  return (
    entry.spawnId === undefined || listed.spawnId === undefined || entry.spawnId === listed.spawnId
  )
}

/** Build {@link ComputerSessionList} from a parsed `pty.list` / `proc.list` reply. */
function toSessionList(parsed: {
  sessions: Array<{ sessionId: string; pid?: number; spawnId?: string }>
  exited?: Array<{
    sessionId: string
    pid?: number
    spawnId?: string
    exitCode: number | null
    signal: string | null
    reason?: string
  }>
}): ComputerSessionList {
  return {
    live: new Map(parsed.sessions.map((s) => [s.sessionId, { pid: s.pid, spawnId: s.spawnId }])),
    exited: new Map((parsed.exited ?? []).map((e) => [e.sessionId, e]))
  }
}

interface DetachControllerOptions<E extends DetachableEntry> {
  gateway: RoutingGateway
  /** The backend's live session map (keyed by `sessionKey`). */
  sessions: Map<string, E>
  /** `pty` / `proc` — diagnostics and log text only. */
  kind: string
  /** Hub→computer method listing the sessions the computer still holds. */
  listMethod: string
  /** Hub→computer method ending one session, for orphans the hub no longer tracks. */
  killMethod: string
  /** Parse that reply; `null` when it does not parse. */
  parseList: (raw: unknown) => ComputerSessionList | null
  /** Report a session as ended, with the reason the hub let go of it. */
  finalize: (entry: E, reason: string) => void
  /** Computer confirmed this session is still alive: resume delivery + backfill. */
  resume: (entry: E, listed: ListedSession) => void
  /** Computer reaped this session while the hub was away: deliver its tail + real exit. */
  settleExited: (entry: E, exit: ListedExit) => void
}

/**
 * Keeps sessions alive across a dropped computer connection, and resolves each
 * one against the computer itself on reconnect.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Both routing backends used to wire `computer-lost` / `computer-disconnected`
 * straight to a disposal that finalized every session on the computer. Since the
 * handle seam coerces a null exit code to 1, one dropped socket surfaced as N
 * independent "Process exited with code 1" — while the computer and every agent
 * on it were still running (the computer only kills ptys on its OWN shutdown).
 * Closing a laptop lid did exactly this: the heartbeat watchdog fired on wake
 * having never observed the window it was judging.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * Silence is not evidence. A quiet socket cannot distinguish crashed from
 * partitioned from asleep, so a disconnect resolves NOTHING — it only moves
 * sessions to `detached`. Every session is then closed out by a decisive signal:
 *
 *   - reconnect, SAME epoch, present in the computer's list → still alive, resume
 *   - reconnect, SAME epoch, ABSENT from the list        → really did exit
 *   - reconnect, DIFFERENT (or unknown) epoch            → fresh process, gone
 *   - grace expired, no reconnect                        → hub stops tracking
 *
 * Only the last is time-based, and it is deliberately a statement about the hub
 * ("I am no longer tracking this"), not about the world ("your agent died").
 *
 * ── One controller per (gateway, kind), not per backend ─────────────────────
 * `createRoutingChatBackend` builds a FRESH `createRoutingProcessBackend` for
 * every agent it spawns. A controller per backend would therefore add a listener
 * set to the shared gateway on every spawn — unbounded growth over a session —
 * and fire one `proc.list` per agent on every reconnect. So callers JOIN the
 * controller for their (gateway, kind) and contribute a participant; the gateway
 * listeners and the reconnect round-trip are wired exactly once.
 */
interface DetachParticipant {
  sessions: Map<string, DetachableEntry>
  finalize: (entry: DetachableEntry, reason: string) => void
  resume: (entry: DetachableEntry, listed: ListedSession) => void
  settleExited: (entry: DetachableEntry, exit: ListedExit) => void
  /** Has this participant ever held a session? Gates pruning — see `prune`. */
  everUsed?: boolean
}

/** Mark ONE entry's outcome unknown and bound the wait — see `DetachController.detach`. */
type DetachEntry = (entry: DetachableEntry) => void

interface DetachController {
  join: (participant: DetachParticipant) => void
  /**
   * Mark one entry detached outside a computer-wide disconnect: a spawn whose
   * request was refused for want of a socket. The computer-wide detach already
   * covers every entry it can see; this covers one registered after it.
   */
  detach: DetachEntry
}

/** Live controllers, keyed by gateway then by kind. Weak so a discarded hub's go too. */
const detachControllers = new WeakMap<RoutingGateway, Map<string, DetachController>>()

function joinDetachController<E extends DetachableEntry>(
  options: DetachControllerOptions<E>
): DetachEntry {
  const { gateway, sessions, kind, finalize, resume, settleExited } = options
  const participant = {
    sessions,
    finalize,
    resume,
    settleExited
  } as unknown as DetachParticipant

  let byKind = detachControllers.get(gateway)
  if (!byKind) {
    byKind = new Map()
    detachControllers.set(gateway, byKind)
  }
  const existing = byKind.get(kind)
  if (existing) {
    existing.join(participant)
    return existing.detach
  }
  const controller = createDetachController(options)
  byKind.set(kind, controller)
  controller.join(participant)
  return controller.detach
}

function createDetachController<E extends DetachableEntry>(
  options: DetachControllerOptions<E>
): DetachController {
  const { gateway, kind, listMethod, killMethod, parseList } = options
  const participants: DetachParticipant[] = []
  /**
   * Epoch seen on each computer's LAST connect — the baseline a reconnect is
   * compared against. Seeded from the roster because a controller can be built
   * after the computer already connected (chat), and a missing baseline is
   * indistinguishable from a restart, which would finalize live sessions.
   */
  const epochByComputer = new Map<string, string | undefined>(
    gateway.listComputers().map((r) => [r.computerId, r.epoch] as const)
  )
  const graceTimers = new Map<string, ReturnType<typeof setTimeout>>()

  /** An entry together with the participant that owns (and can finalize) it. */
  interface Owned {
    entry: DetachableEntry
    owner: DetachParticipant
  }

  /**
   * Drop participants that have finished. The chat backend builds a fresh
   * process backend per agent spawn, so without this the controller accumulates
   * one empty `sessions` Map (and its closures) per agent for the life of the
   * hub. Gated on `everUsed` so a backend that has not spawned yet survives.
   */
  function prune(): void {
    for (let i = participants.length - 1; i >= 0; i--) {
      const p = participants[i]!
      if (p.sessions.size > 0) {
        p.everUsed = true
      } else if (p.everUsed) {
        participants.splice(i, 1)
      }
    }
  }

  const liveEntries = (computerId: string): Owned[] =>
    participants.flatMap((owner) =>
      [...owner.sessions.values()]
        .filter((e) => e.computerId === computerId && !e.disposed)
        .map((entry) => ({ entry, owner }))
    )

  function clearGrace(computerId: string): void {
    const timer = graceTimers.get(computerId)
    if (!timer) return
    clearTimeout(timer)
    graceTimers.delete(computerId)
  }

  function armGrace(computerId: string): void {
    clearGrace(computerId)
    const timer = setTimeout(() => {
      graceTimers.delete(computerId)
      const stranded = liveEntries(computerId).filter((o) => o.entry.detached)
      if (stranded.length === 0) return
      for (const o of stranded) o.owner.finalize(o.entry, 'reattach-timeout')
      record('computer.sessions_dropped', 'error', stranded, computerId, {
        message:
          `Computer unreachable for ${String(Math.round(DETACH_GRACE_MS / 60_000))} minutes — ` +
          `${String(stranded.length)} ${kind} session(s) dropped. The hub has stopped tracking ` +
          'them; any process still running on the computer is no longer attached to a task.'
      })
    }, DETACH_GRACE_MS)
    timer.unref?.()
    graceTimers.set(computerId, timer)
  }

  function record(
    event: string,
    level: 'info' | 'error',
    entries: Owned[],
    computerId: string,
    extra: { message: string; [k: string]: unknown }
  ): void {
    const { message, ...rest } = extra
    try {
      recordDiagnosticEvent({
        level,
        source: 'pty',
        event,
        message,
        payload: {
          computerId,
          kind,
          sessionCount: entries.length,
          sessionIds: entries.map((o) => o.entry.sessionId),
          ...rest
        }
      })
    } catch {
      /* diagnostics unavailable — the state transition must still complete */
    }
  }

  function detachComputer(computerId: string, reason: string): void {
    prune()
    const fresh = liveEntries(computerId).filter((o) => !o.entry.detached)
    for (const o of fresh) o.entry.detached = true
    if (liveEntries(computerId).some((o) => o.entry.detached)) armGrace(computerId)
    if (fresh.length === 0) return
    // INFO, not error: nothing has gone wrong yet. Recorded because it is the
    // one place that knows the blast radius, and because the reattach that
    // follows is only legible next to it.
    record('computer.sessions_detached', 'info', fresh, computerId, {
      reason,
      message:
        `Computer connection lost (${reason}) — ${String(fresh.length)} ${kind} session(s) ` +
        'detached, awaiting reattach. Nothing has been killed.'
    })
  }

  async function reattachComputer(computerId: string, epoch: string | undefined): Promise<void> {
    prune()
    const previousEpoch = epochByComputer.get(computerId)
    epochByComputer.set(computerId, epoch)
    const detached = liveEntries(computerId).filter((o) => o.entry.detached)
    // First contact with this computer: nothing was ever detached, and the sweep
    // below has no baseline to sweep against.
    if (previousEpoch === undefined && detached.length === 0) return
    clearGrace(computerId)

    // A missing epoch on EITHER side proves nothing — an old computer that cannot
    // report one, or a hub that never saw the pre-disconnect value. Absence is
    // not a match: fall back to the conservative pre-epoch outcome rather than
    // reattaching to a process whose identity is unverified.
    if (epoch === undefined || previousEpoch === undefined || epoch !== previousEpoch) {
      if (detached.length === 0) return
      for (const o of detached) o.owner.finalize(o.entry, 'computer-restarted')
      record('computer.sessions_disposed', 'error', detached, computerId, {
        previousEpoch: previousEpoch ?? null,
        epoch: epoch ?? null,
        message:
          `Computer reconnected as a different process — ${String(detached.length)} ${kind} ` +
          'session(s) it was running are gone with the old one.'
      })
      return
    }

    // Same process. It is the authority on what it still holds; the hub's
    // registry is only a belief about that.
    let listed: ComputerSessionList | null = null
    try {
      listed = parseList(await gateway.request(computerId, listMethod, {}))
    } catch {
      listed = null
    }
    if (listed === null) {
      // Unanswerable right now. Leave everything detached and re-arm: a later
      // reconnect can still resolve it, and the grace timer bounds the wait.
      armGrace(computerId)
      return
    }

    // Re-read rather than reuse the snapshot: the list was an await, and an entry
    // closed meanwhile (disposed) must not be resumed or re-spawned.
    const stillDetached = detached.filter((o) => !o.entry.disposed && o.entry.detached)
    const resumed: Owned[] = []
    const exited: Owned[] = []
    const resent: Owned[] = []
    const ended: Owned[] = []
    for (const o of stillDetached) {
      const running = listed.live.get(o.entry.sessionId)
      if (running && sameAttempt(o.entry, running)) {
        o.owner.resume(o.entry, running)
        resumed.push(o)
        continue
      }
      const reaped = listed.exited.get(o.entry.sessionId)
      if (reaped && sameAttempt(o.entry, reaped)) {
        o.owner.settleExited(o.entry, reaped)
        exited.push(o)
        continue
      }
      const pending = o.entry.pendingSpawn
      if (pending) {
        // Neither running nor reaped: the request never reached the computer. Send
        // it again — the same attempt, so a copy that did land is answered with
        // the process it already started rather than a second agent.
        o.entry.detached = false
        pending.resend()
        resent.push(o)
        continue
      }
      o.owner.finalize(o.entry, 'exited-while-detached')
      ended.push(o)
    }
    // Sessions the computer holds that the hub no longer tracks — e.g. dropped by
    // an earlier grace expiry, or closed while the computer was unreachable.
    // Nothing will ever attach to them again, so end them here rather than
    // leaving an agent running against no task.
    //
    // "Tracked" means tracked as THIS attempt: a session id can be held by an
    // older attempt's process that nothing owns. Exception: an id whose spawn was
    // just re-sent is never swept — the computer replaces the old process with the
    // new one, and a kill for that id would land after the spawn and end it.
    const tracked = liveEntries(computerId)
    for (const [sessionId, running] of listed.live) {
      const owned = tracked.some(
        (o) =>
          o.entry.sessionId === sessionId &&
          (o.entry.pendingSpawn !== undefined || sameAttempt(o.entry, running))
      )
      if (owned) continue
      void gateway.request(computerId, killMethod, { sessionId }).catch(noop)
    }
    if (resumed.length > 0) {
      record('computer.sessions_reattached', 'info', resumed, computerId, {
        message: `Computer reconnected — ${String(resumed.length)} ${kind} session(s) reattached.`
      })
    }
    if (exited.length > 0) {
      // INFO: these ended on their own, and the computer kept their real exits.
      record('computer.sessions_exited_while_detached', 'info', exited, computerId, {
        message: `${String(exited.length)} ${kind} session(s) exited while the computer was unreachable; exits reported by the computer.`
      })
    }
    if (resent.length > 0) {
      record('computer.spawns_resent', 'info', resent, computerId, {
        message: `${String(resent.length)} ${kind} spawn(s) lost with the connection were sent again.`
      })
    }
    if (ended.length > 0) {
      record('computer.sessions_disposed', 'error', ended, computerId, {
        message: `${String(ended.length)} ${kind} session(s) exited while the computer was unreachable.`
      })
    }
  }

  gateway.events.on('computer-lost', (p) => detachComputer(p.computerId, 'computer-lost'))
  gateway.events.on('computer-disconnected', (p) =>
    detachComputer(p.computerId, 'computer-disconnected')
  )
  gateway.events.on('computer-connected', (p) => {
    void reattachComputer(p.computer.computerId, p.computer.epoch)
  })

  return {
    join: (participant) => participants.push(participant),
    detach: (entry) => {
      entry.detached = true
      // Bound the wait like any detached session — but never RESTART a running
      // window, which would let a flapping connection postpone it forever.
      if (!graceTimers.has(entry.computerId)) armGrace(entry.computerId)
    }
  }
}

// ===========================================================================
// Routing pty backend
// ===========================================================================

export interface RoutingPtyBackendOptions {
  gateway: RoutingGateway
  /** Route a spawn to a computerId. `null` throws {@link NoComputerAvailableError} —
   *  there is no in-process fallback. */
  resolveComputerId: (spec: PtySpawnSpec) => string | null
  /** Asked before a spawn (for its task) and an adopt (for its session). */
  gate?: ComputerWorkGate
}

interface PtyEntry extends DetachableEntry {
  key: string
  /**
   * Ask the computer to start this session next if its spawn is still waiting
   * for an agent-start slot. Set only for a spawn sent with `admission`.
   */
  prioritize?: () => void
  /**
   * Highest contiguously-delivered seq. Starts at **-1**, not 0: the computer's
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
  /**
   * The computer went unreachable while this session was live: its outcome is
   * UNKNOWN, not decided. Still tracked, never finalized — resolved on
   * reconnect against the computer's own session list. See
   * {@link createDetachController}.
   */
  detached: boolean
  /**
   * Withhold delivery until the warm-adopt seed lands (adopt only).
   *
   * The computer starts streaming the instant it rekeys, so live frames can reach
   * the hub BEFORE the `pty.warmAdopt` reply carrying everything the session
   * emitted while warm. Such a frame sits far above the initial `lastSeq` of -1,
   * which reads as a gap and fires a `getBufferSince` on EVERY adopt — a wasted
   * round-trip re-fetching exactly the bytes the adopt reply already carries.
   * Sealing suppresses that; the seed then sets the real `lastSeq` and drains.
   *
   * Ordering does NOT depend on this (a raced frame parks in `pending` either
   * way, since post-adopt seqs are always above the seed's). Pinned by test —
   * removing the seal fails on the backfill count, not on output order.
   */
  sealed: boolean
  dataEmitter: BufferingEmitter<string>
  exitEmitter: BufferingEmitter<PtyExitEvent>
}

/**
 * A `PtyBackend` that forwards remote spawns over the gateway. Maintains ONE
 * `pty.data` + ONE `pty.exit` gateway listener and a per-session demux Map;
 * out-of-order frames trigger a `pty.getBufferSince` backfill so delivery stays
 * monotonic. Sessions are disposed on `pty.exit` and on computer loss/disconnect.
 */
export function createRoutingPtyBackend(options: RoutingPtyBackendOptions): PtyBackend {
  const { gateway, resolveComputerId, gate } = options
  const sessions = new Map<string, PtyEntry>()

  function drain(entry: PtyEntry): void {
    if (entry.sealed) return
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
      // the missing seq is unrecoverable — evicted from the computer's ring buffer,
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
      const res = await gateway.request(entry.computerId, HubToComputerMethods.ptyGetBufferSince, {
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

  /** Deliver everything still parked, in seq order, gaps and all — the session is
   *  ending, so there is no later frame left to wait for. */
  function flushPending(entry: PtyEntry): void {
    for (const seq of [...entry.pending.keys()].sort((a, b) => a - b)) {
      if (seq <= entry.lastSeq) continue
      entry.lastSeq = seq
      entry.dataEmitter.emit(entry.pending.get(seq)!)
    }
    entry.pending.clear()
  }

  function finalize(
    entry: PtyEntry,
    exitCode: number | null,
    signal: string | null,
    reason?: string
  ): void {
    if (entry.disposed) return
    entry.disposed = true
    // A spawn ended while its outcome was still unknown (computer restarted, grace
    // expired) leaves `whenSpawned` unsettled ON PURPOSE: this exit is the verdict,
    // and settling it either way makes pty-manager overwrite the exit with a
    // synthetic -1 ("refused" / "confirmed without a pid").
    entry.pendingSpawn = undefined
    sessions.delete(entry.key)
    entry.exitEmitter.emit({ exitCode, signal: signal ?? undefined, ...(reason ? { reason } : {}) })
  }

  gateway.events.on('pty.data', (payload) => {
    const entry = sessions.get(sessionKey(payload.computerId, payload.sessionId))
    if (entry) ingest(entry, payload.seq, payload.data)
  })
  gateway.events.on('pty.exit', (payload) => {
    const entry = sessions.get(sessionKey(payload.computerId, payload.sessionId))
    if (entry) finalize(entry, payload.exitCode, payload.signal ?? null, payload.reason)
  })
  const detach = joinDetachController<PtyEntry>({
    gateway,
    sessions,
    kind: 'terminal',
    listMethod: HubToComputerMethods.ptyList,
    killMethod: HubToComputerMethods.ptyKill,
    parseList: (raw) => {
      const parsed = ptyListResultSchema.safeParse(raw)
      return parsed.success ? toSessionList(parsed.data) : null
    },
    finalize: (entry, reason) => finalize(entry, null, null, reason),
    resume: (entry, listed) => {
      entry.detached = false
      entry.pendingSpawn?.confirm(listed.pid ?? null, listed.spawnId !== undefined)
      // Clear the backfill latch: the gap that matters now is whatever the
      // session emitted while the hub was away, which is a different gap from
      // any this entry had already given up on.
      entry.backfilledAt = null
      void backfill(entry)
    },
    settleExited: (entry, exit) => {
      // Confirm FIRST, with the pid it really ran under: a spawn left unsettled
      // reads downstream as refused, and that verdict would overwrite the real
      // exit below with a synthetic one.
      entry.pendingSpawn?.confirm(exit.pid ?? null, exit.spawnId !== undefined)
      entry.detached = false
      void (async () => {
        // The computer keeps a reaped session's output with its tombstone; that
        // tail (often the line saying WHY it exited) lands before the exit does.
        await backfill(entry)
        flushPending(entry)
        finalize(entry, exit.exitCode, exit.signal, exit.reason)
      })()
    }
  })

  /**
   * Register a routed session and build its handle. Shared by `spawn` and
   * `adopt`: both end up with an ordinary remote session keyed by
   * `(computerId, sessionId)`; they differ only in the request that starts it and
   * whether delivery is sealed pending a seed.
   */
  function register(
    computerId: string,
    sessionId: string,
    processName: string,
    sealed: boolean,
    /** The gate's answer for a spawn still being decided: input waits behind it (so it
     *  never overtakes the spawn request) and is dropped when it refused. */
    admitted: Promise<void> | null = null
  ): { entry: PtyEntry; handle: PtyHandle; setPid: (pid: number | null) => void } {
    const key = sessionKey(computerId, sessionId)
    // Leak diagnostics: a second live entry for the same key silently takes over
    // its routing (the first's consumers stop receiving data). Should never happen.
    const displaced = sessions.get(key)
    if (displaced && !displaced.disposed) {
      console.warn('[routing-pty] register displaced a live session entry', {
        computerId,
        sessionId,
        displacedLastSeq: displaced.lastSeq,
        displacedDetached: displaced.detached
      })
    }
    const dataEmitter = new BufferingEmitter<string>()
    const exitEmitter = new BufferingEmitter<PtyExitEvent>()
    const entry: PtyEntry = {
      key,
      computerId,
      sessionId,
      lastSeq: -1,
      pending: new Map(),
      backfilledAt: null,
      disposed: false,
      detached: false,
      sealed,
      dataEmitter,
      exitEmitter
    }
    sessions.set(key, entry)

    const send = (method: string, params: unknown): Promise<unknown> =>
      admitted
        ? admitted.then(() => gateway.request(computerId, method, params))
        : gateway.request(computerId, method, params)

    // `null`, not 0 — the pid is UNKNOWN until the computer replies, and a
    // placeholder that reads as a number invites callers to treat it as one.
    let pid: number | null = null
    const handle: PtyHandle = {
      get pid(): number | null {
        return pid
      },
      process: processName,
      onData: (listener: (data: string) => void): ExecDisposable => dataEmitter.on(listener),
      onExit: (
        cb: (e: { exitCode: number; signal?: number; reason?: string }) => void
      ): ExecDisposable =>
        exitEmitter.on((event) =>
          cb({
            exitCode: event.exitCode ?? 1,
            signal: typeof event.signal === 'number' ? event.signal : undefined,
            ...(event.reason ? { reason: event.reason } : {})
          })
        ),
      write: (data: string): void => {
        void send(HubToComputerMethods.ptyWrite, { sessionId, data }).catch(noop)
      },
      resize: (cols: number, rows: number): void => {
        void send(HubToComputerMethods.ptyResize, { sessionId, cols, rows }).catch(noop)
      },
      kill: (signal?: string): void => {
        if (entry.detached) {
          // Unreachable: the kill cannot be delivered, and the session must not be
          // resumed or re-spawned on reconnect either. So stop tracking it — the
          // reconnect sweep then ends the computer's copy as an orphan. Emits
          // nothing: the caller ending it already owns reporting that.
          entry.disposed = true
          entry.pendingSpawn = undefined
          sessions.delete(entry.key)
          return
        }
        void send(HubToComputerMethods.ptyKill, {
          sessionId,
          ...(signal ? { signal } : {})
        }).catch(noop)
      }
    }
    return { entry, handle, setPid: (next) => (pid = next) }
  }

  return {
    /**
     * Promote a warm session on `computerId` into a real one. No spawn happens —
     * the computer rekeys the existing process, so pid/buffer/seq all carry over.
     */
    async warmSpawn(
      computerId: string,
      spec: {
        warmId: string
        command: string
        args: string[]
        cwd: string
        env: Record<string, string>
        postSpawnCommand?: string
      }
    ) {
      // No session entry: a warm session has no hub-side identity yet, and the
      // computer streams nothing for it. It becomes routable at `adopt`.
      //
      // Timeout 0 (none): the computer starts a warm agent only once no task's
      // agent is starting (its admission queue's `warm` lane), which after a
      // workspace restore can take a while. A timeout would abandon a warm agent
      // the computer is about to start; a lost connection still rejects.
      const res = await gateway.request(computerId, HubToComputerMethods.ptyWarmSpawn, spec, 0)
      return ptyWarmSpawnResultSchema.parse(res)
    },

    prioritize(sessionId: string) {
      for (const entry of sessions.values()) {
        if (entry.sessionId === sessionId && !entry.disposed) entry.prioritize?.()
      }
    },

    async warmKill(computerId: string, warmId: string) {
      await gateway.request(computerId, HubToComputerMethods.ptyWarmKill, { warmId })
    },

    async warmList(computerId: string) {
      const res = await gateway.request(computerId, HubToComputerMethods.ptyWarmList, {})
      return ptyWarmListResultSchema.parse(res).warms
    },

    async adopt(computerId: string, warmId: string, sessionId: string, processName: string) {
      // Before anything is tracked: a refused adopt leaves no session behind.
      if (gate) await gate(computerId, { kind: 'session', id: sessionId })
      const { entry, handle, setPid } = register(computerId, sessionId, processName, true)
      try {
        const res = await gateway.request(computerId, HubToComputerMethods.ptyWarmAdopt, {
          warmId,
          sessionId
        })
        const parsed = ptyWarmAdoptResultSchema.parse(res)
        setPid(parsed.pid)
        // Seed BEFORE unsealing: everything the agent emitted while warm is
        // delivered first, then whatever queued up during the round-trip drains
        // on top of it, in seq order.
        if (parsed.data) entry.dataEmitter.emit(parsed.data)
        entry.lastSeq = parsed.seq
        entry.sealed = false
        drain(entry)
        return handle
      } catch (err) {
        finalize(entry, null, null, 'adopt-failed')
        throw err
      }
    },

    spawn(spec: PtySpawnSpec): PtyHandle | Promise<PtyHandle> {
      const computerId = resolveComputerId(spec)
      if (computerId == null)
        throw new NoComputerAvailableError(`terminal session ${spec.sessionId}`)

      // `pid` is null until the remote `pty.spawn` reply lands (remote ptys key by
      // sessionId, not pid). The handle exposes it via a getter so it stays a
      // valid `readonly pid` under the terminal `PtyHandle` seam. `onExit` adapts
      // the wider remote `PtyExitEvent` (exitCode may be null on signal death /
      // computer-loss; signal may be a string like 'computer-lost') to the seam's
      // `{ exitCode: number; signal?: number }` — lossless for pty-manager, which
      // only reads `exitCode`.
      // The gate's answer for this spawn's task. The handle still comes back
      // synchronously (pty-manager's local path needs that); the spawn request — and
      // any input written meanwhile — waits behind it, and a refusal rejects
      // `whenSpawned` without anything reaching the computer.
      const admitted = gate ? gate(computerId, { kind: 'task', id: spec.taskId }) : null
      const { entry, handle, setPid } = register(
        computerId,
        spec.sessionId,
        spec.file,
        false,
        admitted
      )

      // One key per spawn ATTEMPT, re-sent unchanged if the reply is lost — see
      // `spawnIdField` in frames.ts.
      const spawnId = randomUUID()
      entry.spawnId = spawnId
      // The startup deadline travels with the spawn: the computer sees the output
      // directly, so only it can tell a silent session from one whose output is
      // merely still in flight to a stalled hub.
      const requestsDeadline = spec.startupTimeoutMs !== undefined
      const params = {
        sessionId: spec.sessionId,
        spawnId,
        ...(requestsDeadline ? { startupTimeoutMs: spec.startupTimeoutMs } : {}),
        // An agent start waits on the computer for an admission slot; the reply
        // (and the computer's startup deadline) come when it has really started.
        ...(spec.admission ? { admission: spec.admission } : {}),
        command: spec.file,
        args: spec.args,
        // Send cwd only when there IS one — an empty string used to travel as a
        // "path" and land the agent in the computer's launch directory. Absent,
        // the computer resolves the project's own checkout from `projectId`,
        // which is the only side that knows where it is.
        ...(spec.options.cwd ? { cwd: spec.options.cwd } : {}),
        ...(spec.projectId ? { projectId: spec.projectId } : {}),
        env: spec.options.env,
        cols: spec.options.cols,
        rows: spec.options.rows
      }
      // Timeout 0 (none): latency here is unbounded in practice — a computer
      // restoring dozens of sessions at once, or one across a real network — and
      // whether the computer is still there is the heartbeat's question, not this
      // request's. A per-request deadline turned a slow spawn into a refused one.
      const requestSpawn = () =>
        gateway.request(computerId, HubToComputerMethods.ptySpawn, params, 0)
      if (spec.admission) {
        const requestPrioritize = () =>
          gateway.request(computerId, HubToComputerMethods.ptyPrioritize, {
            sessionId: spec.sessionId
          })
        // Behind the gate like the spawn itself, so it can never overtake it. A
        // computer that predates admission answers `unimplemented`: nothing to do.
        entry.prioritize = () => {
          void (admitted ? admitted.then(requestPrioritize) : requestPrioritize()).catch(noop)
        }
      }

      // Handed to the caller as `whenSpawned`: the round-trip IS the readiness
      // signal, so anything that needs to know the session really started awaits
      // this rather than sampling `pid` on a timer.
      const whenSpawned = new Promise<PtySpawnConfirmation>((resolve, reject) => {
        const confirm = (spawnedPid: number | null, ownsStartupDeadline: boolean): void => {
          entry.pendingSpawn = undefined
          // Started: nothing left to move up the admission queue.
          entry.prioritize = undefined
          setPid(spawnedPid)
          resolve({ pid: spawnedPid, ownsStartupDeadline })
        }
        const attempt = (): void => {
          void (admitted ? admitted.then(requestSpawn) : requestSpawn()).then(
            (res) => {
              const parsed = ptySpawnResultSchema.safeParse(res)
              confirm(
                parsed.success ? parsed.data.pid : null,
                requestsDeadline && parsed.success && parsed.data.startupDeadline === true
              )
            },
            (err: unknown) => {
              // Closed while its outcome was unknown: nothing tracks it any more.
              if (entry.disposed) return
              if (isConnectionLoss(err)) {
                // No verdict — the computer may already be running it. Keep the
                // session and settle it on reconnect (detach controller): resume
                // if the computer holds it, report its real exit if it reaped it,
                // send it again if it never arrived. Deliberately NOT a timer.
                entry.pendingSpawn = {
                  resend: attempt,
                  confirm: (listedPid, listedBySpawnId) =>
                    confirm(listedPid, requestsDeadline && listedBySpawnId)
                }
                // A disconnect already detached every entry it could see; this
                // one was sent after it, to a computer with no socket.
                if (!entry.detached) detach(entry)
                return
              }
              // The computer refused the spawn: finalize (which emits the exit
              // through the buffering emitter, so a not-yet-subscribed caller still
              // gets it) AND propagate, so a caller awaiting confirmation sees the
              // failure rather than a promise that never settles.
              finalize(entry, null, null, 'spawn-failed')
              reject(err)
            }
          )
        }
        attempt()
      })
      // Keep the rejection handled here too — `whenSpawned` is optional in the
      // seam, so a backend consumer that ignores it must not trip an unhandled
      // rejection. Attaching this does not consume it for anyone else.
      void whenSpawned.catch(noop)

      // Object.assign, NOT a spread: `pid` is a getter that tracks `setPid`, and
      // spreading would evaluate it once — freezing the handle's pid at its
      // pre-reply `null` for the life of the session.
      return Object.assign(handle, { whenSpawned })
    }
  }
}

// ===========================================================================
// Routing process backend
// ===========================================================================

export interface RoutingProcessBackendOptions {
  gateway: RoutingGateway
  /** Route a spawn to a computerId. `null` throws {@link NoComputerAvailableError}.
   *  Sync by necessity: the process manager's `doSpawn` is synchronous (also driven
   *  by restart timers), so it cannot await a reconnect. */
  resolveComputerId: (spec: ProcSpawnSpec) => string | null
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

interface ProcEntry extends DetachableEntry {
  key: string
  /** Highest contiguously-delivered stdout seq. Starts at **-1** for the same
   *  reason as {@link PtyEntry.lastSeq}: the computer's RingBuffer numbers its
   *  FIRST chunk 0, and `ingest` drops `seq <= lastSeq`, so a 0 here would
   *  silently discard the opening chunk of every routed session — which for a
   *  chat agent is its protocol handshake. */
  lastSeq: number
  /** Out-of-order stdout frames awaiting a gap fill (seq → data). */
  pending: Map<number, string>
  /** `lastSeq` the in-flight/last backfill was issued for; `null` = never. */
  backfilledAt: number | null
  disposed: boolean
  /** Computer unreachable, outcome unknown — see {@link createDetachController}. */
  detached: boolean
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
  const { gateway, resolveComputerId } = options
  const sessions = new Map<string, ProcEntry>()

  function finalize(entry: ProcEntry, code: number | null, signal: string | null): void {
    if (entry.disposed) return
    entry.disposed = true
    entry.pendingSpawn = undefined
    sessions.delete(entry.key)
    entry.exitEmitter.emit({ code, signal })
  }

  /** Deliver every parked stdout frame in seq order — the process is ending. */
  function flushPending(entry: ProcEntry): void {
    for (const seq of [...entry.pending.keys()].sort((a, b) => a - b)) {
      if (seq <= entry.lastSeq) continue
      entry.lastSeq = seq
      entry.dataEmitter.emit({ chunk: entry.pending.get(seq)!, stream: 'stdout' })
    }
    entry.pending.clear()
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
      // the missing seq is unrecoverable (evicted from the computer's ring buffer,
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
      const res = await gateway.request(entry.computerId, HubToComputerMethods.procGetBufferSince, {
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
    const entry = sessions.get(sessionKey(payload.computerId, payload.sessionId))
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
    const entry = sessions.get(sessionKey(payload.computerId, payload.sessionId))
    if (entry) finalize(entry, payload.exitCode, payload.signal ?? null)
  })
  const detach = joinDetachController<ProcEntry>({
    gateway,
    sessions,
    kind: 'process',
    listMethod: HubToComputerMethods.procList,
    killMethod: HubToComputerMethods.procKill,
    parseList: (raw) => {
      const parsed = procListResultSchema.safeParse(raw)
      return parsed.success ? toSessionList(parsed.data) : null
    },
    finalize: (entry, reason) => finalize(entry, null, reason),
    resume: (entry, listed) => {
      entry.detached = false
      entry.pendingSpawn?.confirm(listed.pid ?? null, listed.spawnId !== undefined)
      entry.backfilledAt = null
      void backfill(entry)
    },
    settleExited: (entry, exit) => {
      entry.pendingSpawn?.confirm(exit.pid ?? null, exit.spawnId !== undefined)
      entry.detached = false
      void (async () => {
        await backfill(entry)
        flushPending(entry)
        finalize(entry, exit.exitCode, exit.signal)
      })()
    }
  })

  return {
    spawn(spec: ProcSpawnSpec): ProcHandle {
      const computerId = resolveComputerId(spec)
      if (computerId == null) throw new NoComputerAvailableError(`process ${spec.id}`)

      const key = sessionKey(computerId, spec.id)
      const dataEmitter = new BufferingEmitter<{ chunk: string; stream: 'stdout' | 'stderr' }>()
      const exitEmitter = new BufferingEmitter<{ code: number | null; signal: string | null }>()
      const entry: ProcEntry = {
        key,
        computerId,
        sessionId: spec.id,
        lastSeq: -1,
        pending: new Map(),
        backfilledAt: null,
        disposed: false,
        detached: false,
        dataEmitter,
        exitEmitter
      }
      sessions.set(key, entry)

      let pid: number | undefined
      const handle = {
        get pid(): number | undefined {
          return pid
        },
        onData: (cb: (chunk: string, stream: 'stdout' | 'stderr') => void): ExecDisposable =>
          dataEmitter.on((v) => cb(v.chunk, v.stream)),
        onExit: (cb: (e: { code: number | null; signal: string | null }) => void): ExecDisposable =>
          exitEmitter.on(cb),
        /**
         * Write to the routed child's stdin. Beyond the `ProcessBackend` seam
         * (background processes never needed stdin), but the routed CHAT backend
         * built on this channel does — so the capability lives on the handle
         * rather than forcing callers to reach for the gateway directly.
         */
        write: (data: string): void => {
          void gateway
            .request(computerId, HubToComputerMethods.procWrite, { sessionId: spec.id, data })
            .catch(noop)
        },
        kill: (signal?: string): void => {
          if (entry.detached) {
            // Same rule as the pty handle: undeliverable now, and must not be
            // resumed or re-spawned later — stop tracking, the reconnect sweep
            // ends the computer's copy as an orphan.
            entry.disposed = true
            entry.pendingSpawn = undefined
            sessions.delete(entry.key)
            return
          }
          void gateway
            .request(computerId, HubToComputerMethods.procKill, {
              sessionId: spec.id,
              ...(signal ? { signal } : {})
            })
            .catch(noop)
        }
      }

      // Default: `ProcSpawnSpec.command` is a shell command STRING (e.g.
      // `pnpm dev`), so ask the computer to run it through a shell. `shell: true` —
      // NOT a hub-side `buildShellInvocation` — because that helper resolves the
      // HUB's `$SHELL`, a path that need not exist on the computer's machine (the
      // same hub-local assumption that makes `whichBinary` wrong for a routed
      // spawn). The computer wraps with ITS own shell. Overridable via
      // `buildSpawnParams` (the chat backend needs literal argv).
      const spawnId = randomUUID()
      entry.spawnId = spawnId
      const params = {
        ...(options.buildSpawnParams?.(spec) ?? {
          sessionId: spec.id,
          command: spec.command,
          shell: true,
          // Same rule as pty.spawn: an absent cwd lets the computer resolve the
          // project's checkout, rather than an empty string travelling as a path.
          ...(spec.cwd ? { cwd: spec.cwd } : {}),
          ...(spec.projectId ? { projectId: spec.projectId } : {}),
          env: spec.env
        }),
        // After the override: the idempotency key is the transport's, not the
        // caller's — see `spawnIdField` in frames.ts.
        spawnId
      }
      const setSpawnedPid = (next: number | null): void => {
        entry.pendingSpawn = undefined
        // `pid` is nullable on the wire (immediate spawn failure); the handle
        // exposes `number | undefined`, so map null → undefined.
        pid = next ?? undefined
      }
      // No request timeout, and a lost reply is UNKNOWN rather than failed — the
      // same rules and reasons as the pty spawn above.
      const attempt = (): void => {
        void gateway.request(computerId, HubToComputerMethods.procSpawn, params, 0).then(
          (res) => {
            const parsed = procSpawnResultSchema.safeParse(res)
            if (parsed.success) setSpawnedPid(parsed.data.pid)
            else entry.pendingSpawn = undefined
          },
          (err: unknown) => {
            if (entry.disposed) return
            if (isConnectionLoss(err)) {
              entry.pendingSpawn = {
                resend: attempt,
                confirm: (listedPid) => setSpawnedPid(listedPid)
              }
              if (!entry.detached) detach(entry)
              return
            }
            finalize(entry, null, 'spawn-failed')
          }
        )
      }
      attempt()

      return handle
    },
    // Crash-reap (process-manager.ts's reapStaleIfNeeded) is a local-backend-only
    // feature: it depends on inspecting/killing a bare OS pid, and a routed
    // session only ever exposes the computer's own sessionId/key, not one the hub
    // can act on independently. `getCommandLine` -> null is the same "can't
    // verify, so don't touch it" signal `localProcessBackend` returns on win32.
    getCommandLine(): Promise<string | null> {
      return Promise.resolve(null)
    },
    killByPid(): void {
      // Nothing to kill: same reasoning as `getCommandLine` above — the pid a
      // routed session reports belongs to the computer's machine, so the hub has
      // no process of its own to signal.
    }
  }
}

// ===========================================================================
// Routing chat backend
// ===========================================================================

export interface RoutingChatBackendOptions {
  gateway: RoutingGateway
  /** Route a spawn to a computerId. `null` throws {@link NoComputerAvailableError}. */
  resolveComputerId: (spec: ChatSpawnSpec) => string | null
  /** Asked before a spawn, for its task. */
  gate?: ComputerWorkGate
}

/**
 * A `ChatBackend` that forwards remote spawns over the gateway, so a chat-mode
 * agent runs on a computer exactly as a terminal-mode agent already does.
 *
 * Rides the SAME sequenced duplex `proc.*` channel as
 * {@link createRoutingProcessBackend} — no `chat.*` namespace. A chat agent is
 * just a child process whose stdout happens to be NDJSON; giving it a private
 * namespace would mean two wire contracts to keep ordered and duplex-correct.
 *
 * Line framing is NOT done here: raw chunks are handed to the transport, which
 * reassembles lines hub-side (`createLineSplitter`) and feeds its
 * `ChatSessionDriver`. So the computer stays a byte pipe and all protocol state —
 * handshake, request correlation — remains on the hub.
 */
export function createRoutingChatBackend(options: RoutingChatBackendOptions): ChatBackend {
  const { gateway, resolveComputerId, gate } = options

  return {
    async spawn(spec: ChatSpawnSpec): Promise<ChatProcHandle> {
      const computerId = resolveComputerId(spec)
      if (computerId == null) throw new NoComputerAvailableError(`chat agent ${spec.binaryName}`)
      if (gate) await gate(computerId, { kind: 'task', id: spec.taskId })

      const backend = createRoutingProcessBackend({
        gateway,
        resolveComputerId: () => computerId,
        // An agent spawn is a resolved binary + argv, NOT a shell string: `sh
        // <script>` must stay two argv entries. The default sender would set
        // `shell: true` and drop `args`, so the computer would hand the binary to a
        // shell and the agent would never receive its arguments.
        buildSpawnParams: (procSpec) => ({
          sessionId: procSpec.id,
          command: spec.binaryName,
          args: spec.args,
          // Same rule as pty/proc: absent rather than empty, so the computer
          // resolves the project's checkout instead of taking '' as a path.
          ...(spec.cwd ? { cwd: spec.cwd } : {}),
          ...(spec.projectId ? { projectId: spec.projectId } : {}),
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
        computerId,
        // The binary NAME, resolved against the COMPUTER's PATH — never a
        // hub-resolved absolute path, which would not exist there. `shell` is
        // deliberately unset: argv must reach execve unsplit.
        command: spec.binaryName,
        args: spec.args,
        cwd: spec.cwd,
        env: spec.env
      } as never)

      // A routed spawn has no kernel `'spawn'` event. The remote `proc.spawn`
      // reply is the equivalent readiness signal — it means the computer has a pid
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
            return {
              dispose: () => {
                // The replay is already queued and `cb` was never added to
                // `spawnCbs`, so there is no subscription left to tear down.
              }
            }
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
        write: (data) => (procHandle as unknown as { write?: (d: string) => void }).write?.(data),
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
   *  state and never routed — every other method requires a computer. */
  /** In-process adapters. Used ONLY for the ops that are hub-owned by design —
   *  worktree colors and the `<ROOT>/storage` artifact paths (see
   *  docs/exec-boundary.md). Every workspace op requires a computer. */
  local: Pick<
    WorktreeExecAdapters,
    'getWorktreeColor' | 'ensureProjectWorktreeColors' | 'hubPathExists' | 'removeArtifactDir'
  >
  /**
   * The computer a given TASK's worktree work belongs to, or null for hub-local.
   * Takes the taskId because that is the only thing a computer can be resolved
   * from (`resolveTaskComputerId`). Previously argument-less, which is why the
   * composition root had to pin it to `() => null` and every method degraded to
   * local — so a task whose agent ran on a computer got its worktree on the hub.
   */
  resolveComputerId: (taskId: string) => string | null | Promise<string | null>
  /** Asked before every routed op, for its task. */
  gate?: ComputerWorkGate
}

/**
 * A COMPLETE `WorktreeExecAdapters` that forwards git/fs work to a computer.
 * `getWorktreeColor` (SYNC) and `ensureProjectWorktreeColors` are always served
 * by `local` — worktree colors are hub-local UI state, and a sync getter cannot
 * be a network call (documented cosmetic degradation for remote worktrees).
 * When `resolveComputerId()` is null every method degrades to `local`.
 */
export function createRemoteWorktreeAdapters(
  options: RemoteWorktreeAdaptersOptions
): WorktreeExecAdapters {
  const { gateway, local, gate } = options
  /** The task's computer, admitted by the gate before any op reaches it. */
  const resolveComputerId = async (taskId: string): Promise<string | null> => {
    const computerId = await options.resolveComputerId(taskId)
    if (computerId != null && gate) await gate(computerId, { kind: 'task', id: taskId })
    return computerId
  }

  return {
    async createWorktree(taskId, repoPath, worktreePath, branch, sourceBranch) {
      const computerId = await resolveComputerId(taskId)
      if (computerId == null)
        throw new NoComputerAvailableError(`worktree create for task ${taskId}`)
      await gateway.request(computerId, HubToComputerMethods.gitCreateWorktree, {
        repoPath,
        worktreePath,
        branch,
        sourceBranch
      })
    },

    async removeWorktree(taskId, projectPath, worktreePath) {
      const computerId = await resolveComputerId(taskId)
      if (computerId == null)
        throw new NoComputerAvailableError(`worktree remove for task ${taskId}`)
      const res = await gateway.request(computerId, HubToComputerMethods.gitRemoveWorktree, {
        projectPath,
        worktreePath
      })
      return gitRemoveWorktreeResultSchema.parse(res)
    },

    async runWorktreeSetupScript(taskId, worktreePath, repoPath, sourceBranch) {
      const computerId = await resolveComputerId(taskId)
      if (computerId == null)
        throw new NoComputerAvailableError(`worktree setup for task ${taskId}`)
      const res = await gateway.request(
        computerId,
        HubToComputerMethods.gitRunWorktreeSetupScript,
        {
          worktreePath,
          repoPath,
          sourceBranch
        }
      )
      return gitRunWorktreeSetupScriptResultSchema.parse(res)
    },

    async copyIgnoredFiles(taskId, repoPath, worktreePath, behavior, customPaths) {
      const computerId = await resolveComputerId(taskId)
      if (computerId == null)
        throw new NoComputerAvailableError(`ignored-file copy for task ${taskId}`)
      await gateway.request(computerId, HubToComputerMethods.gitCopyIgnoredFiles, {
        repoPath,
        worktreePath,
        behavior,
        customPaths
      })
    },

    async getCurrentBranch(taskId, repoPath) {
      const computerId = await resolveComputerId(taskId)
      if (computerId == null)
        throw new NoComputerAvailableError(`git branch read for task ${taskId}`)
      const res = await gateway.request(computerId, HubToComputerMethods.gitGetCurrentBranch, {
        repoPath
      })
      return gitGetCurrentBranchResultSchema.parse(res).branch
    },

    async isGitRepo(taskId, path) {
      const computerId = await resolveComputerId(taskId)
      if (computerId == null)
        throw new NoComputerAvailableError(`git repo probe for task ${taskId}`)
      const res = await gateway.request(computerId, HubToComputerMethods.gitIsGitRepo, { path })
      return gitIsGitRepoResultSchema.parse(res).isGitRepo
    },

    // SYNC + hub-local: worktree colors are UI state; cannot be a network call.
    getWorktreeColor(projectPath, worktreePath) {
      return local.getWorktreeColor(projectPath, worktreePath)
    },

    ensureProjectWorktreeColors(projectPath) {
      return local.ensureProjectWorktreeColors(projectPath)
    },

    // WORKSPACE path probe → routed (the workspace lives on the computer).
    async pathExists(taskId, path) {
      const computerId = await resolveComputerId(taskId)
      if (computerId == null) throw new NoComputerAvailableError(`path probe for task ${taskId}`)
      const res = await gateway.request(computerId, HubToComputerMethods.fsPathExists, { path })
      return fsPathExistsResultSchema.parse(res).exists
    },

    // HUB-storage ops: always local, never routed, and never require a computer.
    // Artifacts live under the hub's own <ROOT>/storage — that directory does not
    // exist on a computer, and routing these made archiving a task impossible
    // whenever no computer was connected.
    hubPathExists(absPath) {
      return local.hubPathExists(absPath)
    },

    removeArtifactDir(absDir) {
      return local.removeArtifactDir(absDir)
    }
  }
}

// ===========================================================================
// Workspace filesystem adapters
// ===========================================================================

export interface RemoteFsAdaptersOptions {
  gateway: RoutingGateway
  /**
   * In-process filesystem, used ONLY when `computerId` is null — i.e. this hub has
   * no computer to ask. See the note on `WorkspaceFsAdapters`: that is a boundary
   * condition (standalone/fork sidecar, or before the local computer enrolls), not
   * a preference for the hub's disk. Whenever a computer is connected the caller's
   * resolver returns it and nothing here touches local. On a hub with
   * `SLAYZONE_HUB_ENABLE_PROCESSES=0` every `createLocalWorkspaceFs` op refuses
   * (`NO_COMPUTER_CONNECTED`), so there the null branch is "connect a computer".
   */
  local: LocalWorkspaceFs
  /** Mint a correlation id for a watch. Injected so tests are deterministic. */
  newWatchId?: () => string
  /**
   * Asked before every op that reaches a computer, as the caller's own request
   * (`work: null`): these take a computer, not a task. The hub's own maintenance on
   * connect (widening the local computer's roots, seeding its paths) uses an
   * instance without one.
   */
  gate?: ComputerWorkGate
}

let watchSeq = 0

/**
 * `WorkspaceFsAdapters` that forward filesystem work to a computer's `fs.*` frames.
 *
 * Every method takes the computer explicitly rather than deriving it from a taskId
 * (as the worktree adapters do). The directory picker is the reason: it has to
 * describe a machine's disk BEFORE a project — let alone a task — exists, so
 * there is nothing to resolve from. Callers that do have a task resolve it once,
 * with the same `resolveExecComputer` the pty backend uses, and pass the result.
 */
export function createRemoteFsAdapters(options: RemoteFsAdaptersOptions): WorkspaceFsAdapters {
  const { gateway, local, gate } = options
  const newWatchId = options.newWatchId ?? (() => `w${++watchSeq}`)

  const req = async <T>(
    computerId: string,
    method: string,
    params: unknown,
    schema: { parse: (v: unknown) => T }
  ): Promise<T> => {
    if (gate) await gate(computerId, null)
    return gateway.request(computerId, method, params).then((res) => schema.parse(res))
  }

  return {
    async listRoots(computerId) {
      if (computerId == null) return local.listRoots()
      return req(computerId, HubToComputerMethods.fsListRoots, {}, fsListRootsResultSchema)
    },

    async listDir(computerId, path, opts) {
      if (computerId == null) return local.listDir(path, opts)
      return req(
        computerId,
        HubToComputerMethods.fsListDir,
        { path, dirsOnly: opts?.dirsOnly, includeHidden: opts?.includeHidden },
        fsListDirResultSchema
      )
    },

    async mkdir(computerId, path) {
      if (computerId == null) return local.mkdir(path)
      return req(computerId, HubToComputerMethods.fsMkdir, { path }, fsMkdirResultSchema)
    },

    async pathExists(computerId, path) {
      if (computerId == null) return local.pathExists(path)
      const res = await req(
        computerId,
        HubToComputerMethods.fsPathExists,
        { path },
        fsPathExistsResultSchema
      )
      return res.exists
    },

    async setAllowedRoots(computerId, roots) {
      if (computerId == null) return local.setAllowedRoots(roots)
      return req(
        computerId,
        HubToComputerMethods.computerSetAllowedRoots,
        { roots },
        computerSetAllowedRootsResultSchema
      )
    },

    async resolveProjectPath(computerId, projectId) {
      if (computerId == null) return local.resolveProjectPath(projectId)
      return req(
        computerId,
        HubToComputerMethods.projectResolvePath,
        { projectId },
        projectResolvePathResultSchema
      )
    },

    async setProjectPath(computerId, projectId, path) {
      if (computerId == null) return local.setProjectPath(projectId, path)
      return req(
        computerId,
        HubToComputerMethods.projectSetPath,
        { projectId, path },
        projectSetPathResultSchema
      )
    },

    async forgetProjectPath(computerId, projectId) {
      if (computerId == null) return local.forgetProjectPath(projectId)
      await req(computerId, HubToComputerMethods.projectForgetPath, { projectId }, fsOkResultSchema)
    },

    async discoverRepos(computerId, rootPath, maxDepth) {
      if (computerId == null) return local.discoverRepos(rootPath, maxDepth)
      const res = await req(
        computerId,
        HubToComputerMethods.fsDiscoverRepos,
        { rootPath, maxDepth },
        fsDiscoverReposResultSchema
      )
      return res.repos
    },

    async readDir(computerId, rootPath, dirPath) {
      if (computerId == null) return local.readDir(rootPath, dirPath)
      const res = await req(
        computerId,
        HubToComputerMethods.fsReadDir,
        { rootPath, dirPath },
        fsReadDirResultSchema
      )
      return res.entries
    },

    async readFile(computerId, rootPath, filePath, force) {
      if (computerId == null) return local.readFile(rootPath, filePath, force)
      return req(
        computerId,
        HubToComputerMethods.fsReadFile,
        { rootPath, filePath, force },
        fsReadFileResultSchema
      )
    },

    async writeFile(computerId, rootPath, filePath, content) {
      if (computerId == null) return local.writeFile(rootPath, filePath, content)
      await req(
        computerId,
        HubToComputerMethods.fsWriteFile,
        { rootPath, filePath, content },
        fsOkResultSchema
      )
    },

    async createFile(computerId, rootPath, filePath) {
      if (computerId == null) return local.createFile(rootPath, filePath)
      await req(
        computerId,
        HubToComputerMethods.fsCreateFile,
        { rootPath, filePath },
        fsOkResultSchema
      )
    },

    async createDir(computerId, rootPath, dirPath) {
      if (computerId == null) return local.createDir(rootPath, dirPath)
      await req(
        computerId,
        HubToComputerMethods.fsCreateDir,
        { rootPath, dirPath },
        fsOkResultSchema
      )
    },

    async rename(computerId, rootPath, oldPath, newPath) {
      if (computerId == null) return local.rename(rootPath, oldPath, newPath)
      await req(
        computerId,
        HubToComputerMethods.fsRename,
        { rootPath, oldPath, newPath },
        fsOkResultSchema
      )
    },

    async delete(computerId, rootPath, targetPath) {
      if (computerId == null) return local.delete(rootPath, targetPath)
      await req(
        computerId,
        HubToComputerMethods.fsDelete,
        { rootPath, targetPath },
        fsOkResultSchema
      )
    },

    async copyIn(computerId, rootPath, absoluteSrc, targetDir) {
      if (computerId == null) return local.copyIn(rootPath, absoluteSrc, targetDir)
      const res = await req(
        computerId,
        HubToComputerMethods.fsCopyIn,
        { rootPath, absoluteSrc, targetDir },
        fsCopyInResultSchema
      )
      return res.path
    },

    async copy(computerId, rootPath, srcPath, destPath) {
      if (computerId == null) return local.copy(rootPath, srcPath, destPath)
      await req(
        computerId,
        HubToComputerMethods.fsCopy,
        { rootPath, srcPath, destPath },
        fsOkResultSchema
      )
    },

    async gitStatus(computerId, rootPath) {
      if (computerId == null) return local.gitStatus(rootPath)
      return req(
        computerId,
        HubToComputerMethods.fsGitStatus,
        { rootPath },
        fsGitStatusResultSchema
      )
    },

    async searchFiles(computerId, rootPath, query, opts) {
      if (computerId == null) return local.searchFiles(rootPath, query, opts)
      return req(
        computerId,
        HubToComputerMethods.fsSearchFiles,
        { rootPath, query, options: opts },
        fsSearchFilesResultSchema
      )
    },

    async listAllFiles(computerId, rootPath) {
      if (computerId == null) return local.listAllFiles(rootPath)
      return req(
        computerId,
        HubToComputerMethods.fsListAllFiles,
        { rootPath },
        fsListAllFilesResultSchema
      )
    },

    /**
     * Routed watch.
     *
     * Returns its disposer SYNCHRONOUSLY (callers are tRPC `observable()` bodies,
     * which must hand back a teardown before any await) while the `fs.watchStart`
     * round-trip runs in the background. Disposing before that lands sets
     * `stopped`, so the late `then` sends `fs.watchStop` immediately instead of
     * leaving an orphan watcher running on the computer forever.
     *
     * A computer disconnect COMPLETES the stream rather than silently going quiet:
     * the client must learn its view may be stale and resubscribe, and a watcher
     * that stops emitting is indistinguishable from a directory that stopped
     * changing.
     */
    watch(computerId, rootPath, listener) {
      if (computerId == null) return local.watch(rootPath, listener)

      const watchId = newWatchId()
      let stopped = false

      const onChange = (e: {
        computerId: string
        watchId: string
        type: 'changed' | 'deleted'
        relPath: string
      }): void => {
        if (e.computerId !== computerId || e.watchId !== watchId) return
        listener({ type: e.type, root: rootPath, relPath: e.relPath })
      }
      const onDisconnected = (e: { computerId: string }): void => {
        if (e.computerId === computerId) stop()
      }

      gateway.events.on('fs.change', onChange)
      gateway.events.on('computer-disconnected', onDisconnected)
      gateway.events.on('computer-lost', onDisconnected)

      // A refused watch never starts (recorded like any other failure below), and its
      // stop is never sent either: nothing reaches a computer the gate refused.
      const admitted = gate ? gate(computerId, null) : null
      const start = () =>
        gateway.request(computerId, HubToComputerMethods.fsWatchStart, { watchId, rootPath })
      void (admitted ? admitted.then(start) : start())
        .then(() => {
          if (stopped) {
            void gateway
              .request(computerId, HubToComputerMethods.fsWatchStop, { watchId })
              .catch(() => {
                /* computer gone — its watcher died with the connection */
              })
          }
        })
        .catch((err) => {
          recordDiagnosticEvent({
            level: 'warn',
            source: 'server',
            event: 'fs.watch_start_failed',
            message: err instanceof Error ? err.message : String(err),
            payload: { computerId, rootPath }
          })
        })

      function stop(): void {
        if (stopped) return
        stopped = true
        gateway.events.off('fs.change', onChange)
        gateway.events.off('computer-disconnected', onDisconnected)
        gateway.events.off('computer-lost', onDisconnected)
        const sendStop = () =>
          gateway.request(computerId!, HubToComputerMethods.fsWatchStop, { watchId })
        void (admitted ? admitted.then(sendStop) : sendStop()).catch(() => {
          /* already gone, or never admitted */
        })
      }
      return stop
    }
  }
}
