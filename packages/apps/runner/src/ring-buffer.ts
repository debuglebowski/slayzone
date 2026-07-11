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
    let droppedAny = false
    while (this.totalSize > this.maxSize && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!
      this.totalSize -= dropped.data.length
      droppedAny = true
    }

    // Prepend ANSI reset if chunks were dropped (reset codes may have been lost).
    if (droppedAny && this.chunks.length > 0) {
      this.chunks[0] = { seq: this.chunks[0].seq, data: '\x1b[0m' + this.chunks[0].data }
      this.totalSize += 4
    }

    // If a single chunk still exceeds max, truncate it.
    if (this.totalSize > this.maxSize && this.chunks.length === 1) {
      this.chunks[0] = {
        seq: this.chunks[0].seq,
        data: '\x1b[0m' + this.chunks[0].data.slice(-this.maxSize)
      }
      this.totalSize = this.chunks[0].data.length
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
