/**
 * A headless copy of one session's terminal, kept on the server so that queries
 * whose answer depends on terminal STATE are answered like a real terminal would:
 * from the state at that exact point in the stream, in the order they were asked.
 *
 * Why the server and not the client's xterm.js: a client answer travels the async
 * renderer round trip (and there may be no client mounted at all), so it lands in
 * the program's stdin late, after the program stopped waiting — garbage in its
 * input. Stateless queries are answered by `computeSyncQueryResponse`; this covers
 * the rest, which used to be either answered late by the client (DECRQM, DECRQSS)
 * or answered with a constant (CPR always said row 1, column 1).
 *
 * The answers come from xterm.js's own InputHandler, the same code the client
 * runs, so they match what the client would have said — byte for byte — without a
 * hand-written copy of terminal logic. The mirror runs the same xterm.js commit as
 * the client (package.json lockstep) and the same unicode width tables, so wide
 * glyphs move the cursor identically.
 *
 * Ordering: every part of a chunk goes through xterm's write queue, whose
 * callbacks fire in order; a stateless reply that arrives while mirror writes are
 * still pending is queued behind them (an empty write with a callback), so it can
 * never overtake the answer to an earlier stateful query. With nothing pending it
 * is sent synchronously, exactly as before the mirror existed.
 *
 * DECXCPR (`CSI ? 6 n`) is deliberately left unanswered, as it always was: Claude
 * Code polls it and reads an answer of row 1 as "screen externally wiped" →
 * `/clear` → a new session. Answering it is a separate decision with that blast
 * radius, not a side effect of this mirror.
 */
import * as headless from '@xterm/headless'
// The addon must load with Node's Buffer pool off (see ./buffer-pool-off): in import
// order — off, the addon, on.
import './buffer-pool-off'
import * as graphemes from '@xterm/addon-unicode-graphemes'
import './buffer-pool-on'
import type { SyncQueryPart } from './sync-query-response'

// Both packages ship CJS/UMD only; depending on the ESM interop in use the
// export can land on the namespace or under `default`.
type Ns<K extends string, T> = { [P in K]?: T } & { default?: { [P in K]: T } }
const HeadlessTerminal =
  (headless as unknown as Ns<'Terminal', typeof headless.Terminal>).Terminal ??
  (headless as unknown as Ns<'Terminal', typeof headless.Terminal>).default?.Terminal
const UnicodeGraphemesAddon =
  (graphemes as unknown as Ns<'UnicodeGraphemesAddon', typeof graphemes.UnicodeGraphemesAddon>)
    .UnicodeGraphemesAddon ??
  (graphemes as unknown as Ns<'UnicodeGraphemesAddon', typeof graphemes.UnicodeGraphemesAddon>)
    .default?.UnicodeGraphemesAddon

export class TerminalReplyMirror {
  private readonly term: headless.Terminal
  private pending = 0
  private disposed = false

  constructor(
    cols: number,
    rows: number,
    private readonly sendReply: (data: string) => void
  ) {
    if (!HeadlessTerminal || !UnicodeGraphemesAddon) {
      throw new Error('TerminalReplyMirror: could not resolve @xterm/headless or its unicode addon')
    }
    this.term = new HeadlessTerminal({
      cols,
      rows,
      // State queries need the screen, not history.
      scrollback: 0,
      // Same buffer semantics as the client terminal (xterm-init.ts).
      scrollOnEraseInDisplay: true,
      allowProposedApi: true,
      logLevel: 'off'
    })
    // Same width tables as the client (xterm-init.ts) — otherwise emoji and
    // combining marks put the mirror's cursor somewhere the screen's isn't.
    this.term.loadAddon(new UnicodeGraphemesAddon())
    this.term.unicode.activeVersion = '15-graphemes'
    // DEC private DSR (incl. DECXCPR) stays unanswered — see the module doc.
    this.term.parser.registerCsiHandler({ prefix: '?', final: 'n' }, () => true)
    // A headless terminal has no keyboard: everything it emits is a reply.
    this.term.onData((data) => {
      if (!this.disposed) this.sendReply(data)
    })
  }

  /** Process one chunk's parts, in order. */
  apply(parts: readonly SyncQueryPart[]): void {
    if (this.disposed) return
    for (const part of parts) {
      if (part.kind === 'reply') this.reply(part.data)
      else this.write(part.data)
    }
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return
    this.term.resize(cols, rows)
  }

  /** Resolves once everything handed to the mirror so far is processed. */
  drained(): Promise<void> {
    return new Promise((resolve) => {
      if (this.disposed) resolve()
      else this.term.write('', resolve)
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.term.dispose()
  }

  private write(data: string): void {
    this.pending++
    this.term.write(data, () => {
      this.pending--
    })
  }

  private reply(data: string): void {
    if (this.pending === 0) {
      this.sendReply(data)
      return
    }
    this.pending++
    this.term.write('', () => {
      this.pending--
      if (!this.disposed) this.sendReply(data)
    })
  }
}
