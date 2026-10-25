import { flushSync } from 'react-dom'

/**
 * Idle hydration of hidden task tabs.
 *
 * Every open tab stays mounted so a switch is instant — but a renderer boot that
 * restores ~50 tabs used to mount every full TaskDetail in the same commit: 52
 * skeleton→detail swaps at once, ~5ms render JS + ~450 DOM nodes per tab, and a
 * first forced layout over 15.6k elements, all in front of the tab the user is
 * actually looking at.
 *
 * Now a pane mounts its detail ("hydrates") at once only when it is on screen
 * (the active tab, every explode-mode tile). A hidden pane shows the task
 * skeleton and joins this queue; the queue hydrates one pane per idle slice (a
 * few when the slice has room), in the order the user is likeliest to open them
 * (see `rank`), and only once that
 * pane's data has loaded — so each hydration renders synchronously from cache
 * instead of suspending and piling into one burst when the fetches land.
 *
 * Hydration is permanent: a hydrated pane never goes back to the skeleton, so
 * after the boot queue drains a switch costs exactly what it did before. A pane
 * revealed before its turn hydrates in the reveal render itself.
 */

/** Idle-callback timeout: the most a ready pane waits while the thread stays busy. */
export const HYDRATE_IDLE_TIMEOUT_MS = 200
/**
 * Hydrate another pane in the same idle period only while this much of it is
 * left — a pane's render is a few ms; the margin keeps the batch, and the style
 * and layout pass that follows it, inside the idle period.
 */
export const MIN_REMAINING_FOR_NEXT_MS = 20

interface IdleDeadlineLike {
  didTimeout: boolean
  timeRemaining: () => number
}

export interface HydrationEnv {
  requestIdle: (cb: (deadline: IdleDeadlineLike) => void, timeoutMs: number) => void
  /** Runs `fn` and renders the updates it causes before returning (react-dom flushSync). */
  flush: (fn: () => void) => void
}

export interface EnqueueOptions {
  /** Lower hydrates first. Read at pick time, so it can follow live state (MRU). */
  rank: () => number
  /** Settles when the pane can render without suspending (its data has loaded). */
  ready: Promise<unknown>
}

interface Entry {
  id: string
  seq: number
  rank: () => number
  ready: boolean
}

const noop = (): void => undefined

const defaultEnv = (): HydrationEnv => ({
  requestIdle: (cb, timeoutMs) => {
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(cb, { timeout: timeoutMs })
    } else {
      setTimeout(() => cb({ didTimeout: true, timeRemaining: () => 0 }), 0)
    }
  },
  flush: flushSync
})

export interface PaneHydrator {
  /** Queue a hidden pane. Returns a cancel (pane unmounted before its turn). */
  enqueue: (id: string, opts: EnqueueOptions) => () => void
  /** The pane is on screen: hydrated from now on, outside the queue. */
  hydrateNow: (id: string) => void
  isHydrated: (id: string) => boolean
  /** Notified when `id` hydrates. */
  subscribe: (id: string, cb: () => void) => () => void
}

export function createPaneHydrator(env: HydrationEnv = defaultEnv()): PaneHydrator {
  const hydrated = new Set<string>()
  const queue = new Map<string, Entry>()
  const listeners = new Map<string, Set<() => void>>()
  let seq = 0
  let idleScheduled = false

  const hydrate = (id: string): void => {
    queue.delete(id)
    if (hydrated.has(id)) return
    hydrated.add(id)
    const subs = listeners.get(id)
    if (subs) for (const cb of [...subs]) cb()
  }

  const takeBest = (): Entry | undefined => {
    let best: Entry | undefined
    let bestRank = 0
    for (const e of queue.values()) {
      if (!e.ready) continue
      const r = e.rank()
      if (!best || r < bestRank || (r === bestRank && e.seq < best.seq)) {
        best = e
        bestRank = r
      }
    }
    return best
  }

  const hasReady = (): boolean => {
    for (const e of queue.values()) if (e.ready) return true
    return false
  }

  // Each pane renders synchronously inside the idle callback (its external-store
  // update is flushed before `flush` returns), so the deadline sees what the
  // render cost: another ready pane follows in the same idle period only while
  // there is clearly room left. While the thread is busy (short idle periods, or
  // the callback timed out) that is one pane per callback — never a long task.
  // Panes that share a period also share one style and layout pass.
  const pump = (): void => {
    if (idleScheduled || !hasReady()) return
    idleScheduled = true
    env.requestIdle((deadline) => {
      idleScheduled = false
      for (let next = takeBest(); next; next = takeBest()) {
        const id = next.id
        env.flush(() => hydrate(id))
        if (deadline.didTimeout || deadline.timeRemaining() < MIN_REMAINING_FOR_NEXT_MS) break
      }
      pump()
    }, HYDRATE_IDLE_TIMEOUT_MS)
  }

  const enqueue = (id: string, opts: EnqueueOptions): (() => void) => {
    if (hydrated.has(id)) return noop
    const entry: Entry = { id, seq: seq++, rank: opts.rank, ready: false }
    queue.set(id, entry)
    const markReady = (): void => {
      if (queue.get(id) !== entry) return
      entry.ready = true
      pump()
    }
    opts.ready.then(markReady, markReady)
    return () => {
      if (queue.get(id) === entry) queue.delete(id)
    }
  }

  const subscribe = (id: string, cb: () => void): (() => void) => {
    let subs = listeners.get(id)
    if (!subs) listeners.set(id, (subs = new Set()))
    subs.add(cb)
    return () => {
      subs.delete(cb)
      if (subs.size === 0) listeners.delete(id)
    }
  }

  return {
    enqueue,
    hydrateNow: hydrate,
    isHydrated: (id) => hydrated.has(id),
    subscribe
  }
}

/** The main window's hydrator (one per renderer). */
export const paneHydrator = createPaneHydrator()
