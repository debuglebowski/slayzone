/**
 * Per conversation: the newest saved event sequence the hub relayed WITHOUT a
 * gap since it last knew the client's history was complete.
 *
 * Recovery compares it with the computer's newest saved event. Behind = a client
 * may miss events, so only that chat reloads. Tracking the highest relayed
 * sequence instead would hide one lost event behind a later one. Events may
 * arrive out of order (relay handling is async), so later sequences wait in
 * `ahead` until the gap before them fills.
 */
export function createHistoryProgress(opts: { maxAhead?: number } = {}) {
  const maxAhead = opts.maxAhead ?? 1024
  type Progress = { seq: number; ahead: Set<number>; broken: boolean }
  const progress = new Map<string, Progress>()
  const entry = (id: string): Progress => {
    let p = progress.get(id)
    if (!p) {
      // Sequences start at 0: the first event of a new conversation has no gap.
      p = { seq: -1, ahead: new Set(), broken: false }
      progress.set(id, p)
    }
    return p
  }
  const advance = (p: Progress) => {
    while (p.ahead.delete(p.seq + 1)) p.seq++
    for (const seq of p.ahead) if (seq <= p.seq) p.ahead.delete(seq)
  }
  return {
    /** A saved event was relayed to clients. */
    observe(id: string, seq: number): void {
      const p = entry(id)
      if (p.broken || seq <= p.seq) return
      p.ahead.add(seq)
      advance(p)
      // A gap that never fills: stop buffering, the next recovery reloads.
      if (p.ahead.size > maxAhead) {
        p.broken = true
        p.ahead.clear()
      }
    },
    /**
     * Whether a client may lack events up to the computer's `seq`. Unknown
     * (`undefined`, an older computer) is behind.
     */
    behind(id: string, seq: number | undefined): boolean {
      if (seq === undefined) return true
      const p = progress.get(id)
      return p ? p.broken || seq > p.seq : seq > -1
    },
    /** Clients now hold history up to `seq`: reloaded, or found complete. */
    settle(id: string, seq: number): void {
      const p = entry(id)
      p.broken = false
      p.seq = Math.max(p.seq, seq)
      advance(p)
    },
    clear(): void {
      progress.clear()
    }
  }
}
