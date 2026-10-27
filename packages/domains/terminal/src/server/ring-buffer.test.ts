/**
 * Unit tests for the HUB-side pty ring buffer.
 *
 * This buffer's job is different from the computer's mirror
 * (`packages/apps/computer/src/ring-buffer.ts`), and the difference decides the
 * design:
 *
 *   - The computer's copy exists ONLY for short-range gap backfill, where a chunk
 *     must stay byte-identical to what was streamed live under the same seq. It
 *     therefore never rewrites a chunk.
 *   - This one is replayed WHOLESALE into a freshly-created xterm on every mount /
 *     reattach (`getBuffer` → `toString()`). A fresh terminal has default state, so
 *     replay must not begin mid-escape-sequence and must not inherit attributes,
 *     charset, or a scroll region set by output that has since been evicted.
 *
 * So resync belongs here and only here, applied at READ time. It leaves the
 * STORED chunks immutable — `getChunksSince(afterSeq >= 0)`, the reattach
 * path, still returns verbatim bytes. `getChunksSince(afterSeq === -1)`, the
 * cold-attach path, gets the same repair as `toString()` (split into a
 * `prelude` plus repaired `chunks`, so a caller can write the prelude first).
 *
 */
import { expect, test } from 'vitest'
import { RingBuffer } from './ring-buffer'

test('assigns monotonic sequence numbers starting at 0', () => {
  const buf = new RingBuffer(1024)
  expect(buf.append('a')).toBe(0)
  expect(buf.append('b')).toBe(1)
  expect(buf.getCurrentSeq()).toBe(1)
})

test('no eviction: replay is the exact byte stream, no prelude', () => {
  // Nothing was lost, so the replay needs no state assertion — adding one would
  // stomp attributes the stream itself sets up.
  const buf = new RingBuffer(1024)
  buf.append('\x1b[32mgreen text')
  expect(buf.toString()).toBe('\x1b[32mgreen text')
})

test('getChunksSince on REATTACH (afterSeq >= 0) is verbatim, no prelude — even after eviction', () => {
  // Incremental catch-up appends into an ALREADY-correct terminal; injecting a
  // reset there would clobber live attributes mid-stream. Eviction having
  // occurred must not change this — only a COLD attach (afterSeq === -1) gets
  // the repair.
  const buf = new RingBuffer(10)
  buf.append('0123456789')
  const keptSeq = buf.append('abc') // evicts seq 0's chunk
  const { chunks, prelude } = buf.getChunksSince(keptSeq - 1)
  expect(prelude, 'reattach must not get a prelude').toBe('')
  expect(JSON.stringify(chunks)).toBe(JSON.stringify([{ seq: keptSeq, data: 'abc' }]))
})

test('getChunksSince on a COLD attach (afterSeq === -1) with no eviction: empty prelude, verbatim chunks', () => {
  const buf = new RingBuffer(1024)
  buf.append('\x1b[32mgreen text')
  const { chunks, prelude } = buf.getChunksSince(-1)
  expect(prelude).toBe('')
  expect(chunks.map((c) => c.data).join('')).toBe('\x1b[32mgreen text')
})

test('getChunksSince on a COLD attach after eviction: prelude + chunks matches toString() byte-for-byte', () => {
  const buf = new RingBuffer(10)
  buf.append('0123456789') // evicted
  buf.append('abcdefgh')
  const { chunks, prelude } = buf.getChunksSince(-1)
  expect(prelude).toBe('\x1b[0m\x1b(B\x1b[r')
  expect(prelude + chunks.map((c) => c.data).join('')).toBe(buf.toString())
})

test('getChunksSince cold-attach repair strips an orphaned CSI head from the chunk data itself', () => {
  // Two separate pty `data` events — one ending mid-escape, the next carrying
  // its tail — become two ring-buffer chunks. Eviction drops the first chunk
  // wholesale (its introducing `ESC [` with it), leaving the SURVIVING chunk
  // starting with a bare parameter run. The garbage must be gone from
  // `chunks` itself, not merely absent from the joined text by coincidence.
  const buf = new RingBuffer(15)
  buf.append('xxxxxxxxxx\x1b[') // 12 chars, will be evicted whole
  buf.append('32mHELLO') // 8 chars — survives, but now starts mid-CSI
  const { chunks, prelude } = buf.getChunksSince(-1)
  expect(chunks.length).toBe(1)
  expect(
    chunks[0].data,
    `orphaned "32m" head must be stripped from the chunk, got ${JSON.stringify(chunks[0].data)}`
  ).toBe('HELLO')
  expect(prelude, 'the orphaned head must not leak into the prelude either').not.toContain('32m')
})

