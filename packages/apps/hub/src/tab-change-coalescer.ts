/**
 * One notification per tab per window (FU5 computer stalls, request fan-out).
 *
 * The hub hears every saved user message, and then its delivery receipt, and told
 * every client each time that the task's prompts and sessions changed — every told
 * client re-read the sessions list, which costs the task's computer a summaries read
 * and two ledger queries. `notify(tab)` now opens a window on the first change of a
 * tab; `flush(tab)` runs once when it ends, `delayMs` later, however many changes it
 * caught. Latency is bounded by `delayMs` (a trailing window from the FIRST change,
 * never pushed back by later ones).
 *
 * @module hub/tab-change-coalescer
 */

export interface TabChangeCoalescer {
  /** A change of `tabId`: flushed at most `delayMs` from the first change of its window. */
  notify(tabId: string): void
  /** Drop every pending window (shutdown). */
  close(): void
}

export function createTabChangeCoalescer(opts: {
  delayMs: number
  flush(tabId: string): void
}): TabChangeCoalescer {
  const pending = new Map<string, ReturnType<typeof setTimeout>>()
  return {
    notify(tabId) {
      if (pending.has(tabId)) return
      const timer = setTimeout(() => {
        pending.delete(tabId)
        try {
          opts.flush(tabId)
        } catch {
          // A failed notification must not take the hub's timers down with it.
        }
      }, opts.delayMs)
      timer.unref?.()
      pending.set(tabId, timer)
    },
    close() {
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
    }
  }
}
