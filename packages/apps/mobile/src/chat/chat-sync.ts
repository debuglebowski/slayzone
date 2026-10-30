/**
 * Keeps one chat tab's timeline in step with its hub: which event goes into the
 * reducer, when, and in what order. Pure (no React, no client): the hook
 * (`useChatSession.ts`) feeds it what the hub sends and runs its loads; it dispatches
 * reducer actions (`@slayzone/terminal/reducer`, desktop's) into a sink.
 *
 * The rules are desktop's (`packages/domains/terminal/src/client/useChatSession.ts`),
 * plus what a phone needs on top — its socket drops whenever the app is in the
 * background:
 *
 *   - A SAVED event (`seq`) applies once, in seq order: anything at or below the
 *     newest applied seq is a duplicate.
 *   - A LIVE event (`live` set: a streaming fragment, a `sending` state — never saved)
 *     belongs right after saved event `seq`: it applies only while that is still the
 *     newest saved event here and its live counter is newer than the last one. Live
 *     events wait for the next frame and go to the reducer together (one render per
 *     frame of deltas); a saved event first applies what waits, so order holds.
 *   - While a LOAD runs, events are queued, then applied after the loaded history
 *     with the same dedup — whatever raced ahead of the load is neither lost nor
 *     doubled.
 *   - Loads: `full` = the whole history (`chat.getReplay` after -1), replacing the
 *     timeline when it is not the first; `catch-up` = only what was saved after the
 *     newest applied event (after a reconnect). A catch-up that finds the hub's log
 *     went backwards (reset elsewhere) or the tab's live counter restarted (a new tab
 *     instance, e.g. the hub restarted) answers `reload`: the caller runs a full load.
 *   - Once live, a saved event older than the newest applied one means the log
 *     restarted elsewhere (`chat.reset` from another client starts again at 0):
 *     `receive` answers `regressed` and applies nothing; the caller reloads.
 */
import type { AgentEvent } from '@slayzone/terminal-contracts'
import type { Action } from '@slayzone/terminal/reducer'

/** One `chat.onEvent` message. */
export interface ChatWireEvent {
  tabId: string
  /** The domain's own `AgentEvent` (the router types it `unknown`). */
  event: unknown
  seq: number
  live?: number
}

/** One `chat.onExit` message. */
export interface ChatWireExit {
  tabId: string
  sessionId: string
  code: number | null
  signal: string | null
}

/** `chat.getReplay`: saved events after `afterSeq` + what streams right now. */
export interface ChatReplay {
  events: ReadonlyArray<{ seq: number; event: unknown }>
  live: {
    /** The saved seq these live events follow (the log's newest). */
    afterSeq: number
    /** The tab's live counter at this snapshot. */
    liveSeq: number
    events: readonly unknown[]
  }
}

export interface ChatSyncSink {
  dispatch: (action: Action) => void
  /** Call `flush()` on the next frame. */
  requestFrame: () => void
  cancelFrame: () => void
}

export type LoadKind = 'full' | 'catch-up'

export interface LoadTicket {
  readonly gen: number
  readonly kind: LoadKind
  /** What to ask `chat.getReplay` for. */
  readonly afterSeq: number
}

/** A message this client sent that a full reload must not lose (`completeLoad`). */
export interface LocalMessage {
  id: string
  text: string
  /** Why its send failed; null = still on its way. */
  failed: string | null
}

export class ChatSync {
  private gen = 0
  private loadingGen: number | null = null
  private hasLoaded = false
  private newestSeq = -1
  private newestLive = 0
  private queue: ChatWireEvent[] = []
  private pendingLive: AgentEvent[] = []
  private framePending = false

  constructor(
    private readonly tabId: string,
    private readonly sink: ChatSyncSink
  ) {}

  /** A load runs: events are queued until it completes or fails. */
  get loading(): boolean {
    return this.loadingGen !== null
  }

  /** The newest saved event applied (-1 = none). */
  get lastSeq(): number {
    return this.newestSeq
  }

  /** A load completed (or failed) once: the next one replaces or catches up. */
  get loadedOnce(): boolean {
    return this.hasLoaded
  }

  /** The load is still the one running (no newer load replaced it). */
  isCurrent(ticket: LoadTicket): boolean {
    return ticket.gen === this.loadingGen
  }

  beginLoad(kind: LoadKind): LoadTicket {
    const gen = ++this.gen
    this.loadingGen = gen
    this.queue = []
    if (kind === 'full') {
      // Fragments of the old position must never apply after the new history.
      this.discardLive()
      return { gen, kind, afterSeq: -1 }
    }
    return { gen, kind, afterSeq: this.newestSeq }
  }

