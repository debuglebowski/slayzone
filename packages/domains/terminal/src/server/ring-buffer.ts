import type { BufferChunk } from '@slayzone/terminal/shared'

export type { BufferChunk }

/**
 * State-resetting prelude prepended to a REPLAY whose head was evicted.
 *
 * Eviction drops arbitrary leading bytes, so the retained content can depend on
 * state the evicted prefix established. Replay targets a freshly-created xterm
 * with default state, so that state has to be asserted explicitly:
 *
 *   ESC[0m  — SGR reset: drop colour / bold / underline set by evicted output.
 *   ESC(B   — designate ASCII as G0: an evicted `ESC(0` would otherwise leave the
 *             replay in line-drawing mode, rendering text as box characters.
 *   ESC[r   — reset the scroll region: an evicted DECSTBM would confine all
 *             replayed output to a stale window.
 *
 * Alt-screen is deliberately absent. Asserting `ESC[?1049l` would tell the
 * terminal it is on the normal screen while a running fullscreen program believes
 * it owns the alternate one — desyncing the two. The program's own next repaint is
 * the only safe authority on that bit.
 */
const REPLAY_PRELUDE = '\x1b[0m\x1b(B\x1b[r'

/**
 * A parameter run at the very start of retained content, left behind when eviction
 * cut away the `ESC [` that introduced it. Replaying it prints the raw parameters
 * as text — a head of `32mhello` shows "32mhello".
 *
 * The parameter run is REQUIRED (`+`, not `*`): with `*` this matches a single
 * leading letter of ordinary text, since a plain `a` is inside the CSI final-byte
 * range `@-~` — so retained content beginning "abcdefgh" would silently lose its
 * "a". Requiring at least one parameter byte means a match needs the shape of a
 * torn sequence, which plain prose does not have.
 *
 * A one-character false positive is still possible in theory (text starting
 * literally "32m"), but that costs a stray character in scrollback, whereas
 * leaving a real orphan in place corrupts the rendered attributes of everything
 * after it.
 */
const ORPHANED_SEQUENCE_HEAD = /^[0-9;:?<>]+[@-~]/

/**
 * Ring buffer for terminal output with fixed maximum size.
 * Drops oldest content when capacity is exceeded.
 * Each chunk has a monotonic sequence number for ordering.
 *
 * Stored chunks are IMMUTABLE: `getChunksSince` hands back exactly the bytes that
 * were appended, because incremental catch-up is applied to an already-correct
 * terminal (and the hub↔runner contract requires a seq's bytes not to vary by
 * delivery path). Eviction resync is applied at READ time by {@link toString},
 * which is the wholesale-replay-into-a-fresh-terminal path.
 */
export class RingBuffer {
  private chunks: BufferChunk[] = []
  private totalSize = 0
  private readonly maxSize: number
  private nextSeq = 0
  /** True once any content has been evicted, so a full replay needs the prelude. */
  private evicted = false

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
    while (this.totalSize > this.maxSize && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!
      this.totalSize -= dropped.data.length
      this.evicted = true
    }

    // A single chunk over the cap keeps only its tail. Bytes are dropped, so this
    // is an eviction like any other — the prelude covers the state it lost.
    if (this.totalSize > this.maxSize && this.chunks.length === 1) {
      const head = this.chunks[0]
      this.chunks[0] = { seq: head.seq, data: head.data.slice(-this.maxSize) }
      this.totalSize = this.chunks[0].data.length
      this.evicted = true
    }

    return seq
  }

  /**
   * Get all chunks with sequence number > afterSeq.
   * Returns empty array if afterSeq >= latest seq.
   *
   * Bytes are verbatim — no prelude, no rewriting. These chunks are appended to a
   * terminal that is already in the right state, so injecting a reset here would
   * clobber live attributes mid-stream.
   */
  getChunksSince(afterSeq: number): BufferChunk[] {
    return this.chunks.filter((c) => c.seq > afterSeq)
  }

  /**
   * Get the current (latest) sequence number.
   * Returns -1 if buffer is empty.
   */
  getCurrentSeq(): number {
    return this.nextSeq - 1
  }

  /**
   * Full buffer contents, ready to replay into a FRESH terminal.
   *
   * When nothing has been evicted this is the exact byte stream — the stream sets
   * up its own state and a prelude would stomp it. Once eviction has occurred the
   * result is repaired for replay: any escape sequence torn open at the head is
   * dropped (its introducer is gone, so it would print as literal text) and
   * {@link REPLAY_PRELUDE} asserts the state the evicted prefix used to establish.
   */
  toString(): string {
    const joined = this.chunks.map((c) => c.data).join('')
    if (!this.evicted) return joined
    return REPLAY_PRELUDE + joined.replace(ORPHANED_SEQUENCE_HEAD, '')
  }

  /**
   * Clear the buffer.
   */
  clear(): void {
    this.chunks = []
    this.totalSize = 0
    // An explicit clear is a caller-driven reset, not data loss: the next replay
    // starts from whatever is appended after it, so no eviction prelude applies.
    this.evicted = false
    // Keep nextSeq incrementing to avoid confusion with old sequences
  }

  /**
   * Get current size in bytes.
   */
  get size(): number {
    return this.totalSize
  }
}
