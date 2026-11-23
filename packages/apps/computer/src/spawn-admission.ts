/**
 * Admission queue for AGENT process starts on this computer.
 *
 * Why it exists: an agent's first seconds are its most expensive — runtime load,
 * MCP servers, and on `--resume` a transcript replay. Restoring a workspace opens
 * every task tab at once, and each one used to start its agent immediately: ~50
 * agents plus the warm pool booting together. Under that contention every agent
 * took ~10s to print anything (0.3–1.4s normally), a third of them hit the 10s
 * startup deadline and were SIGKILLed, and the hub stalled for half a minute.
 *
 * So agent starts are ADMITTED, a few at a time:
 *   - a start holds its slot until the process prints its first output (it has
 *     got past the expensive part), exits, or {@link DEFAULT_START_CAP_MS} passes
 *     — the cap keeps one silent agent from serialising everything behind it;
 *   - `foreground` (the tab the user is looking at) goes before `background`,
 *     each FIFO; a queued start can be promoted when its tab is revealed;
 *   - startup history reads defer new background and warm starts, with a
 *     periodic admission so slow history cannot stall their queues;
 *   - `warm` (the pre-boot pool) only starts when no agent start is queued or in
 *     flight and none has been for {@link DEFAULT_WARM_QUIET_MS}, one at a time —
 *     the pool is a speed-up for the NEXT task, never a competitor of this one.
 *     (The pty handler holds a warm start's slot past its shell's first output,
 *     since the agent boots after it.)
 *
 * Starts also wait for memory headroom and a live-agent slot. Plain shells
 * never come here (see `pty.spawn`'s `admission`).
 *
 * One instance is shared by every hub this computer serves (`main.ts`), because
 * the contention is the machine's, not the connection's.
 *
 * @module computer/spawn-admission
 */

import { availableParallelism } from 'node:os'

export type AdmissionLane = 'foreground' | 'background' | 'warm'

/** A started agent's hold on a slot. `release` is idempotent. */
export interface AdmissionSlot {
  release(): void
  track(pid: number, evict?: () => void): AdmittedAgent
}

export interface AdmittedAgent {
  exit(): void
  adopt(): void
}

export interface AdmissionResources {
  cap: number
  warmPoolSize: number
  pressure: boolean
}

/** A queued start. Opaque to callers except for `cancel` / `prioritize`. */
export interface AdmissionTicket {
  readonly lane: AdmissionLane
}

export interface SpawnAdmission {
  /**
   * Queue a start. `start` runs once a slot is free — possibly synchronously,
   * inside this call — and must hand the slot back (`release`) when the agent is
   * up, or let the cap do it. A throwing `start` releases its slot.
   */
  enqueue(
    lane: AdmissionLane,
    start: (slot: AdmissionSlot) => void,
    replacesAgent?: () => boolean
  ): AdmissionTicket
  /** Remove a still-queued start. False when it already started (or was removed). */
  cancel(ticket: AdmissionTicket): boolean
  /** Move a still-queued start to the front of the foreground lane. */
  prioritize(ticket: AdmissionTicket): boolean
  /** Is this ticket still waiting? */
  isQueued(ticket: AdmissionTicket): boolean
  /** Defer lower-priority starts until this read finishes. Returns an idempotent release. */
  holdHistoryRead?(): () => void
  stats(): { queued: number; active: number; concurrency: number }
  acceptsWarm?(): boolean
}

/** How long a start may hold its slot without printing anything. */
export const DEFAULT_START_CAP_MS = 5_000
/** Agent-start silence required before a warm agent may boot. */
export const DEFAULT_WARM_QUIET_MS = 3_000

/**
 * 2–4 concurrent starts: half the cores, so the starts in flight leave room for
 * everything else (the hub, the renderer, agents already running).
 */
export function defaultAdmissionConcurrency(cores = availableParallelism()): number {
  return Math.max(2, Math.min(4, Math.floor(cores / 2)))
}

/**
 * What happened to one start, for the computer's log: how long it waited for its
 * slot, and how long it held it (and whether the agent let it go or the cap took it).
 */
export type AdmissionEvent =
  | {
      type: 'admitted'
      lane: AdmissionLane
      waitedMs: number
      /** Starts still waiting after this one. */
      queued: number
      active: number
    }
  | { type: 'released'; lane: AdmissionLane; heldMs: number; by: 'agent' | 'cap' }