  /**
   * Apply a load's replay, then what was queued meanwhile. `keep`: messages this
   * client sent (full reload only) — any the replay lacks comes back as it was.
   */
  completeLoad(
    ticket: LoadTicket,
    replay: ChatReplay,
    keep: readonly LocalMessage[] = []
  ): 'done' | 'stale' | 'reload' {
    if (ticket.gen !== this.loadingGen) return 'stale'
    if (ticket.kind === 'catch-up') {
      if (replay.live.afterSeq < this.newestSeq || replay.live.liveSeq < this.newestLive) {
        return 'reload'
      }
    } else {
      if (this.hasLoaded) this.sink.dispatch({ type: 'reset' })
      this.newestSeq = -1
      this.newestLive = 0
    }
    const replayed = new Set<string>()
    for (const { seq, event } of replay.events) {
      const e = event as AgentEvent
      if (e.kind === 'user-message' && e.id) replayed.add(e.id)
      this.applySaved(e, seq)
    }
    // A reply mid-stream: its fragments are live-only (never saved) — redraw them.
    if (replay.live.afterSeq === this.newestSeq) {
      this.newestLive = Math.max(this.newestLive, replay.live.liveSeq)
      if (replay.live.events.length > 0) {
        this.sink.dispatch({ type: 'events', events: replay.live.events as AgentEvent[] })
      }
    }
    if (ticket.kind === 'full') {
      for (const m of keep) {
        if (replayed.has(m.id)) continue
        this.sink.dispatch({ type: 'user-sent', id: m.id, text: m.text })
        if (m.failed !== null)
          this.sink.dispatch({ type: 'user-send-failed', id: m.id, error: m.failed })
      }
    }
    this.goLive()
    return 'done'
  }

  /** The load failed: go live with what this client has, applying what was queued. */
  failLoad(ticket: LoadTicket): 'done' | 'stale' {
    if (ticket.gen !== this.loadingGen) return 'stale'
    this.goLive()
    return 'done'
  }

  /**
   * One `chat.onEvent` message. `regressed`: a saved event older than the newest
   * applied one arrived while live — the log restarted elsewhere; nothing applied.
   */
  receive(msg: ChatWireEvent): 'applied' | 'queued' | 'ignored' | 'regressed' {
    if (msg.tabId !== this.tabId) return 'ignored'
    if (this.loadingGen !== null) {
      this.queue.push(msg)
      return 'queued'
    }
    if (msg.live === undefined && msg.seq <= this.newestSeq) return 'regressed'
    return this.apply(msg) ? 'applied' : 'ignored'
  }

  /** One `chat.onExit` message: the tab's process ended. */
  exit(msg: ChatWireExit): void {
    if (msg.tabId !== this.tabId) return
    this.flush()
    this.sink.dispatch({
      type: 'process-exit',
      sessionId: msg.sessionId,
      code: msg.code,
      signal: msg.signal
    })
  }

  /** Apply the live fragments waiting for their frame (the frame callback). */
  flush(): void {
    if (this.framePending) {
      this.framePending = false
      this.sink.cancelFrame()
    }
    if (this.pendingLive.length === 0) return
    const events = this.pendingLive
    this.pendingLive = []
    this.sink.dispatch({ type: 'events', events })
  }

  /** Clear the timeline here at once (a reset this client asked for). */
  resetLocal(): void {
    this.discardLive()
    this.sink.dispatch({ type: 'reset' })
    this.newestSeq = -1
    this.newestLive = 0
  }

  /** Nothing of a running load or a waiting frame may apply any more. */
  dispose(): void {
    this.gen++
    this.loadingGen = null
    this.queue = []
    this.discardLive()
  }

  private goLive(): void {
    this.loadingGen = null
    this.hasLoaded = true
    const queued = this.queue
    this.queue = []
    for (const msg of queued) this.apply(msg)
    // The loaded state is complete at once, not a frame later.
    this.flush()
  }

  private apply(msg: ChatWireEvent): boolean {
    const event = msg.event as AgentEvent
    if (msg.live === undefined) return this.applySaved(event, msg.seq)
    if (msg.seq !== this.newestSeq || msg.live <= this.newestLive) return false
    this.newestLive = msg.live
    this.pendingLive.push(event)
    if (!this.framePending) {
      this.framePending = true
      this.sink.requestFrame()
    }
    return true
  }

  private applySaved(event: AgentEvent, seq: number): boolean {
    if (seq <= this.newestSeq) return false
    this.newestSeq = seq
    this.flush()
    this.sink.dispatch({ type: 'event', event })
    return true
  }

  private discardLive(): void {
    if (this.framePending) {
      this.framePending = false
      this.sink.cancelFrame()
    }
    this.pendingLive = []
  }
}
