/** Renderer restoration admission. Agent processes and their durable queues never wait here. */
export interface ChatRestorationTicket {
  ready(): boolean
  subscribe(cb: () => void): () => void
  setActive(active: boolean): void
  /** The panel committed; its child effects have registered their initial work. */
  mounted(): void
  /** Hold admission until history work settles, including after cancellation. */
  track<T>(work: Promise<T>): Promise<T>
  /** ms from enqueue until it got its slot (null while it waits): open-timing diagnostic. */
  queuedMs(): number | null
  cancel(): void
}

export function createChatRestorationQueue(
  opts: { concurrency?: number; backgroundConcurrency?: number; now?: () => number } = {}
) {
  const now = opts.now ?? (() => performance.now())
  const concurrency = opts.concurrency ?? 3
  const backgroundConcurrency = opts.backgroundConcurrency ?? 2
  const waiting: Entry[] = []
  const running = new Set<Entry>()
  let foregroundStreak = 0,
    peakRunning = 0,
    peakQueued = 0,
    started = 0
  interface Entry {
    active: boolean
    started: boolean
    cancelled: boolean
    done: boolean
    pending: number
    mounted: boolean
    enqueuedAt: number
    startedAt: number | null
    timer: ReturnType<typeof setTimeout> | null
    listeners: Set<() => void>
  }
  const backgroundCount = () => [...running].filter((e) => !e.active).length
  const pump = (): void => {
    while (concurrency > 0 && running.size <= concurrency) {
      const foreground = waiting.find((e) => e.active)
      const hasSlot = running.size < concurrency
      // The requests started for the previous selection still drain. Let the
      // now-visible panel open in one temporary extra slot.
      if (!hasSlot && (!foreground || [...running].some((e) => e.active && !e.cancelled))) return
      const bg =
        hasSlot && backgroundCount() < backgroundConcurrency
          ? waiting.find((e) => !e.active)
          : undefined
      const next = (foregroundStreak >= 4 ? bg : undefined) ?? foreground ?? bg
      if (!next) return
      waiting.splice(waiting.indexOf(next), 1)
      next.started = true
      next.startedAt = now()
      running.add(next)
      started++
      foregroundStreak = next.active ? foregroundStreak + 1 : 0
      peakRunning = Math.max(peakRunning, running.size)
      for (const cb of [...next.listeners]) cb()
    }
  }
  const settle = (e: Entry): void => {
    if (!e.started || e.done || e.pending > 0 || (!e.mounted && !e.cancelled) || e.timer) return
    // Let the panel commit and register any replacement history load.
    e.timer = setTimeout(() => {
      e.timer = null
      if (e.pending > 0 || e.done) return
      e.done = true
      running.delete(e)
      for (const cb of [...e.listeners]) cb()
      pump()
    }, 0)
  }
  return {
    snapshot: () => ({
      running: running.size,
      queued: waiting.length,
      background: backgroundCount(),
      peakRunning,
      peakQueued,
      started
    }),
    enqueue(active: boolean): ChatRestorationTicket {
      const e: Entry = {
        active,
        started: false,
        cancelled: false,
        done: false,
        pending: 0,
        mounted: false,
        timer: null,
        listeners: new Set(),
        enqueuedAt: now(),
        startedAt: null
      }
      waiting.push(e)
      peakQueued = Math.max(peakQueued, waiting.length)
      pump()
      return {
        ready: () => e.started && !e.cancelled,
        subscribe(cb) {
          e.listeners.add(cb)
          return () => {
            e.listeners.delete(cb)
          }
        },
        setActive(active) {
          e.active = active
          pump()
        },
        mounted() {
          e.mounted = true
          settle(e)
        },
        track<T>(work: Promise<T>): Promise<T> {
          if (e.done || !e.started) return work
          e.pending++
          return work.finally(() => {
            e.pending--
            settle(e)
          })
        },
        queuedMs: () => (e.startedAt === null ? null : Math.round(e.startedAt - e.enqueuedAt)),
        cancel() {
          if (e.cancelled) return
          e.cancelled = true
          for (const cb of [...e.listeners]) cb()
          e.listeners.clear()
          const i = waiting.indexOf(e)
          if (i >= 0) {
            waiting.splice(i, 1)
            e.done = true
          }
          // A cancelled panel's history still occupies capacity until they actually settle.
          settle(e)
          pump()
        }
      }
    }
  }
}

const queues = new WeakMap<object, ReturnType<typeof createChatRestorationQueue>>()
/** Each hub has its own budget: an unreachable remote hub cannot block local restoration. */
export function chatRestorationQueueFor(client: object) {
  let queue = queues.get(client)
  if (!queue) {
    queue = createChatRestorationQueue()
    queues.set(client, queue)
  }
  return queue
}
