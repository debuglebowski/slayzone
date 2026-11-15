/**
 * Detach / reattach across a dropped computer connection — the controller both
 * routing backends (pty, proc) join. Internal to the transport's server side: the
 * barrel does not re-export it; `exec-proxies.ts` is its only production user.
 *
 * @module computer-transport/server/detach-controller
 */

import { recordDiagnosticEvent } from '@slayzone/diagnostics/server'
import type { PtyDetectedSnapshot } from '../shared/frames'
import type { HubComputerGateway } from './hub-gateway'

/** The gateway slice the controller needs (the routing backends' `RoutingGateway`). */
type DetachGateway = Pick<HubComputerGateway, 'request' | 'events' | 'listComputers'>

const noop = (): void => {
  /* intentionally empty */
}

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
 * {@link joinDetachController}), so this only ever fires when nothing better
 * was available.
 */
export const DETACH_GRACE_MS = 10 * 60_000

/**
 * How long the hub remembers giving up on a session the computer may still run.
 * A computer away longer than this comes back with such a session KEPT: a leaked
 * process is the lesser harm than a kill on stale evidence.
 */
export const ABANDONED_TTL_MS = 24 * 60 * 60_000

/** Abandoned-attempt records kept per computer; the oldest go first past it. */
export const ABANDONED_MAX_PER_COMPUTER = 1_000

/** Session ids listed in one diagnostic event, at most. */
const DIAGNOSTIC_IDS_MAX = 50

/** The entry shape the detach controller needs, common to pty and proc. */
export interface DetachableEntry {
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
  /**
   * The spawn (or adopt) request is out and its reply not yet in. The computer
   * replaces any older attempt under this session id itself when it lands, so the
   * sweep never touches the id meanwhile: a kill racing that replacement would end
   * it through the computer's kill path (which forgets the session's saved history).
   */
  spawnInFlight?: boolean
}

export interface PendingSpawn {
  /** Re-issue the identical request. Same `spawnId`, so a duplicate is harmless. */
  resend: () => void
  /**
   * The computer holds (or held) this attempt: settle the spawn with its pid.
   * `listedBySpawnId` — the computer named the attempt by its key, i.e. it is new
   * enough to have honoured everything the request asked of it.
   */
  confirm: (pid: number | null, listedBySpawnId: boolean, listed?: ListedSession) => void
}

/** A live session as the computer reports it in `pty.list` / `proc.list`. */
export interface ListedSession {
  pid?: number
  spawnId?: string
  /** Highest seq the computer assigned; -1 when nothing yet (`pty.list` only). */
  seq?: number
  /** The computer runs output detection for it (`pty.list` only). */
  detection?: boolean
  /** What it has detected so far (`pty.list` only). */
  detected?: PtyDetectedSnapshot
  /** The mode its detection runs as (`pty.list`, newer computers only). */
  mode?: string
  /** When its process started, ms epoch (`pty.list`, newer computers only). */
  startedAt?: number
  /** A later attempt took the process over (`pty.adopt` / `adoptLive`; `pty.list` only). */
  adopted?: boolean
}

/** A session the computer reaped and remembers (a tombstone). */
export interface ListedExit extends ListedSession {
  exitCode: number | null
  signal: string | null
  reason?: string
}

/** The computer's own account of what it holds, keyed by session id. */
export interface ComputerSessionList {
  live: Map<string, ListedSession>
  /** Empty for a computer too old to keep tombstones. */
  exited: Map<string, ListedExit>
}

/**
 * Is a listed process this attempt, not merely the same session id?
 *
 * Session ids repeat — an agent tab reuses its id on every restart — so an older
 * process can be listed under the id a newer spawn is waiting on. An unknown key on
 * either side (an older computer, or an entry that never had one) counts as a
 * match: presence is then the strongest evidence available, as it always was.
 */
export function sameAttempt(entry: { spawnId?: string }, listed: { spawnId?: string }): boolean {
  return (
    entry.spawnId === undefined || listed.spawnId === undefined || entry.spawnId === listed.spawnId
  )
}

