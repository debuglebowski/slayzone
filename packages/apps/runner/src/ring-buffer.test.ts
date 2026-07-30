/**
 * Unit tests for the runner-side ring buffer.
 *
 * The invariant under test is the one the hub's demux depends on: a chunk's bytes
 * are IMMUTABLE once appended. `handlers/pty.ts` documents live frames and
 * backfilled frames as "interchangeable by contract" — the hub keeps whichever
 * copy of a seq arrives first (`exec-proxies.ts` ingest/backfill), so if the
 * buffered copy of seq N differs from what was streamed live as seq N, the
 * rendered output depends on delivery timing. That is a silent corruption at
 * exactly the boundary the demux interleaves.
 */
import { describe, expect, it } from 'vitest'
import { RingBuffer } from './ring-buffer'

describe('RingBuffer', () => {
  it('assigns monotonic sequence numbers starting at 0', () => {
    // The hub's `lastSeq` starts at -1 precisely because this starts at 0.
    const buf = new RingBuffer(1024)
    expect(buf.append('a')).toBe(0)
    expect(buf.append('b')).toBe(1)
    expect(buf.append('c')).toBe(2)
    expect(buf.getCurrentSeq()).toBe(2)
  })

  it('returns exactly the bytes that were appended, even across an eviction', () => {
    // Eviction used to prepend ESC[0m onto the surviving head chunk, so the
    // backfilled copy of that seq carried 4 bytes the live copy never had.
    const buf = new RingBuffer(10)
    buf.append('0123456789') // seq 0 — fills the cap
    buf.append('abc') // seq 1 — forces seq 0 out

    const frames = buf.getChunksSince(-1)
    for (const f of frames) {
      expect(f.data, `seq ${f.seq} must be verbatim`).not.toContain('\x1b[0m')
    }
    // The surviving chunk is its original payload, unmodified.
    expect(frames.map((f) => f.data)).toEqual(['abc'])
  })

  it('keeps a chunk byte-identical to what append() received', () => {
    const buf = new RingBuffer(16)
    const payloads = ['\x1b[32mgreen', 'plain', 'x'.repeat(20), 'tail']
    const seqs = payloads.map((p) => buf.append(p))

    // Whatever survives must match its original payload exactly.
    for (const chunk of buf.getChunksSince(-1)) {
      const idx = seqs.indexOf(chunk.seq)
      expect(idx, 'seq maps to an appended payload').toBeGreaterThanOrEqual(0)
      expect(chunk.data, `seq ${chunk.seq} unmodified`).toBe(payloads[idx])
    }
  })

  it('evicts an oversized single chunk rather than truncating it', () => {
    // Truncation kept the seq but changed its bytes — a backfill would then
    // report a *different* payload under a seq already delivered verbatim.
    // Dropping it makes the gap honest: the hub skips forward instead of
    // rendering divergent bytes.
    const buf = new RingBuffer(8)
    const seq = buf.append('x'.repeat(100))

    const frames = buf.getChunksSince(-1)
    expect(frames.find((f) => f.seq === seq)).toBeUndefined()
    expect(buf.size).toBeLessThanOrEqual(8)
    // Seq numbering still advanced — no reuse.
    expect(buf.getCurrentSeq()).toBe(seq)
  })

  it('tracks size honestly after eviction', () => {
    const buf = new RingBuffer(10)
    buf.append('12345')
    buf.append('67890')
    buf.append('abc')
    expect(buf.size).toBe(buf.toString().length)
    expect(buf.size).toBeLessThanOrEqual(10)
  })

  it('getChunksSince returns only newer frames', () => {
    const buf = new RingBuffer(1024)
    buf.append('a')
    buf.append('b')
    buf.append('c')
    expect(buf.getChunksSince(0).map((c) => c.data)).toEqual(['b', 'c'])
    expect(buf.getChunksSince(2)).toEqual([])
    // -1 is the "from the very beginning" request the hub issues on a seq-0 gap.
    expect(buf.getChunksSince(-1).map((c) => c.data)).toEqual(['a', 'b', 'c'])
  })

  it('clear() empties the buffer without reusing sequence numbers', () => {
    const buf = new RingBuffer(1024)
    buf.append('a')
    buf.append('b')
    buf.clear()
    expect(buf.size).toBe(0)
    expect(buf.toString()).toBe('')
    // A reused seq would make the hub treat new output as an already-seen frame.
    expect(buf.append('c')).toBe(2)
  })
})
