/**
 * The terminal feed's output, carried to the terminal in the web view. Every call
 * into a DOM component is a script injected into the web view, so the sink batches:
 * what arrives within one frame goes over as one call per operation, consecutive
 * writes joined into one. Order is kept (a reset or resize between writes stays
 * between them). Until the web view's terminal exists (`target()` null) everything
 * is held; `flush()` (called once it exists) or the next frame's flush sends it.
 */
import type { FeedSink } from './terminal-feed'

/** The calls the web view's terminal takes (`TerminalDom`'s handle). */
export interface DomTerminal {
  write(data: string): void
  reset(): void
  resize(cols: number, rows: number): void
}

type Op =
  | { kind: 'write'; data: string }
  | { kind: 'reset' }
  | { kind: 'resize'; cols: number; rows: number }

export function createDomSink(
  target: () => DomTerminal | null,
  schedule: (run: () => void) => void
): FeedSink & { flush(): void } {
  let ops: Op[] = []
  let scheduled = false

  const flush = (): void => {
    scheduled = false
    const terminal = target()
    if (!terminal) return
    const sending = ops
    ops = []
    for (const op of sending) {
      if (op.kind === 'write') terminal.write(op.data)
      else if (op.kind === 'reset') terminal.reset()
      else terminal.resize(op.cols, op.rows)
    }
  }

  const push = (op: Op): void => {
    const last = ops.at(-1)
    if (op.kind === 'write' && last?.kind === 'write') last.data += op.data
    else ops.push(op)
    if (!scheduled) {
      scheduled = true
      schedule(flush)
    }
  }

  return {
    write: (data) => push({ kind: 'write', data }),
    reset: () => push({ kind: 'reset' }),
    resize: (cols, rows) => push({ kind: 'resize', cols, rows }),
    flush
  }
}