/** Build {@link ComputerSessionList} from a parsed `pty.list` / `proc.list` reply. */
export function toSessionList(parsed: {
  sessions: Array<{
    sessionId: string
    pid?: number
    spawnId?: string
    seq?: number
    detection?: boolean
    detected?: PtyDetectedSnapshot
    mode?: string
    startedAt?: number
    adopted?: boolean
  }>
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
    live: new Map(
      parsed.sessions.map((s) => [
        s.sessionId,
        {
          pid: s.pid,
          spawnId: s.spawnId,
          ...(s.seq !== undefined ? { seq: s.seq } : {}),
          ...(s.detection ? { detection: true } : {}),
          ...(s.detected ? { detected: s.detected } : {}),
          ...(s.mode ? { mode: s.mode } : {}),
          ...(s.startedAt !== undefined ? { startedAt: s.startedAt } : {}),
          ...(s.adopted ? { adopted: true } : {})
        }
      ])
    ),
    exited: new Map((parsed.exited ?? []).map((e) => [e.sessionId, e]))
  }
}

/**
 * Asked for a session the computer holds that nothing here tracks: does the hub's
 * own record PROVE its owner gone (its task deleted, its tab closed …)? Resolves
 * the reason when it does, `null` when it does not or cannot tell. A rejection is
 * "cannot tell". Supplied by the hub, which owns that record.
 */
export type OwnerGoneProbe = (computerId: string, sessionId: string) => Promise<string | null>

export interface DetachControllerOptions<E extends DetachableEntry> {
  gateway: DetachGateway
  /** The backend's live session map (keyed by `sessionKey`). */
  sessions: Map<string, E>
  /** `terminal` / `process` — diagnostics and log text only. */
  kind: string
  /** Hub→computer method listing the sessions the computer still holds. */
  listMethod: string
  /** Hub→computer method ending one session, for one this hub gave up on. */
  killMethod: string
  /** Parse that reply; `null` when it does not parse. */
  parseList: (raw: unknown) => ComputerSessionList | null
  /** Report a session as ended, with the reason the hub let go of it. */
  finalize: (entry: E, reason: string) => void
  /** Computer confirmed this session is still alive: resume delivery + backfill. */
  resume: (entry: E, listed: ListedSession) => void
  /** Computer reaped this session while the hub was away: deliver its tail + real exit. */
  settleExited: (entry: E, exit: ListedExit) => void
  /** The computer went away with this session live: its outcome is now unknown. */
  onDetach?: (entry: E) => void
  /**
   * A session this backend does not track but its owner still holds (a run the
   * process manager adopted after a hub restart): never swept.
   */
  keepUntracked?: (computerId: string, sessionId: string) => boolean
  /** See {@link OwnerGoneProbe}. Absent: an untracked session is never ended on it. */
  ownerGone?: OwnerGoneProbe
  /**
   * After every list of the computer (first contact, same-epoch reconnect): the live
   * sessions it holds that the sweep KEPT — tracked by nothing here, no record of
   * giving up on them, owner not proven gone. A previous hub run's, typically: what a
   * participant may adopt so a hub restart is invisible to them. Called with the
   * complete set each time (empty included), and with an empty set when the
   * computer comes back as a different process (the old ones went with it).
   */
  onUntracked?: (computerId: string, epoch: string | undefined, kept: UntrackedListed[]) => void
}

/** A live session the computer holds that nothing here tracks (see `onUntracked`). */
export interface UntrackedListed {
  sessionId: string
  listed: ListedSession
}

/**
 * A backend's membership in its (gateway, kind) controller.
 *
 * Membership is EXPLICIT: a participant leaves when its owner is disposed, never
 * because its session map happens to be empty. (It used to be inferred: an emptied
 * map counted as "finished", which dropped the one long-lived terminal backend
 * after any blip with no terminal open — and every live pty with it, see
 * {@link joinDetachController}.)
 */
