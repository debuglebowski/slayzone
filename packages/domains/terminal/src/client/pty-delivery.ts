/**
 * Seq-ordered, gap-aware delivery of each session's output to its terminal.
 *
 * A session's output can arrive over two paths: the hub relay and the direct link
 * to its computer (docs/direct-link.md). A terminal switches between them as
 * leases come and go, and the switch must not lose or repeat a byte.
 *  - A seq already delivered is dropped, so the two streams may overlap.
 *  - A chunk past `lastSeq + 1` is held, and the gap is read back once from the
 *    path that delivered the chunk. Then delivery continues in order, as mobile's
 *    `TerminalFeed` does. A gap the buffer no longer holds (evicted) is skipped
 *    rather than stalling the terminal.
 *  - A session's first chunk is taken as its start, whatever its seq: the
 *    terminal's attach wrote everything before it.
 *
 * @module terminal/client/pty-delivery
 */

export type PtyBackfill = (afterSeq: number) => Promise<Array<{ seq: number; data: string }>>

interface SessionDelivery {
  lastSeq: number
  pending: Map<number, string>
  filling: boolean
}

export interface PtyDelivery {
  /** Start accepting output for a session (a terminal subscribed). Idempotent. */
  open(sessionId: string): void
  deliver(sessionId: string, data: string, seq: number, backfill: PtyBackfill): void
  /**
   * The terminal wrote everything up to `seq` itself (its attach or replay): later
   * chunks continue from there, and a gap after it is read back. Never moves back.
   */
  advance(sessionId: string, seq: number): void
  /** The last seq delivered (-1 = none, or not open). */
  lastSeq(sessionId: string): number
  /** Forget the session (exit, mode switch): its next process starts at seq 0. */
  reset(sessionId: string): void
}

export function createPtyDelivery(opts: {
  emit: (sessionId: string, data: string, seq: number) => void
}): PtyDelivery {
  const sessions = new Map<string, SessionDelivery>()

  function accept(id: string, st: SessionDelivery, seq: number, data: string): void {
    st.lastSeq = seq
    opts.emit(id, data, seq)
  }

  function drain(id: string, st: SessionDelivery): void {
    while (st.pending.has(st.lastSeq + 1)) {
      const next = st.lastSeq + 1
      const data = st.pending.get(next) as string
      st.pending.delete(next)
      accept(id, st, next, data)
    }
  }

  function fill(id: string, st: SessionDelivery, backfill: PtyBackfill): void {
    st.filling = true
    const after = st.lastSeq
    void backfill(after)
      .catch(() => [])
      .then((chunks) => {
        // Reset or reopened meanwhile: this answer belongs to a session that is gone.
        if (sessions.get(id) !== st) return
        for (const c of chunks) {
          if (c.seq > st.lastSeq && !st.pending.has(c.seq)) st.pending.set(c.seq, c.data)
        }
        st.filling = false
        // In order; past a hole nobody can fill any more (evicted), move on.
        for (const seq of [...st.pending.keys()].sort((a, b) => a - b)) {
          if (seq <= st.lastSeq) {
            st.pending.delete(seq)
            continue
          }
          const data = st.pending.get(seq) as string
          st.pending.delete(seq)
          accept(id, st, seq, data)
        }
      })
  }

  return {
    open(sessionId) {
      if (!sessions.has(sessionId)) {
        sessions.set(sessionId, { lastSeq: -1, pending: new Map(), filling: false })
      }
    },
    deliver(sessionId, data, seq, backfill) {
      const st = sessions.get(sessionId)
      if (!st) return
      if (seq <= st.lastSeq || st.pending.has(seq)) return
      if (st.lastSeq < 0 && !st.filling) {
        accept(sessionId, st, seq, data)
        drain(sessionId, st)
        return
      }
      if (!st.filling && seq === st.lastSeq + 1) {
        accept(sessionId, st, seq, data)
        drain(sessionId, st)
        return
      }
      st.pending.set(seq, data)
      if (!st.filling) fill(sessionId, st, backfill)
    },
    advance(sessionId, seq) {
      const st = sessions.get(sessionId)
      if (!st || seq <= st.lastSeq) return
      st.lastSeq = seq
      for (const pending of [...st.pending.keys()]) if (pending <= seq) st.pending.delete(pending)
      if (!st.filling) drain(sessionId, st)
    },
    lastSeq(sessionId) {
      return sessions.get(sessionId)?.lastSeq ?? -1
    },
    reset(sessionId) {
      sessions.delete(sessionId)
    }
  }
}
