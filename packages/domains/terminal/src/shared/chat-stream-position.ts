/**
 * Where a client stands in one chat tab's event stream, and what each event the
 * server sends means for it — the rule desktop and mobile share. Pure: the
 * caller applies, drops, or resyncs as told.
 *
 *   - A SAVED event (`seq`) applies once, in seq order: anything at or below the
 *     newest applied seq is a duplicate.
 *   - A LIVE event (`live` set: never saved) belongs right after saved event
 *     `seq`: it applies only while that is the newest saved event here and its
 *     live counter is newer than the last one.
 *   - A live event can show this client is behind: one after a saved event it
 *     never got (the stream dropped it: a reconnect), or a `turn-status` from
 *     another server instance (`epoch`: the tab's computer restarted — its live
 *     counter started over). Both say `resync`: read what was missed
 *     (`catchUpNeedsReload` says when only a full reload will do).
 *   - The live part of a load (`snapshot`) applies at the position it was read
 *     for. From another instance, its live counter replaces this one.
 */
import type { AgentEvent } from '@slayzone/terminal-contracts'

/** The live part of a replay: what streams after saved event `afterSeq`. */
export interface ChatLiveSnapshot {
  afterSeq: number
  liveSeq: number
  events: readonly unknown[]
}

export class ChatStreamPosition {
  /** The newest saved event applied (-1 = none). */
  seq = -1
  /** The newest live counter applied after `seq`. */
  liveSeq = 0
  /** The server instance whose status this client holds (null = none seen). */
  epoch: string | null = null

  saved(seq: number): 'apply' | 'duplicate' {
    if (seq <= this.seq) return 'duplicate'
    this.seq = seq
    return 'apply'
  }

  live(event: AgentEvent, seq: number, live: number): 'apply' | 'drop' | 'resync' {
    const epoch = event.kind === 'turn-status' ? event.epoch : null
    if (epoch !== null && this.epoch !== null && epoch !== this.epoch) return 'resync'
    if (seq > this.seq) return 'resync'
    if (seq !== this.seq || live <= this.liveSeq) return 'drop'
    this.liveSeq = live
    if (epoch !== null) this.epoch = epoch
    return 'apply'
  }

  snapshot(live: ChatLiveSnapshot): 'apply' | 'skip' {
    if (live.afterSeq !== this.seq) return 'skip'
    const epoch = epochOf(live)
    if (epoch !== null && this.epoch !== null && epoch !== this.epoch) this.liveSeq = live.liveSeq
    else this.liveSeq = Math.max(this.liveSeq, live.liveSeq)
    if (epoch !== null) this.epoch = epoch
    return 'apply'
  }

  /**
   * A catch-up read the events after `seq`: a server behind this client (its log
   * restarted, or it no longer knows the tab), or the same instance with an older
   * live counter, cannot be caught up with — only a full reload.
   */
  catchUpNeedsReload(live: ChatLiveSnapshot): boolean {
    if (live.afterSeq < this.seq) return true
    const epoch = epochOf(live)
    const sameInstance = epoch === null || this.epoch === null || epoch === this.epoch
    return sameInstance && live.afterSeq === this.seq && live.liveSeq < this.liveSeq
  }

  reset(): void {
    this.seq = -1
    this.liveSeq = 0
    this.epoch = null
  }
}

function epochOf(live: ChatLiveSnapshot): string | null {
  let epoch: string | null = null
  for (const e of live.events as AgentEvent[]) if (e.kind === 'turn-status') epoch = e.epoch
  return epoch
}
