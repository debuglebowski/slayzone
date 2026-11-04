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
 * The data loads are queued too: at most MAX_CONCURRENT_LOADS run at once, best
 * rank first. Started all together they were ~50 task-detail loads (several hub
 * round-trips each) in front of the on-screen tab's own, on a hub that serves
 * requests one at a time — enough, on a busy hub, to time out every tab. An
 * on-screen pane never waits here: it loads through its own render.
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
/**
 * Hidden panes' data loads in flight at once. Enough to keep the hub busy (each
 * load is several sequential round-trips), few enough that the on-screen pane's
 * own load — which never queues — is not stuck behind dozens of others.
 */
export const MAX_CONCURRENT_LOADS = 4

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
  /**
   * Lower loads and hydrates first. Read at pick time, so it can follow live
   * state (MRU).
   */
  rank: () => number
  /**
   * Loads what the pane needs to render without suspending; settles when done
   * (either way — a failed load still hydrates, showing the pane's error
   * boundary). Called by the queue when this pane's turn to load comes, at most
   * once, and never if the pane hydrates or is cancelled first.
   */
  load: () => Promise<unknown>
}

interface Entry {
  id: string
  seq: number
  rank: () => number
  load: () => Promise<unknown>
  state: 'waiting' | 'loading' | 'ready'
}

const noop = (): void => undefined

/**
 * Marked once per page load when the boot queue has drained — every hidden pane
 * that was queued is hydrated. Read by the renderer boot telemetry.
 */
export const ALL_HYDRATED_MARK = 'sz:panes:allHydrated'

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
  /**
   * The pane is mounted (its tab is open). Returns its detach (idempotent). Only
   * mounted panes count toward `progress()`, so a closed tab leaves it.
   */
  attach: (id: string) => () => void
  /** Mounted panes hydrated so far, and still waiting. Same object until either changes. */
  progress: () => HydrationProgress
  /** Notified whenever `progress()` changes. */
  subscribeProgress: (cb: () => void) => () => void
}

export interface HydrationProgress {
  /** Mounted panes that are hydrated (closed tabs excluded). */
  hydrated: number
  queued: number
}

export function createPaneHydrator(env: HydrationEnv = defaultEnv()): PaneHydrator {
  const hydrated = new Set<string>()
  /** Mounted panes, with how many mounts each (a pane can attach twice in a row). */
  const mounted = new Map<string, number>()
  const queue = new Map<string, Entry>()
  const listeners = new Map<string, Set<() => void>>()
  let seq = 0
  let idleScheduled = false
  let everQueued = false
  let drainMarked = false
  const progressListeners = new Set<() => void>()
  let progressSnapshot: HydrationProgress = { hydrated: 0, queued: 0 }
  const mountedHydrated = (): number => {
    let n = 0
    for (const id of mounted.keys()) if (hydrated.has(id)) n++
    return n
  }
  const progressChanged = (): void => {
    const count = mountedHydrated()
    if (progressSnapshot.hydrated === count && progressSnapshot.queued === queue.size) return
    progressSnapshot = { hydrated: count, queued: queue.size }
    for (const cb of [...progressListeners]) cb()
  }

  const hydrate = (id: string): void => {
    queue.delete(id)
    if (hydrated.has(id)) return progressChanged()
    hydrated.add(id)
    progressChanged()
    const subs = listeners.get(id)
    if (subs) for (const cb of [...subs]) cb()
    if (everQueued && !drainMarked && queue.size === 0) {
      drainMarked = true
      if (typeof performance !== 'undefined') performance.mark(ALL_HYDRATED_MARK)
    }
  }

  const best = (state: Entry['state']): Entry | undefined => {
    let best: Entry | undefined
    let bestRank = 0
    for (const e of queue.values()) {
      if (e.state !== state) continue
      const r = e.rank()
      if (!best || r < bestRank || (r === bestRank && e.seq < best.seq)) {
        best = e
        bestRank = r
      }
    }
    return best
  }

  const takeBest = (): Entry | undefined => best('ready')

  const hasReady = (): boolean => {
    for (const e of queue.values()) if (e.state === 'ready') return true
    return false
  }

  /**
   * Loads started and not yet settled — counted by settle, not by queue
   * membership, so a pane hydrated or closed mid-load still holds its slot until
   * its requests are done.
   */
  let loading = 0
  const startLoads = (): void => {
    while (loading < MAX_CONCURRENT_LOADS) {
      const next = best('waiting')
      if (!next) return
      next.state = 'loading'
      loading++
      const settled = (): void => {
        loading--
        if (queue.get(next.id) === next) {
          next.state = 'ready'
          pump()
        }
        startLoads()
      }
      let started: Promise<unknown>
      try {
        started = next.load()
      } catch (err) {
        started = Promise.reject(err)
      }
      started.then(settled, settled)
    }
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
    const entry: Entry = { id, seq: seq++, rank: opts.rank, load: opts.load, state: 'waiting' }
    queue.set(id, entry)
    everQueued = true
    progressChanged()
    // Next microtask, not now: panes mount in one commit, and ranks must all be
    // in the queue before the first slots are handed out.
    queueMicrotask(startLoads)
    return () => {
      if (queue.get(id) === entry) queue.delete(id)
      progressChanged()
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
    subscribe,
    attach: (id) => {
      mounted.set(id, (mounted.get(id) ?? 0) + 1)
      progressChanged()
      let attached = true
      return () => {
        if (!attached) return
        attached = false
        const n = (mounted.get(id) ?? 1) - 1
        if (n > 0) mounted.set(id, n)
        else mounted.delete(id)
        progressChanged()
      }
    },
    progress: () => progressSnapshot,
    subscribeProgress: (cb) => {
      progressListeners.add(cb)
      return () => {
        progressListeners.delete(cb)
      }
    }
  }
}

/** The main window's hydrator (one per renderer). */
export const paneHydrator = createPaneHydrator()
