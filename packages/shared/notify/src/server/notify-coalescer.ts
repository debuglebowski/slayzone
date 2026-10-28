import { currentSecurityContext } from '@slayzone/platform/security-log'

/**
 * Leading + trailing throttle for the `notify.*` refresh signals, one per
 * subscriber.
 *
 * Every signal makes each renderer refetch, and writers fire in bursts (a turn
 * ending flips state + attention + conversation id within milliseconds; a hub
 * boot replays ~60 agent SessionStarts). The first signal of a quiet period is
 * delivered AT ONCE — an isolated change costs no latency. Signals inside the
 * following `windowMs` are merged and delivered as ONE when the window closes,
 * and the window stays open while signals keep coming. So a burst becomes at
 * most one delivery per window instead of one refetch per write.
 *
 * Merging keeps the scope honest: the union of every named task id, or "unknown
 * scope" (`null`) as soon as any merged signal named none.
 *
 * Signals are bucketed by the acting user (`currentSecurityContext().actor`):
 * the owner gate attributes a delivered event to the user on the async context
 * at emit time, and a deferred delivery runs in the context of the timer that
 * scheduled it — the first signal of its bucket. One bucket per actor keeps
 * every merged signal under the attribution it was emitted with.
 */
export const NOTIFY_COALESCE_MS = 200

export interface Coalescer<T> {
  push(change?: T): void
  dispose(): void
}

interface Bucket {
  timer: ReturnType<typeof setTimeout>
  /** Something arrived since the last delivery. */
  dirty: boolean
  /** A merged signal named no ids → deliver unknown scope. */
  unknown: boolean
  ids: Set<string>
}

/**
 * @param deliver called with the merged ids, or `null` for unknown scope.
 * @param idsOf the ids a signal names, or undefined when it names none.
 */
export function createNotifyCoalescer<T>(
  deliver: (taskIds: string[] | null) => void,
  idsOf: (change: T | undefined) => readonly string[] | undefined,
  windowMs = NOTIFY_COALESCE_MS
): Coalescer<T> {
  const buckets = new Map<string, Bucket>()
  let disposed = false

  const arm = (key: string, bucket: Bucket): ReturnType<typeof setTimeout> =>
    setTimeout(() => {
      if (disposed) return
      if (!bucket.dirty) {
        buckets.delete(key)
        return
      }
      const taskIds = bucket.unknown ? null : [...bucket.ids]
      bucket.dirty = false
      bucket.unknown = false
      bucket.ids = new Set()
      bucket.timer = arm(key, bucket)
      deliver(taskIds)
    }, windowMs)

  return {
    push(change) {
      if (disposed) return
      const key = currentSecurityContext()?.actor ?? ''
      const ids = idsOf(change)
      const open = buckets.get(key)
      if (open) {
        open.dirty = true
        if (!ids) open.unknown = true
        else for (const id of ids) open.ids.add(id)
        return
      }
      const bucket: Bucket = {
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
        dirty: false,
        unknown: false,
        ids: new Set()
      }
      bucket.timer = arm(key, bucket)
      buckets.set(key, bucket)
      deliver(ids ? [...ids] : null)
    },
    dispose() {
      disposed = true
      for (const b of buckets.values()) clearTimeout(b.timer)
      buckets.clear()
    }
  }
}
