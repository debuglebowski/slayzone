/**
 * The non-React half of `TerminalView`: what happens between the hub, the feed and
 * the web view's terminal, kept in one object so the component holds no refs or
 * clocks during render.
 *
 * - Start the feed once BOTH hold: the data subscription runs (nothing is missed)
 *   and the web view's terminal exists (something receives it). Each later
 *   subscription start (a reconnect) catches up; a reloaded web view gets the
 *   session replayed.
 * - Report the user's presence (`pty.touch`) at most every 4s, desktop's throttle.
 */
import type { HubClient } from '../hub-board'
import { createDomSink, type DomTerminal } from './dom-sink'
import { type FeedClient, type FeedStatus, TerminalFeed } from './terminal-feed'

/** Desktop's throttle for the "user engaged" report. */
export const TOUCH_THROTTLE_MS = 4_000

export class TerminalController {
  readonly feed: TerminalFeed
  /** The web view terminal's handle, as its `ref` holds it (`attachTerminal`). */
  private terminal: { readonly current: DomTerminal | null } | null = null
  private readonly sink: ReturnType<typeof createDomSink>
  private subscribed = false
  private domReady = false
  private lastTouch = 0

  constructor(
    private readonly sessionId: string,
    private readonly client: HubClient,
    onStatus: (status: FeedStatus) => void,
    schedule: (run: () => void) => void = (run) => requestAnimationFrame(run)
  ) {
    const feedClient: FeedClient = {
      attach: (sid, afterSeq) => client.pty.attach.query({ sessionId: sid, afterSeq }),
      bufferSince: (sid, afterSeq) => client.pty.getBufferSince.query({ sessionId: sid, afterSeq })
    }
    this.sink = createDomSink(() => this.terminal?.current ?? null, schedule)
    this.feed = new TerminalFeed(sessionId, feedClient, this.sink, onStatus)
  }

  /** The `ref` the web view's terminal fills with its handle (set after mount). */
  attachTerminal(ref: { readonly current: DomTerminal | null }): void {
    this.terminal = ref
    this.sink.flush()
    // Mounted again with a feed already under way (a remount reuses this object).
    if (this.subscribed && this.domReady) void this.feed.restart()
  }

  /** The data subscription started (again). */
  subscriptionStarted(): void {
    this.subscribed = true
    if (this.domReady) void this.feed.start()
  }

  /** The web view's terminal exists (again, after a reload). */
  async terminalReady(): Promise<void> {
    const reloaded = this.domReady
    this.domReady = true
    if (!this.subscribed) return
    await (reloaded ? this.feed.restart() : this.feed.start())
  }

  /** The user is here (`force`: opened) — throttled unless forced. */
  touch(force: boolean): void {
    const now = Date.now()
    if (!force && now - this.lastTouch < TOUCH_THROTTLE_MS) return
    this.lastTouch = now
    this.client.pty.touch.mutate({ sessionId: this.sessionId }).catch(() => undefined)
  }

  dispose(): void {
    this.feed.dispose()
  }
}
