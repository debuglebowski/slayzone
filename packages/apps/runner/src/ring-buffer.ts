/**
 * Runner-side ring buffer for pty output. A faithful mirror of the terminal
 * domain's RingBuffer (`@slayzone/terminal` server/ring-buffer.ts): fixed byte
 * cap, oldest-first eviction, and a MONOTONIC per-session sequence number
 * assigned at append time. The runner owns seq assignment so the hub can detect
 * gaps and request replay via `pty.getBufferSince`.
 *
 * It is re-implemented here (rather than imported) to keep the runner a
 * lightweight standalone bundle — the terminal package drags in the full
 * React/electron app tree, which must never leak into the runner.
 *
 * @module runner/ring-buffer
 */

/** A single buffered output chunk with its monotonic sequence number. */
export interface BufferChunk {
  seq: number
  data: string
}

/**
 * Ring buffer for terminal output with a fixed maximum size. Drops the oldest
 * content when capacity is exceeded. Each chunk carries a monotonic sequence
 * number for gap detection / ordering.
 *
 * **Chunks are immutable once appended.** `handlers/pty.ts` states that live and
 * backfilled frames "are interchangeable by contract", and the hub's demux keeps
 * whichever copy of a seq lands first (`exec-proxies.ts`) — so a buffered copy
 * that differs from the bytes streamed live under the same seq makes the rendered
 * output depend on delivery timing.
 *
 * This buffer therefore does NOT do eviction-boundary resync (it used to prepend
 * `ESC[0m` to the surviving head chunk, and truncate an oversized single chunk in
 * place). Neither is meaningful here: this buffer exists solely for short-range
 * gap backfill via `getChunksSince`, and the HUB's own RingBuffer
 * (`@slayzone/terminal` server/ring-buffer.ts) owns replay-prelude resync, which
 * is where a real terminal is being repopulated from scratch.
 */
export class RingBuffer {
  private chunks: BufferChunk[] = []
  private totalSize = 0
  private readonly maxSize: number
  private nextSeq = 0

  constructor(maxSize: number) {
    this.maxSize = maxSize
  }

  /**
   * Append data to the buffer, dropping oldest chunks if over capacity.
   * Returns the sequence number assigned to this chunk.
   */
  append(data: string): number {
    const seq = this.nextSeq++
    this.chunks.push({ seq, data })
    this.totalSize += data.length

    // Drop oldest chunks until under max size.
    while (this.totalSize > this.maxSize && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!
      this.totalSize -= dropped.data.length
    }

    // A single chunk over the cap is DROPPED, not truncated — see the immutability
    // note below. Its seq is not reused, so the hub sees an honest gap, fails to
    // backfill it, and skips forward; truncating would instead hand back different
    // bytes under a seq it may already have delivered verbatim.
    if (this.totalSize > this.maxSize && this.chunks.length === 1) {
      this.chunks = []
      this.totalSize = 0
    }

    return seq
  }

  /**
   * Get all chunks with sequence number > afterSeq. Returns an empty array when
   * afterSeq >= the latest seq (or the requested tail has been evicted).
   */
  getChunksSince(afterSeq: number): BufferChunk[] {
    return this.chunks.filter((c) => c.seq > afterSeq)
  }

  /** Latest assigned sequence number, or -1 when the buffer is empty. */
  getCurrentSeq(): number {
    return this.nextSeq - 1
  }

  /** Full buffer contents joined as a string. */
  toString(): string {
    return this.chunks.map((c) => c.data).join('')
  }

  /** Clear the buffer; keeps nextSeq advancing to avoid seq reuse. */
  clear(): void {
    this.chunks = []
    this.totalSize = 0
  }

  /** Current buffered size in characters. */
  get size(): number {
    return this.totalSize
  }
}
