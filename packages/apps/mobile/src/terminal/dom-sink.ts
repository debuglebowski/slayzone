/**
 * The terminal feed's output, carried to the terminal in the web view. Every call
 * into a DOM component is a script injected into the web view, so the sink batches:
 * what arrives within one frame goes over as one call per operation, consecutive
 * writes joined into one. Order is kept (a reset or resize between writes stays
 * between them). Until the web view's terminal exists (`target()` null) everything
 * is held; `flush()` (called once it exists) or the next frame's flush sends it.
 *
 * A write is sent in pieces of at most `MAX_WRITE` characters, `WRITES_PER_FRAME`
 * of them per frame, the rest the frame after: a session's whole scrollback replayed
 * at attach is megabytes, and one script that size stalls the web view.
 */
import type { FeedSink } from './terminal-feed'

/** The calls the web view's terminal takes (`TerminalDom`'s handle). */
export interface DomTerminal {
  write(data: string): void
  reset(): void
  resize(cols: number, rows: number): void
}

/** The largest write sent in one call (UTF-16 code units). */
export const MAX_WRITE = 64 * 1024
/** Writes sent per frame; more wait for the next frame. */
export const WRITES_PER_FRAME = 4

type Op =
  | { kind: 'write'; data: string }
  | { kind: 'reset' }
  | { kind: 'resize'; cols: number; rows: number }

/** Where `data`'s first piece ends: at most `MAX_WRITE`, never inside a surrogate pair. */
function firstPieceEnd(data: string): number {
  if (data.length <= MAX_WRITE) return data.length
  const last = data.charCodeAt(MAX_WRITE - 1)
  return last >= 0xd800 && last <= 0xdbff ? MAX_WRITE - 1 : MAX_WRITE
}

export function createDomSink(
  target: () => DomTerminal | null,
  schedule: (run: () => void) => void
): FeedSink & { flush(): void } {
  const ops: Op[] = []
  let scheduled = false

  const later = (): void => {
    if (scheduled) return
    scheduled = true
    schedule(flush)
  }

  const flush = (): void => {
    scheduled = false
    const terminal = target()
    if (!terminal) return
    let writes = 0
    while (ops.length > 0) {
      const op = ops[0]
      if (op.kind === 'write') {
        if (writes === WRITES_PER_FRAME) break
        const end = firstPieceEnd(op.data)
        terminal.write(op.data.slice(0, end))
        writes++
        if (end < op.data.length) {
          op.data = op.data.slice(end)
          continue
        }
      } else if (op.kind === 'reset') terminal.reset()
      else terminal.resize(op.cols, op.rows)
      ops.shift()
    }
    if (ops.length > 0) later()
  }

  const push = (op: Op): void => {
    const last = ops.at(-1)
    if (op.kind === 'write' && last?.kind === 'write') last.data += op.data
    else ops.push(op)
    later()
  }

  return {
    write: (data) => push({ kind: 'write', data }),
    reset: () => push({ kind: 'reset' }),
    resize: (cols, rows) => push({ kind: 'resize', cols, rows }),
    flush
  }
}