export interface DetachMembership {
  /**
   * Mark one entry detached outside a computer-wide disconnect: a spawn whose
   * request was refused for want of a socket. The computer-wide detach already
   * covers every entry it can see; this covers one registered after it.
   */
  detach: (entry: DetachableEntry) => void
  /**
   * This hub gave up on `entry` while the computer may still run it (closed while
   * the computer was unreachable, an adopt that failed). Recorded, so a later
   * reconnect that lists that attempt ends it. The only way, besides the grace
   * expiry and a superseding attempt, that a sweep ever kills.
   */
  abandon: (entry: DetachableEntry, reason: string) => void
  /** The owner is disposed: stop participating. Its live entries count as abandoned. */
  leave: () => void
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
 * ── The sweep: positive evidence only ───────────────────────────────────────
 * The same rule holds the other way round. A session the computer lists that
 * nothing here tracks is NOT evidence it should die: "unknown to me" is what a
 * restarted hub, a pruned participant, or any bookkeeping bug looks like too.
 * (2026-11-14: a participant pruned on an empty map made every live pty
 * "unknown"; the next blip SIGHUP-ed 31 agents.) A session is ended only when:
 *
 *   - this hub RECORDED giving up on that attempt (grace expiry, closed while
 *     unreachable, failed adopt, owner left) — see {@link DetachMembership.abandon};
 *   - this hub's own different attempt holds that session id (`superseded`);
 *   - the hub's database proves its owner gone — {@link OwnerGoneProbe}.
 *
 * Every such kill is recorded (`computer.strays_killed`); untracked sessions it
 * keeps are recorded too, so the decision is legible either way.
 *
 * ── One controller per (gateway, kind), not per backend ─────────────────────
 * Callers JOIN the controller for their (gateway, kind) and contribute a
 * participant; the gateway listeners and the reconnect round-trip are wired
 * exactly once, however many backends join.
 */
interface DetachParticipant {
  sessions: Map<string, DetachableEntry>
  finalize: (entry: DetachableEntry, reason: string) => void
  resume: (entry: DetachableEntry, listed: ListedSession) => void
  settleExited: (entry: DetachableEntry, exit: ListedExit) => void
  onDetach?: (entry: DetachableEntry) => void
  keepUntracked?: (computerId: string, sessionId: string) => boolean
  ownerGone?: OwnerGoneProbe
  onUntracked?: (computerId: string, epoch: string | undefined, kept: UntrackedListed[]) => void
}

/** An attempt this hub gave up on while the computer may still run it. */
interface AbandonedAttempt {
  spawnId?: string
  reason: string
  at: number
}

interface DetachController {
  join: (participant: DetachParticipant) => DetachMembership
  stats: () => DetachControllerStats
}

export interface DetachControllerStats {
  kind: string
  participants: number
  abandonedRecords: number
}

/** Live controllers, keyed by gateway then by kind. Weak so a discarded hub's go too. */
const detachControllers = new WeakMap<DetachGateway, Map<string, DetachController>>()

/** Join the (gateway, kind) controller, creating it on first use. */
export function joinDetachController<E extends DetachableEntry>(
  options: DetachControllerOptions<E>
): DetachMembership {
  const participant: DetachParticipant = {
    sessions: options.sessions as Map<string, DetachableEntry>,
    finalize: options.finalize as DetachParticipant['finalize'],
    resume: options.resume as DetachParticipant['resume'],
    settleExited: options.settleExited as DetachParticipant['settleExited'],
    ...(options.onDetach ? { onDetach: options.onDetach as DetachParticipant['onDetach'] } : {}),
    ...(options.keepUntracked ? { keepUntracked: options.keepUntracked } : {}),
    ...(options.ownerGone ? { ownerGone: options.ownerGone } : {}),
    ...(options.onUntracked ? { onUntracked: options.onUntracked } : {})
  }

  let byKind = detachControllers.get(options.gateway)
  if (!byKind) {
    byKind = new Map()
    detachControllers.set(options.gateway, byKind)
  }
  let controller = byKind.get(options.kind)
  if (!controller) {
    controller = createDetachController(options)
    byKind.set(options.kind, controller)
  }
  return controller.join(participant)
}

/**
 * The controllers on `gateway` and their bookkeeping size. For tests and
 * diagnostics proving it stays bounded; not re-exported from the barrel.
 */
export function detachControllerStats(gateway: DetachGateway): DetachControllerStats[] {
  return [...(detachControllers.get(gateway)?.values() ?? [])].map((c) => c.stats())
}

function createDetachController<E extends DetachableEntry>(
  options: DetachControllerOptions<E>
): DetachController {
  const { gateway, kind, listMethod, killMethod, parseList } = options
  const participants: DetachParticipant[] = []
  /**
   * Epoch seen on each computer's LAST connect — the baseline a reconnect is
   * compared against. Seeded from the roster because a controller can be built
   * after the computer already connected, and a missing baseline is
   * indistinguishable from a restart, which would finalize live sessions.
   */
  const epochByComputer = new Map<string, string | undefined>(
    gateway.listComputers().map((r) => [r.computerId, r.epoch] as const)
  )
  const graceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** computerId → sessionId → attempts given up on. Bounded: see `pruneAbandoned`. */
  const abandoned = new Map<string, Map<string, AbandonedAttempt[]>>()

  /** An entry together with the participant that owns (and can finalize) it. */
  interface Owned {
    entry: DetachableEntry
    owner: DetachParticipant
  }

  const liveEntries = (computerId: string): Owned[] =>
    participants.flatMap((owner) =>
      [...owner.sessions.values()]
        .filter((e) => e.computerId === computerId && !e.disposed)
        .map((entry) => ({ entry, owner }))
    )

  // ── Abandoned-attempt records ────────────────────────────────────────────

  function abandonedCount(computerId?: string): number {
    let n = 0
    for (const [id, bySession] of abandoned) {
      if (computerId !== undefined && id !== computerId) continue
      for (const list of bySession.values()) n += list.length
    }
    return n
  }

  /** Drop records past their TTL, everywhere; then cap `computerId`'s, oldest first. */
  function pruneAbandoned(computerId?: string): void {
    const cutoff = Date.now() - ABANDONED_TTL_MS
    for (const [id, bySession] of abandoned) {
      for (const [sessionId, list] of bySession) {
        const fresh = list.filter((a) => a.at >= cutoff)
        if (fresh.length === 0) bySession.delete(sessionId)
        else if (fresh.length !== list.length) bySession.set(sessionId, fresh)
      }
      if (bySession.size === 0) abandoned.delete(id)
    }
    if (computerId === undefined) return
    const bySession = abandoned.get(computerId)
    if (!bySession) return
    let excess = abandonedCount(computerId) - ABANDONED_MAX_PER_COMPUTER
    while (excess > 0) {
      let oldest: { sessionId: string; index: number; at: number } | null = null
      for (const [sessionId, list] of bySession) {
        list.forEach((a, index) => {
          if (!oldest || a.at < oldest.at) oldest = { sessionId, index, at: a.at }
        })
      }
      if (!oldest) break
      const { sessionId, index } = oldest as { sessionId: string; index: number }
      const list = bySession.get(sessionId)!
      list.splice(index, 1)
      if (list.length === 0) bySession.delete(sessionId)
      excess--
    }
    if (bySession.size === 0) abandoned.delete(computerId)
  }

  function recordAbandoned(entry: DetachableEntry, reason: string): void {
    let bySession = abandoned.get(entry.computerId)
    if (!bySession) {
      bySession = new Map()
      abandoned.set(entry.computerId, bySession)
    }
    const list = (bySession.get(entry.sessionId) ?? []).filter((a) => a.spawnId !== entry.spawnId)
    list.push({ ...(entry.spawnId ? { spawnId: entry.spawnId } : {}), reason, at: Date.now() })
    bySession.set(entry.sessionId, list)
    pruneAbandoned(entry.computerId)
  }

  /** Why this hub gave up on the listed attempt, or null if it never did. */
  function abandonedReason(
    computerId: string,
    sessionId: string,
    running: ListedSession
  ): string | null {
    const list = abandoned.get(computerId)?.get(sessionId)
    if (!list) return null
    for (let i = list.length - 1; i >= 0; i--) {
      if (sameAttempt(list[i]!, running)) return list[i]!.reason
    }
    return null
  }

  /**
   * Keep only records the computer still backs: an attempt it no longer lists live
   * has ended (or been replaced) and can never need a kill again.
   */
  function reconcileAbandoned(computerId: string, listed: ComputerSessionList): void {
    const bySession = abandoned.get(computerId)
    if (bySession) {
      for (const [sessionId, list] of bySession) {
        const running = listed.live.get(sessionId)
        const still = running ? list.filter((a) => sameAttempt(a, running)) : []
        if (still.length === 0) bySession.delete(sessionId)
        else if (still.length !== list.length) bySession.set(sessionId, still)
      }
      if (bySession.size === 0) abandoned.delete(computerId)
    }
    pruneAbandoned()
  }

  // ── Untracked sessions: offered for adoption ─────────────────────────────

  /** Hand the participants that adopt the computer's untracked sessions the full set. */
  function offerUntracked(
    computerId: string,
    epoch: string | undefined,
    kept: UntrackedListed[]
  ): void {
    for (const p of participants) {
      if (!p.onUntracked) continue
      try {
        p.onUntracked(computerId, epoch, kept)
      } catch {
        /* one participant's failure must not stop the reconnect */
      }
    }
  }

  // ── Grace window ─────────────────────────────────────────────────────────

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
      for (const o of stranded) {
        // The hub stops tracking it; the computer may well still run it. Recorded,
        // so a later reconnect that lists it ends it rather than leaving an agent
        // running against no task.
        recordAbandoned(o.entry, 'reattach-timeout')
        o.owner.finalize(o.entry, 'reattach-timeout')
      }
      record('computer.sessions_dropped', 'error', stranded, computerId, {
        message:
          `Computer unreachable for ${String(Math.round(DETACH_GRACE_MS / 60_000))} minutes — ` +
          `${String(stranded.length)} ${kind} session(s) dropped. The hub has stopped tracking ` +
          'them; if the computer comes back still running them, they are ended then.'
      })
    }, DETACH_GRACE_MS)
    timer.unref?.()
    graceTimers.set(computerId, timer)
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────

  function emit(
    event: string,
    level: 'info' | 'warn' | 'error',
    computerId: string,
    sessionIds: string[],
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
          sessionCount: sessionIds.length,
          sessionIds: sessionIds.slice(0, DIAGNOSTIC_IDS_MAX),
          ...rest
        }
      })
    } catch {
      /* diagnostics unavailable — the state transition must still complete */
    }
  }

  function record(
    event: string,
    level: 'info' | 'error',
    entries: Owned[],
    computerId: string,
    extra: { message: string; [k: string]: unknown }
  ): void {
    emit(
      event,
      level,
      computerId,
      entries.map((o) => o.entry.sessionId),
      extra
    )
  }

  // ── Disconnect ───────────────────────────────────────────────────────────

  function detachComputer(computerId: string, reason: string): void {
    const fresh = liveEntries(computerId).filter((o) => !o.entry.detached)
    for (const o of fresh) {
      o.entry.detached = true
      o.owner.onDetach?.(o.entry)
    }
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

  // ── Reconnect ────────────────────────────────────────────────────────────

  async function listComputer(computerId: string): Promise<ComputerSessionList | null> {
    try {
      return parseList(await gateway.request(computerId, listMethod, {}))
    } catch {
      return null
    }
  }

  async function reattachComputer(computerId: string, epoch: string | undefined): Promise<void> {
    const previousEpoch = epochByComputer.get(computerId)
    epochByComputer.set(computerId, epoch)
    // A record is about one computer PROCESS: a different (or unverifiable) one
    // cannot be running what it names, and an unknown spawnId would match anything.
    if (epoch === undefined || (previousEpoch !== undefined && epoch !== previousEpoch)) {
      abandoned.delete(computerId)
    }
    let detached = liveEntries(computerId).filter((o) => o.entry.detached)
    // A different process: whatever an earlier list offered went with the old one.
    if (previousEpoch !== undefined && epoch !== previousEpoch)
      offerUntracked(computerId, epoch, [])

    // First contact with this computer: nothing was ever detached here, so there is
    // nothing to resolve. Only a previous hub run's leftovers can be listed — worth
    // the round-trip when the hub can say which of them it has finished with
    // (`ownerGone`) or can adopt them (`onUntracked`).
    if (previousEpoch === undefined && detached.length === 0) {
      if (!participants.some((p) => p.ownerGone || p.onUntracked)) return
      const listed = await listComputer(computerId)
      if (listed) await sweep(computerId, epoch, listed, [], { firstContact: true })
      return
    }
    clearGrace(computerId)

    // First contact, yet spawns are waiting: they were sent while this hub had never
    // reached the computer (a restarted app opening its task before the computer's
    // first hello). No earlier process of it can hold them, so this is no
    // "reconnected as a different process" — start them now, the same attempt. (A
    // first spawn of a session the computer already runs, from a previous hub run,
    // takes that process over there instead of replacing it: `adoptLive`.)
    if (previousEpoch === undefined) {
      const waiting = detached.filter((o) => o.entry.pendingSpawn && !o.entry.disposed)
      for (const o of waiting) {
        o.entry.detached = false
        o.entry.pendingSpawn?.resend()
      }
      if (waiting.length > 0) {
        record('computer.sessions_resent', 'info', waiting, computerId, {
          message:
            `Computer connected for the first time — ${String(waiting.length)} ${kind} ` +
            'session(s) waiting for it are starting now.'
        })
      }
      detached = detached.filter((o) => !waiting.includes(o))
      if (detached.length === 0) return
    }

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
    const listed = await listComputer(computerId)
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
    await sweep(computerId, epoch, listed, stillDetached)
  }

  // ── Sweep ────────────────────────────────────────────────────────────────

  /** A tracked entry holds this listed session as its own attempt (or is re-sending it). */
  function owns(computerId: string, sessionId: string, running: ListedSession): boolean {
    // "Tracked" means tracked as THIS attempt: a session id can be held by an older
    // attempt's process that nothing owns. Exception: an id whose spawn is still in
    // flight (or was just re-sent) is never swept — the computer replaces the old
    // process with the new one itself, and a kill for that id would race it.
    return liveEntries(computerId).some(
      (o) =>
        o.entry.sessionId === sessionId &&
        (o.entry.pendingSpawn !== undefined ||
          o.entry.spawnInFlight === true ||
          sameAttempt(o.entry, running))
    )
  }

  /** Held by its owner outside this backend (an adopted run). */
  const keptByOwner = (computerId: string, sessionId: string): boolean =>
    participants.some((p) => p.keepUntracked?.(computerId, sessionId))

  /** This hub's own attempt for the session id is a different, known one. */
  function supersededBy(sessionId: string, running: ListedSession, entries: Owned[]): boolean {
    return (
      running.spawnId !== undefined &&
      entries.some(
        (o) =>
          o.entry.sessionId === sessionId &&
          o.entry.spawnId !== undefined &&
          o.entry.spawnId !== running.spawnId
      )
    )
  }

  function killStrays(
    computerId: string,
    kills: Array<{ sessionId: string; spawnId?: string; reason: string }>
  ): void {
    if (kills.length === 0) return
    for (const k of kills) {
      // Only the listed attempt: a kill racing a fresh spawn of the same id must
      // never reach that replacement (an older computer ignores the key).
      void gateway
        .request(computerId, killMethod, {
          sessionId: k.sessionId,
          ...(k.spawnId ? { spawnId: k.spawnId } : {})
        })
        .catch(noop)
    }
    emit(
      'computer.strays_killed',
      'warn',
      computerId,
      kills.map((k) => k.sessionId),
      {
        reasons: Object.fromEntries(
          kills.slice(0, DIAGNOSTIC_IDS_MAX).map((k) => [k.sessionId, k.reason])
        ),
        spawnIds: kills.slice(0, DIAGNOSTIC_IDS_MAX).map((k) => k.spawnId ?? null),
        message:
          `${String(kills.length)} ${kind} session(s) the hub had given up on were still ` +
          `running on the computer — ended (${[...new Set(kills.map((k) => k.reason))].join(', ')}).`
      }
    )
  }

  /** Ask the hub whether it has finished with `sessionId`; any doubt is "no". */
  async function ownerGoneReason(computerId: string, sessionId: string): Promise<string | null> {
    for (const p of participants) {
      if (!p.ownerGone) continue
      try {
        const why = await p.ownerGone(computerId, sessionId)
        if (why) return why
      } catch {
        return null
      }
    }
    return null
  }

  /**
   * End what the computer lists that this hub has POSITIVE evidence it gave up on;
   * keep everything else. See "The sweep" above.
   */
  async function sweep(
    computerId: string,
    epoch: string | undefined,
    listed: ComputerSessionList,
    resolved: Owned[],
    { firstContact = false }: { firstContact?: boolean } = {}
  ): Promise<void> {
    reconcileAbandoned(computerId, listed)
    const ours = [...liveEntries(computerId), ...resolved]
    const kills: Array<{ sessionId: string; spawnId?: string; reason: string }> = []
    const unknown: Array<[string, ListedSession]> = []
    const offer = (kept: UntrackedListed[]): void => offerUntracked(computerId, epoch, kept)
    for (const [sessionId, running] of listed.live) {
      if (owns(computerId, sessionId, running) || keptByOwner(computerId, sessionId)) continue
      const recorded = abandonedReason(computerId, sessionId, running)
      // `superseded` needs this hub to have seen its own attempt REPLACE the listed one.
      // At first contact nothing here ever met that process: a newer attempt of ours
      // is a restore the computer serializes against it itself.
      const superseded = !firstContact && supersededBy(sessionId, running, ours)
      const reason = recorded ?? (superseded ? 'superseded' : null)
      if (reason)
        kills.push({ sessionId, ...(running.spawnId ? { spawnId: running.spawnId } : {}), reason })
      else unknown.push([sessionId, running])
    }
    killStrays(computerId, kills)
    if (unknown.length === 0) {
      offer([])
      return
    }

    if (participants.length === 0) {
      // Nothing of this kind is tracked here at all, yet the computer runs some: the
      // signature of a backend that left (or never joined) while its sessions live.
      // Kills nothing — say so loudly.
      emit(
        'computer.sessions_unowned',
        'warn',
        computerId,
        unknown.map(([id]) => id),
        {
          message:
            `Computer reconnected running ${String(unknown.length)} ${kind} session(s), but no ` +
            `${kind} backend is tracking any — left running.`
        }
      )
      offer([])
      return
    }

    // Leftovers the hub may have finished with (a previous run's, whose tab was
    // closed or task deleted while it was down): only its own record can say.
    const ownerKills: Array<{ sessionId: string; spawnId?: string; reason: string }> = []
    const kept: UntrackedListed[] = []
    await Promise.all(
      unknown.map(async ([sessionId, running]) => {
        const why = await ownerGoneReason(computerId, sessionId)
        // The answer was an await: the session may be tracked again (its tab
        // reopened), or the computer gone and back as another process, meanwhile.
        if (
          why &&
          epochByComputer.get(computerId) === epoch &&
          !owns(computerId, sessionId, running) &&
          !keptByOwner(computerId, sessionId)
        ) {
          ownerKills.push({
            sessionId,
            ...(running.spawnId ? { spawnId: running.spawnId } : {}),
            reason: `owner-gone:${why}`
          })
        } else if (!owns(computerId, sessionId, running)) {
          kept.push({ sessionId, listed: running })
        }
      })
    )
    killStrays(computerId, ownerKills)
    // In list order, whatever order the probes answered in.
    const order = [...listed.live.keys()]
    kept.sort((a, b) => order.indexOf(a.sessionId) - order.indexOf(b.sessionId))
    if (kept.length > 0) {
      emit(
        'computer.untracked_sessions_kept',
        'info',
        computerId,
        kept.map((k) => k.sessionId),
        {
          message:
            `Computer runs ${String(kept.length)} ${kind} session(s) this hub does not track and ` +
            'has no record of giving up on — left running.'
        }
      )
    }
    offer(kept)
  }

  gateway.events.on('computer-lost', (p) => detachComputer(p.computerId, 'computer-lost'))
  gateway.events.on('computer-disconnected', (p) =>
    detachComputer(p.computerId, 'computer-disconnected')
  )
  gateway.events.on('computer-connected', (p) => {
    void reattachComputer(p.computer.computerId, p.computer.epoch)
  })

  return {
    join: (participant) => {
      participants.push(participant)
      let member = true
      return {
        detach: (entry) => {
          entry.detached = true
          // Bound the wait like any detached session — but never RESTART a running
          // window, which would let a flapping connection postpone it forever.
          if (!graceTimers.has(entry.computerId)) armGrace(entry.computerId)
        },
        abandon: (entry, reason) => recordAbandoned(entry, reason),
        leave: () => {
          if (!member) return
          member = false
          const at = participants.indexOf(participant)
          if (at >= 0) participants.splice(at, 1)
          for (const entry of participant.sessions.values()) {
            if (!entry.disposed) recordAbandoned(entry, 'owner-left')
          }
        }
      }
    },
    stats: () => ({
      kind,
      participants: participants.length,
      abandonedRecords: abandonedCount()
    })
  }
}