export interface SpawnAdmissionOptions {
  concurrency?: number
  resources?: () => AdmissionResources
  startCapMs?: number
  warmQuietMs?: number
  /** Told of every admission and release. Must not throw (it is guarded anyway). */
  onEvent?: (event: AdmissionEvent) => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

interface Ticket extends AdmissionTicket {
  lane: AdmissionLane
  /** Sort key within the lane: arrival order, negative once promoted (newest first). */
  order: number
  /** When it was queued. */
  at: number
  start: (slot: AdmissionSlot) => void
  replacesAgent?: () => boolean
}

interface ActiveSlot {
  warm: boolean
  released: boolean
  cap: unknown
  pid?: number
  evict?: () => void
}

const LANE_RANK: Record<AdmissionLane, number> = { foreground: 0, background: 1, warm: 2 }
/** Bridge the gap between hydrate and the following history request. */
const HISTORY_QUIET_MS = 150
/** During sustained history work, admit at most one lower-priority start per interval. */
const HISTORY_START_INTERVAL_MS = 2_000

export function createSpawnAdmission(opts: SpawnAdmissionOptions = {}): Required<SpawnAdmission> & {
  load(): { live: number; warm: number; queued: number; reserved: number; pids: number[] }
  recheck(): void
} {
  const concurrency = Math.max(1, opts.concurrency ?? defaultAdmissionConcurrency())
  const startCapMs = opts.startCapMs ?? DEFAULT_START_CAP_MS
  const warmQuietMs = opts.warmQuietMs ?? DEFAULT_WARM_QUIET_MS
  const now = opts.now ?? Date.now
  const setTimer =
    opts.setTimer ??
    ((fn: () => void, ms: number): unknown => {
      const t = setTimeout(fn, ms)
      // Bookkeeping about starts, never a reason to keep the computer alive.
      t.unref?.()
      return t
    })
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout))
  const report = (event: AdmissionEvent): void => {
    try {
      opts.onEvent?.(event)
    } catch {
      /* a log line must never break a start */
    }
  }

  const queue: Ticket[] = []
  const active = new Set<ActiveSlot>()
  const agents = new Set<ActiveSlot>()
  let arrivals = 0
  let promotions = 0
  /** Last time an agent start was queued or finished starting; gates the warm lane. */
  let lastAgentActivity = Number.NEGATIVE_INFINITY
  let historyReads = 0
  let historyQuietUntil = Number.NEGATIVE_INFINITY
  let nextStartDuringHistory = Number.NEGATIVE_INFINITY
  let retry: unknown = null
  let pumping = false
  let pumpAgain = false

  const activeAgents = (): number => [...active].filter((s) => !s.warm).length
  const activeWarm = (): number => [...active].filter((s) => s.warm).length
  const warmReservations = (): number => [...agents].filter((s) => s.warm).length

  function evictWarm(): void {
    const agent = [...agents].find((s) => s.warm && s.evict)
    const evict = agent?.evict
    if (!agent || !evict) return
    delete agent.evict
    evict()
  }

  function next(): Ticket | null {
    const resources = opts.resources?.()
    if (resources && (resources.pressure || warmReservations() > resources.warmPoolSize)) {
      evictWarm()
    }
    if (active.size >= concurrency || queue.length === 0 || resources?.pressure) return null
    const atCap = resources !== undefined && agents.size >= resources.cap
    let best: Ticket | null = null
    let waitingForCapacity = false
    for (const t of queue) {
      if (atCap && !t.replacesAgent?.()) {
        waitingForCapacity ||= t.lane !== 'warm'
        continue
      }
      if (
        !best ||
        LANE_RANK[t.lane] < LANE_RANK[best.lane] ||
        (t.lane === best.lane && t.order < best.order)
      ) {
        best = t
      }
    }
    if (!best && waitingForCapacity) evictWarm()
    if (!best || best.lane === 'foreground') return best
    if (
      best.lane === 'warm' &&
      (activeAgents() > 0 ||
        activeWarm() > 0 ||
        (resources && warmReservations() >= resources.warmPoolSize))
    )
      return null
    const historyReadyAt =
      historyReads > 0
        ? nextStartDuringHistory
        : Math.min(historyQuietUntil, nextStartDuringHistory)
    const readyAt =
      best.lane === 'warm'
        ? Math.max(historyReadyAt, lastAgentActivity + warmQuietMs)
        : historyReadyAt
    const waitMs = readyAt - now()
    if (waitMs <= 0) return best
    if (retry !== null) clearTimer(retry)
    retry = setTimer(() => {
      retry = null
      pump()
    }, waitMs)
    return null
  }

  function admit(ticket: Ticket): void {
    queue.splice(queue.indexOf(ticket), 1)
    const warm = ticket.lane === 'warm'
    const held: ActiveSlot = { warm, released: false, cap: null }
    const admittedAt = now()
    if ((historyReads > 0 || admittedAt < historyQuietUntil) && ticket.lane !== 'foreground')
      nextStartDuringHistory = admittedAt + HISTORY_START_INTERVAL_MS
    const release = (by: 'agent' | 'cap' = 'agent'): void => {
      const unreserved = by === 'agent' && held.pid === undefined && agents.delete(held)
      if (unreserved && held.released) pump()
      if (held.released) return
      held.released = true
      clearTimer(held.cap)
      active.delete(held)
      if (!warm) lastAgentActivity = now()
      report({ type: 'released', lane: ticket.lane, heldMs: now() - admittedAt, by })
      pump()
    }
    held.cap = setTimer(() => release('cap'), startCapMs)
    active.add(held)
    agents.add(held)
    report({
      type: 'admitted',
      lane: ticket.lane,
      waitedMs: admittedAt - ticket.at,
      queued: queue.length,
      active: active.size
    })
    try {
      ticket.start({
        release: () => release('agent'),
        track(pid, evict) {
          held.pid = pid
          held.evict = evict
          return {
            exit() {
              if (agents.delete(held)) pump()
            },
            adopt() {
              held.warm = false
              delete held.evict
              pump()
            }
          }
        }
      })
    } catch {
      release('agent')
    }
  }

  function pump(): void {
    // Re-entrant: a `start` (or a release inside one) can call back in here.
    if (pumping) {
      pumpAgain = true
      return
    }
    pumping = true
    try {
      do {
        pumpAgain = false
        for (let t = next(); t; t = next()) admit(t)
      } while (pumpAgain)
    } finally {
      pumping = false
    }
  }

  return {
    enqueue(lane, start, replacesAgent) {
      const ticket: Ticket = { lane, order: ++arrivals, at: now(), start, replacesAgent }
      queue.push(ticket)
      if (lane !== 'warm') lastAgentActivity = now()
      pump()
      return ticket
    },
    cancel(ticket) {
      const i = queue.indexOf(ticket as Ticket)
      if (i < 0) return false
      queue.splice(i, 1)
      pump()
      return true
    },
    prioritize(ticket) {
      const t = ticket as Ticket
      if (!queue.includes(t)) return false
      // The most recently revealed tab is the one the user is waiting on now.
      t.lane = 'foreground'
      t.order = -++promotions
      pump()
      return true
    },
    isQueued(ticket) {
      return queue.includes(ticket as Ticket)
    },
    holdHistoryRead() {
      const startedAt = now()
      if (historyReads === 0 && startedAt >= historyQuietUntil)
        nextStartDuringHistory = startedAt + HISTORY_START_INTERVAL_MS
      historyReads++
      let released = false
      return () => {
        if (released) return
        released = true
        if (--historyReads === 0) {
          historyQuietUntil = now() + HISTORY_QUIET_MS
          pump()
        }
      }
    },
    stats() {
      return { queued: queue.length, active: active.size, concurrency }
    },
    load() {
      const live = [...agents].filter((s) => s.pid !== undefined)
      return {
        live: live.length,
        warm: live.filter((s) => s.warm).length,
        queued: queue.filter((t) => t.lane !== 'warm').length,
        reserved: agents.size,
        pids: live.map((s) => s.pid!)
      }
    },
    acceptsWarm() {
      const limit = opts.resources?.().warmPoolSize
      return (
        limit === undefined ||
        warmReservations() + queue.filter((t) => t.lane === 'warm').length < limit
      )
    },
    recheck: pump
  }
}
