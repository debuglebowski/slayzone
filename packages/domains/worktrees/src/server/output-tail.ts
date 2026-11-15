/**
 * A long-running command's output, bounded (FU1 S4): the LAST `maxBytes` of it
 * (UTF-8, never split inside a character) plus its total size, kept while it
 * streams — never the whole output in memory or in one reply. A worktree setup
 * script's reply uses it; the full output streams to the hub as it is produced.
 *
 * @module worktrees/server/output-tail
 */

/** How much of a setup script's output its reply carries: the last 1 MiB. */
export const SETUP_OUTPUT_TAIL_BYTES = 1024 * 1024

/** Chars of the output's start kept for diagnostics (as `trimOutput` shows them). */
const HEAD_CHARS = 4096

export interface OutputTailResult {
  /** The output (trimmed), or its last `maxBytes` when it was longer. */
  output: string
  /** UTF-8 bytes of the whole output. */
  outputBytes: number
  /** Set when `output` is only the end of it. */
  outputTruncated?: true
}

export function createOutputTail(maxBytes = SETUP_OUTPUT_TAIL_BYTES) {
  const chunks: Buffer[] = []
  let kept = 0
  let total = 0
  let head = ''
  return {
    push(text: string): void {
      if (head.length < HEAD_CHARS) head += text.slice(0, HEAD_CHARS - head.length)
      const b = Buffer.from(text)
      total += b.length
      chunks.push(b)
      kept += b.length
      // Drop whole chunks the tail no longer needs.
      while (chunks.length > 1 && kept - chunks[0].length >= maxBytes)
        kept -= chunks.shift()!.length
    },
    result(): OutputTailResult {
      const all = Buffer.concat(chunks)
      if (total <= maxBytes) return { output: all.toString('utf8').trim(), outputBytes: total }
      let start = all.length - maxBytes
      while (start < all.length && (all[start] & 0xc0) === 0x80) start++ // a char boundary
      return {
        output: all.subarray(start).toString('utf8').trim(),
        outputBytes: total,
        outputTruncated: true
      }
    },
    /** The output's start (for a diagnostic that shows its head). */
    head(): string {
      return head
    }
  }
}
