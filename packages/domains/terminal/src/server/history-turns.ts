/**
 * Turns for the heavy chat-history work of this process (Fix 3, FU4): reading
 * history pages, timeline projection folds / page writes / page drops, a move's
 * streamed export. Its own module — no transport, no child processes — so stores a
 * hub bundles (chat-runtime) take the same turns as the computer's chat logs.
 *
 * @module terminal/history-turns
 */

/** Let the event loop run (timers, sockets, heartbeats) between two pages of a long read. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * Turns for the heavy history work of this process, shared by every chat: reading a
 * history page (and what its caller does with it before awaiting again), and the
 * timeline projection's folds, page writes and page drops (`job`). One unit per
 * turn; while others wait, the event loop runs between turns. A burst of hydrates
 * (a restore opening dozens of tabs) then does about one unit per loop turn in
 * total — never one per tab per turn — so heartbeats and sockets stay answered.
 * (A lone long read yields between its own pages: `ChatEventLog.pages`.)
 */
export class HistoryReadTurns {
  private tail: Promise<void> = Promise.resolve()
  private waiting = 0

  take<T>(work: () => Promise<T>): Promise<T> {
    this.waiting++
    const run = this.tail.then(() => {
      this.waiting--
      return work()
    })
    const next = () => (this.waiting > 0 ? yieldToEventLoop() : undefined)
    this.tail = run.then(next, next)
    return run
  }

  /**
   * A long job (a projection rebuild's folds, its page writes, a page drop) done in
   * steps: each step in its turn (`take`), and the event loop ALWAYS runs between two
   * steps of the job, even with nobody waiting — its steps never run back to back in
   * one loop turn. No turn before its first step (`yieldFirst` asks for one) nor after
   * its last: a lone short job (an empty projection's one write) adds no loop turn to
   * what follows it (an agent's spawn). Never step from inside a turn's own work: that
   * waits on itself.
   */
  job(opts: { yieldFirst?: boolean } = {}): { step<T>(work: () => T | Promise<T>): Promise<T> } {
    let started = !!opts.yieldFirst
    return {
      step: async <T>(work: () => T | Promise<T>): Promise<T> => {
        if (started) await yieldToEventLoop()
        started = true
        return this.take(async () => work())
      }
    }
  }
}

/** This process's {@link HistoryReadTurns}. */
export const historyReadTurns = new HistoryReadTurns()
