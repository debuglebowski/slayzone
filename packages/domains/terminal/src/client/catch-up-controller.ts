/**
 * A terminal's catch-up from the session's scrollback while live output keeps
 * arriving. During a catch-up, live chunks are held (`hold`) and merged with what
 * the scrollback returned, by seq ({@link mergeCatchUp}): each chunk once, in order.
 *
 * Nothing is ever dropped: a cancelled catch-up (the tab was switched while it
 * awaited) still writes what it holds and what it fetched — dropping them left a
 * hole the next catch-up never asked for, since later live chunks moved the
 * rendered seq past it. Catch-ups run one at a time (tab activation and a computer
 * reconnect can overlap): each starts from where the previous one left off.
 *
 * @module terminal/client/catch-up-controller
 */
import { mergeCatchUp, type SeqChunk } from './catch-up-merge'

export interface CatchUpDeps {
  fetchSince(afterSeq: number): Promise<{ chunks: SeqChunk[]; prelude?: string } | null>
  write(chunk: SeqChunk): void
  /** A first restore (nothing rendered yet) into a buffer that evicted its head. */
  writePrelude(prelude: string): void
  renderedSeq(): number
  clearedSeq(): number | null
  /** Drain throttled live chunks so the rendered seq is true before asking. */
  flushPending(): void
}

export interface CatchUpController {
  /** Hold a live chunk while a catch-up runs; false = none runs, write it now. */
  hold(chunk: SeqChunk): boolean
  /** One catch-up (queued behind a running one). `wrote`: it wrote anything. */
  run(isCancelled: () => boolean): Promise<{ wrote: boolean }>
}

export function createCatchUpController(deps: CatchUpDeps): CatchUpController {
  let held: SeqChunk[] | null = null
  let tail: Promise<unknown> = Promise.resolve()

  const take = (): SeqChunk[] => {
    const out = held ?? []
    held = null
    return out
  }
  const writeAll = (chunks: readonly SeqChunk[]): void => {
    for (const chunk of chunks) deps.write(chunk)
  }

  async function once(): Promise<{ wrote: boolean }> {
    deps.flushPending()
    const afterSeq = deps.renderedSeq()
    held = []
    let missed: Awaited<ReturnType<CatchUpDeps['fetchSince']>>
    try {
      missed = await deps.fetchSince(afterSeq)
    } catch (err) {
      // Release what was held: it still has to be shown.
      writeAll(mergeCatchUp(deps.renderedSeq(), [], take(), deps.clearedSeq()))
      throw err
    }
    // Cancelled or not, write it: it is in hand, and dropping it is a hole.
    const chunks = mergeCatchUp(deps.renderedSeq(), missed?.chunks ?? [], take(), deps.clearedSeq())
    if (chunks.length > 0 && afterSeq === -1 && missed?.prelude) deps.writePrelude(missed.prelude)
    writeAll(chunks)
    return { wrote: chunks.length > 0 }
  }

  return {
    hold(chunk) {
      if (!held) return false
      held.push(chunk)
      return true
    },
    run(_isCancelled) {
      const result = tail.then(() => once())
      tail = result.catch(() => undefined)
      return result
    }
  }
}
