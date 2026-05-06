import type { BufferChunk } from '@slayzone/terminal/shared'

export type { BufferChunk }

/**
 * Ring buffer for terminal output with fixed maximum size.
 * Drops oldest content when capacity is exceeded.
 * Each chunk has a monotonic sequence number for ordering.
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
   * Append data to the buffer. Drops oldest chunks if over capacity.
   * Returns the sequence number assigned to this chunk.
   */
  append(data: string): number {
    const seq = this.nextSeq++
    this.chunks.push({ seq, data })
    this.totalSize += data.length

    // Drop oldest chunks until under max size
    let droppedAny = false
    while (this.totalSize > this.maxSize && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!
      this.totalSize -= dropped.data.length
      droppedAny = true
    }

    // Prepend ANSI reset if chunks were dropped (reset codes may have been lost)
    if (droppedAny && this.chunks.length > 0) {
      this.chunks[0] = { seq: this.chunks[0].seq, data: '\x1b[0m' + this.chunks[0].data }
      this.totalSize += 4
    }

    // If single chunk still exceeds max, truncate it
    if (this.totalSize > this.maxSize && this.chunks.length === 1) {
      // Prepend ANSI reset in case truncation cuts mid-sequence
      this.chunks[0] = { seq: this.chunks[0].seq, data: '\x1b[0m' + this.chunks[0].data.slice(-this.maxSize) }
      this.totalSize = this.chunks[0].data.length
    }

    return seq
  }

  /**
   * Get all chunks with sequence number > afterSeq.
   * Returns empty array if afterSeq >= latest seq.
   */
  getChunksSince(afterSeq: number): BufferChunk[] {
    return this.chunks.filter(c => c.seq > afterSeq)
  }

  /**
   * Get the current (latest) sequence number.
   * Returns -1 if buffer is empty.
   */
  getCurrentSeq(): number {
    return this.nextSeq - 1
  }

  /**
   * Get the full buffer contents as a string.
   */
  toString(): string {
    return this.chunks.map(c => c.data).join('')
  }

  /**
   * Clear the buffer.
   */
  clear(): void {
    this.chunks = []
    this.totalSize = 0
    // Keep nextSeq incrementing to avoid confusion with old sequences
  }

  /**
   * Get current size in bytes.
   */
  get size(): number {
    return this.totalSize
  }
}