test('getChunksSince cold-attach repair handles an orphaned head split ACROSS a chunk boundary', () => {
  // The torn parameter run "32m" arrives as two separate chunks: "3" then
  // "2m…". Matching only chunks[0] in isolation ('3') would not see the CSI
  // shape and would wrongly keep it — the repair must look at the joined text.
  const buf = new RingBuffer(1024)
  buf.append('x'.repeat(1024)) // fills the buffer so the next append evicts all of it
  buf.append('3') // now the sole retained chunk: an orphaned CSI param digit
  buf.append('2mHELLO')
  const { chunks, prelude } = buf.getChunksSince(-1)
  const joined = chunks.map((c) => c.data).join('')
  expect(
    joined,
    `orphaned head split across chunks must still be stripped, got ${JSON.stringify(joined)}`
  ).toBe('HELLO')
  expect(prelude).toBe('\x1b[0m\x1b(B\x1b[r')
})

test('getChunksSince on an EMPTY buffer cold attach: no chunks, no prelude (never evicted)', () => {
  const buf = new RingBuffer(1024)
  const { chunks, prelude } = buf.getChunksSince(-1)
  expect(chunks.length).toBe(0)
  expect(prelude).toBe('')
})

// Eviction drops arbitrary leading bytes, so the retained head can begin *inside*
// an escape sequence and can rely on state (attributes / charset / scroll region)
// that the evicted prefix established. Replay into a fresh terminal must therefore
// start from a known state and must not feed a torn sequence to the parser.
//
// Alt-screen is deliberately NOT asserted: `ESC[?1049l` would tell a fullscreen
// program's terminal it is on the normal screen while the program believes
// otherwise, desyncing the two.

test('prepends a state prelude once content has been evicted', () => {
  const buf = new RingBuffer(10)
  buf.append('0123456789') // evicted
  buf.append('abcdefgh')
  const out = buf.toString()
  expect(
    out.startsWith('\x1b[0m'),
    `SGR reset first, got ${JSON.stringify(out.slice(0, 20))}`
  ).toBe(true)
  expect(out, 'ASCII charset asserted (G0 designator)').toContain('\x1b(B')
  expect(out, 'scroll region reset').toContain('\x1b[r')
  expect(out.endsWith('abcdefgh'), `retained content preserved, got ${JSON.stringify(out)}`).toBe(
    true
  )
})

test('does not assert alt-screen state (would desync a fullscreen program)', () => {
  const buf = new RingBuffer(10)
  buf.append('0123456789')
  buf.append('abcdefgh')
  const out = buf.toString()
  expect(out, 'no alt-screen enter/leave in the prelude').not.toContain('\x1b[?1049')
})

test('drops a partial escape sequence left at the head by eviction', () => {
  // The retained head starts mid-CSI: `[32mrest`. Replaying that leaks a literal
  // "[32m" into the terminal as text, because its introducing ESC was evicted.
  const buf = new RingBuffer(12)
  buf.append('aaaaaaaaaa\x1b[32m') // will be evicted, but shows intent
  buf.append('bbbbbbbbbbbb')
  const out = buf.toString()
  expect(
    /(^|[^\x1b])\[32m/.test(out.replace(/^\x1b\[0m\x1b\(B\x1b\[r/, '')),
    `no orphaned CSI: ${JSON.stringify(out)}`
  ).toBe(false)
})

test('an orphaned CSI tail at the head is removed, not printed as text', () => {
  const buf = new RingBuffer(8)
  // One chunk, oversized, so the tail-slice cuts inside the CSI below.
  buf.append('xx\x1b[38;5;42mHELLO-WORLD')
  const out = buf.toString()
  // Whatever survived must not contain a parameter run that lost its ESC [.
  const body = out.replace(/^(?:\x1b\[0m|\x1b\(B|\x1b\[r)+/, '')
  expect(/^[0-9;:]*m/.test(body), `head must not start mid-CSI: ${JSON.stringify(body)}`).toBe(
    false
  )
})

test('prelude is emitted once, not once per evicting append', () => {
  const buf = new RingBuffer(10)
  for (let i = 0; i < 6; i++) buf.append('abcde')
  const out = buf.toString()
  expect(out.split('\x1b[0m').length - 1, 'exactly one SGR reset').toBe(1)
  expect(out.split('\x1b(B').length - 1, 'exactly one charset designator').toBe(1)
})

test('size accounting stays honest and within the cap', () => {
  // The old `totalSize += 4` for a prepended reset was wrong bookkeeping AND
  // pushed the buffer over its own cap.
  const buf = new RingBuffer(10)
  buf.append('12345')
  buf.append('67890')
  buf.append('abc')
  expect(buf.size, `size ${buf.size} must be <= 10`).toBeLessThanOrEqual(10)
})

test('clear() empties without reusing sequence numbers', () => {
  const buf = new RingBuffer(1024)
  buf.append('a')
  buf.append('b')
  buf.clear()
  expect(buf.size).toBe(0)
  expect(buf.toString()).toBe('')
  expect(buf.append('c'), 'seq keeps advancing').toBe(2)
})

test('a cleared buffer replays without a stale prelude', () => {
  // clear() is an explicit user action (clear-buffer), not data loss — the
  // terminal is being reset by the caller, so no eviction prelude applies.
  const buf = new RingBuffer(10)
  buf.append('0123456789')
  buf.append('abc') // evicts → prelude armed
  buf.clear()
  buf.append('fresh')
  expect(buf.toString()).toBe('fresh')
})
