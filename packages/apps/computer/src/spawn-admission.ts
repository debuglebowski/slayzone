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
 *   - `warm` (the pre-boot pool) only starts when no agent start is queued or in
 *     flight and none has been for {@link DEFAULT_WARM_QUIET_MS}, one at a time —
 *     the pool is a speed-up for the NEXT task, never a competitor of this one.
 *     (The pty handler holds a warm start's slot past its shell's first output,
 *     since the agent boots after it.)
 *
 * Nothing is dropped or deferred indefinitely: every queued start runs, in order,
 * as slots free up. Plain shells never come here (see `pty.spawn`'s `admission`).
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
  enqueue(lane: AdmissionLane, start: (slot: AdmissionSlot) => void): AdmissionTicket
  /** Remove a still-queued start. False when it already started (or was removed). */
  cancel(ticket: AdmissionTicket): boolean
  /** Move a still-queued start to the front of the foreground lane. */
  prioritize(ticket: AdmissionTicket): boolean
  /** Is this ticket still waiting? */
  isQueued(ticket: AdmissionTicket): boolean
  stats(): { queued: number; active: number; concurrency: number }
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

export interface SpawnAdmissionOptions {
  concurrency?: number
  startCapMs?: number
  warmQuietMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

interface Ticket extends AdmissionTicket {
  lane: AdmissionLane
  /** Sort key within the lane: arrival order, negative once promoted (newest first). */
  order: number
  start: (slot: AdmissionSlot) => void
}

interface ActiveSlot {
  warm: boolean
  released: boolean
  cap: unknown
}

const LANE_RANK: Record<AdmissionLane, number> = { foreground: 0, background: 1, warm: 2 }

export function createSpawnAdmission(opts: SpawnAdmissionOptions = {}): SpawnAdmission {
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

  const queue: Ticket[] = []
  const active = new Set<ActiveSlot>()
  let arrivals = 0
  let promotions = 0
  /** Last time an agent start was queued or finished starting; gates the warm lane. */
  let lastAgentActivity = Number.NEGATIVE_INFINITY
  let warmRetry: unknown = null
  let pumping = false
  let pumpAgain = false

  const activeAgents = (): number => [...active].filter((s) => !s.warm).length
  const activeWarm = (): number => [...active].filter((s) => s.warm).length

  function next(): Ticket | null {
    if (active.size >= concurrency || queue.length === 0) return null
    let best: Ticket | null = null
    for (const t of queue) {
      if (
        !best ||
        LANE_RANK[t.lane] < LANE_RANK[best.lane] ||
        (t.lane === best.lane && t.order < best.order)
      ) {
        best = t
      }
    }
    if (!best || best.lane !== 'warm') return best
    // Only warm starts are left. They wait for the agent starts to be over.
    if (activeAgents() > 0 || activeWarm() > 0) return null
    const quietLeft = lastAgentActivity + warmQuietMs - now()
    if (quietLeft > 0) {
      if (warmRetry === null) {
        warmRetry = setTimer(() => {
          warmRetry = null
          pump()
        }, quietLeft)
      }
      return null
    }
    return best
  }

  function admit(ticket: Ticket): void {
    queue.splice(queue.indexOf(ticket), 1)
    const warm = ticket.lane === 'warm'
    const held: ActiveSlot = { warm, released: false, cap: null }
    const release = (): void => {
      if (held.released) return
      held.released = true
      clearTimer(held.cap)
      active.delete(held)
      if (!warm) lastAgentActivity = now()
      pump()
    }
    held.cap = setTimer(release, startCapMs)
    active.add(held)
    try {
      ticket.start({ release })
    } catch {
      release()
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
    enqueue(lane, start) {
      const ticket: Ticket = { lane, order: ++arrivals, start }
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
    stats() {
      return { queued: queue.length, active: active.size, concurrency }
    }
  }
}
