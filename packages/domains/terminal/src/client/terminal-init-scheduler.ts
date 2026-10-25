/**
 * Serializes the DOM-heavy part of terminal initialisation for terminals nobody
 * can see yet.
 *
 * Every task tab stays mounted, so a renderer boot with ~50 restored tabs used to
 * run ~44 hidden `initTerminalSession`s in one microtask burst: each `open()`
 * inserts xterm's `<style>` elements (whole-document style invalidation) and each
 * `fit()` reads computed style — 126 forced style recalcs over a 64k-element DOM,
 * one 2s long task. Visible terminals still initialise immediately; hidden ones
 * take turns, one per idle slice (more when the slice has room), in MRU order,
 * each holding the slot until its heavy section is done. Revealing a queued
 * terminal promotes it to immediate, so it is never ready later than it would
 * have been.
 *
 * Only the DOM work is serialized: a hidden terminal still opens, sizes itself,
 * attaches to its PTY and parses output — just a few frames later.
 */
import { mruRank } from './terminal-mru'

/** Held by an init while it does its DOM-heavy section. Idempotent. */
export interface InitSlot {
  release: () => void
}

/** Longest a holder may keep the slot before the queue moves on regardless. */
export const MAX_HOLD_MS = 1000
/** Idle-callback timeout: the most a queued init waits while the thread stays busy. */
export const IDLE_TIMEOUT_MS = 200
/** Grant another slot inside the same idle period only if this much of it remains. */
const MIN_REMAINING_MS = 8

interface Pending {
  sessionId: string
  seq: number
  /** Resolve the waiter. `counted`: the grant took the shared slot. */
  grant: (counted: boolean) => void
}

interface IdleDeadlineLike {
  didTimeout: boolean
  timeRemaining: () => number
}

interface SchedulerEnv {
  requestIdle: (cb: (deadline: IdleDeadlineLike) => void, timeoutMs: number) => void
  setTimer: (cb: () => void, ms: number) => unknown
  clearTimer: (id: unknown) => void
  rank: (sessionId: string) => number
}

const defaultEnv = (): SchedulerEnv => ({
  requestIdle: (cb, timeoutMs) => {
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(cb, { timeout: timeoutMs })
    } else {
      setTimeout(() => cb({ didTimeout: true, timeRemaining: () => 0 }), 0)
    }
  },
  setTimer: (cb, ms) => setTimeout(cb, ms),
  clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  rank: mruRank
})

export function createInitScheduler(env: SchedulerEnv = defaultEnv()) {
  const pending: Pending[] = []
  let seq = 0
  let held = false
  let idleScheduled = false
  let deadline: IdleDeadlineLike | null = null

  const takeBest = (): Pending | undefined => {
    if (pending.length === 0) return undefined
    let best = 0
    for (let i = 1; i < pending.length; i++) {
      const a = pending[i]
      const b = pending[best]
      const ra = env.rank(a.sessionId)
      const rb = env.rank(b.sessionId)
      if (ra < rb || (ra === rb && a.seq < b.seq)) best = i
    }
    return pending.splice(best, 1)[0]
  }

  const grantNext = (): void => {
    if (held) return
    const next = takeBest()
    if (!next) return
    held = true
    next.grant(true)
  }

  const pump = (): void => {
    if (held || idleScheduled || pending.length === 0) return
    idleScheduled = true
    env.requestIdle((d) => {
      idleScheduled = false
      deadline = d
      grantNext()
      pump()
    }, IDLE_TIMEOUT_MS)
  }

  const onRelease = (): void => {
    held = false
    // Room left in the idle period that granted the slot → next one now.
    const d = deadline
    if (d && !d.didTimeout && d.timeRemaining() > MIN_REMAINING_MS) {
      grantNext()
      if (held) return
    }
    deadline = null
    pump()
  }

  const makeSlot = (counted: boolean): InitSlot => {
    let released = false
    let timer: unknown = null
    const release = (): void => {
      if (released) return
      released = true
      if (timer !== null) env.clearTimer(timer)
      if (counted) onRelease()
    }
    if (counted) timer = env.setTimer(release, MAX_HOLD_MS)
    return { release }
  }

  /**
   * Wait for a turn. `immediate` (an on-screen terminal) resolves at once and
   * takes no turn. A queued request resolves when granted, when promoted, or —
   * with a no-op slot — when `signal` aborts.
   */
  const acquire = (
    sessionId: string,
    opts: { immediate: boolean; signal: AbortSignal }
  ): Promise<InitSlot> => {
    if (opts.immediate || opts.signal.aborted) return Promise.resolve(makeSlot(false))
    return new Promise<InitSlot>((resolve) => {
      const entry: Pending = {
        sessionId,
        seq: seq++,
        grant: (counted) => {
          opts.signal.removeEventListener('abort', onAbort)
          resolve(makeSlot(counted))
        }
      }
      const onAbort = (): void => {
        const i = pending.indexOf(entry)
        if (i >= 0) pending.splice(i, 1)
        resolve(makeSlot(false))
      }
      opts.signal.addEventListener('abort', onAbort, { once: true })
      pending.push(entry)
      pump()
    })
  }

  /** The terminal became visible: let its queued init run now, outside the queue. */
  const promote = (sessionId: string): boolean => {
    let promoted = false
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i]
      if (p.sessionId !== sessionId) continue
      pending.splice(i, 1)
      promoted = true
      // Outside the shared slot: the queue keeps moving while this one runs.
      p.grant(false)
    }
    if (promoted) pump()
    return promoted
  }

  const isQueued = (sessionId: string): boolean => pending.some((p) => p.sessionId === sessionId)

  return { acquire, promote, isQueued }
}

const scheduler = createInitScheduler()

export const acquireInitSlot = scheduler.acquire
export const promoteInitSlot = scheduler.promote
export const isInitQueued = scheduler.isQueued
