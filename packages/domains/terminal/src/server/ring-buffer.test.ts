/**
 * Unit tests for the HUB-side pty ring buffer.
 *
 * This buffer's job is different from the runner's mirror
 * (`packages/apps/runner/src/ring-buffer.ts`), and the difference decides the
 * design:
 *
 *   - The runner's copy exists ONLY for short-range gap backfill, where a chunk
 *     must stay byte-identical to what was streamed live under the same seq. It
 *     therefore never rewrites a chunk.
 *   - This one is replayed WHOLESALE into a freshly-created xterm on every mount /
 *     reattach (`getBuffer` → `toString()`). A fresh terminal has default state, so
 *     replay must not begin mid-escape-sequence and must not inherit attributes,
 *     charset, or a scroll region set by output that has since been evicted.
 *
 * So resync belongs here and only here — and it is applied at READ time, leaving
 * the stored chunks immutable so `getChunksSince` still returns verbatim bytes.
 *
 * Run with: pnpm exec tsx packages/domains/terminal/src/server/ring-buffer.test.ts
 */
import { RingBuffer } from './ring-buffer'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? e.message : e}`)
    failed++
  }
}

function eq<T>(actual: T, expected: T, label?: string): void {
  if (actual !== expected) {
    const show = (v: unknown) =>
      typeof v === 'string' ? JSON.stringify(v.replace(/\x1b/g, 'ESC')) : JSON.stringify(v)
    throw new Error(`${label ? label + ': ' : ''}expected ${show(expected)}, got ${show(actual)}`)
  }
}

function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}

console.log('\nRingBuffer (hub)')
console.log('─'.repeat(40))

test('assigns monotonic sequence numbers starting at 0', () => {
  const buf = new RingBuffer(1024)
  eq(buf.append('a'), 0)
  eq(buf.append('b'), 1)
  eq(buf.getCurrentSeq(), 1)
})

test('no eviction: replay is the exact byte stream, no prelude', () => {
  // Nothing was lost, so the replay needs no state assertion — adding one would
  // stomp attributes the stream itself sets up.
  const buf = new RingBuffer(1024)
  buf.append('\x1b[32mgreen text')
  eq(buf.toString(), '\x1b[32mgreen text')
})

test('getChunksSince returns stored bytes verbatim, never a prelude', () => {
  // Incremental catch-up appends into an ALREADY-correct terminal; injecting a
  // reset there would clobber live attributes mid-stream.
  const buf = new RingBuffer(10)
  buf.append('0123456789')
  buf.append('abc')
  for (const c of buf.getChunksSince(-1)) {
    ok(!c.data.includes('\x1b[0m'), `seq ${c.seq} must be verbatim, got ${JSON.stringify(c.data)}`)
  }
})

console.log('\nreplay prelude after eviction')
console.log('─'.repeat(40))

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
  ok(out.startsWith('\x1b[0m'), `SGR reset first, got ${JSON.stringify(out.slice(0, 20))}`)
  ok(out.includes('\x1b(B'), 'ASCII charset asserted (G0 designator)')
  ok(out.includes('\x1b[r'), 'scroll region reset')
  ok(out.endsWith('abcdefgh'), `retained content preserved, got ${JSON.stringify(out)}`)
})

test('does not assert alt-screen state (would desync a fullscreen program)', () => {
  const buf = new RingBuffer(10)
  buf.append('0123456789')
  buf.append('abcdefgh')
  const out = buf.toString()
  ok(!out.includes('\x1b[?1049'), 'no alt-screen enter/leave in the prelude')
})

test('drops a partial escape sequence left at the head by eviction', () => {
  // The retained head starts mid-CSI: `[32mrest`. Replaying that leaks a literal
  // "[32m" into the terminal as text, because its introducing ESC was evicted.
  const buf = new RingBuffer(12)
  buf.append('aaaaaaaaaa\x1b[32m') // will be evicted, but shows intent
  buf.append('bbbbbbbbbbbb')
  const out = buf.toString()
  ok(!/(^|[^\x1b])\[32m/.test(out.replace(/^\x1b\[0m\x1b\(B\x1b\[r/, '')), `no orphaned CSI: ${JSON.stringify(out)}`)
})

test('an orphaned CSI tail at the head is removed, not printed as text', () => {
  const buf = new RingBuffer(8)
  // One chunk, oversized, so the tail-slice cuts inside the CSI below.
  buf.append('xx\x1b[38;5;42mHELLO-WORLD')
  const out = buf.toString()
  // Whatever survived must not contain a parameter run that lost its ESC [.
  const body = out.replace(/^(?:\x1b\[0m|\x1b\(B|\x1b\[r)+/, '')
  ok(!/^[0-9;:]*m/.test(body), `head must not start mid-CSI: ${JSON.stringify(body)}`)
})

test('prelude is emitted once, not once per evicting append', () => {
  const buf = new RingBuffer(10)
  for (let i = 0; i < 6; i++) buf.append('abcde')
  const out = buf.toString()
  eq(out.split('\x1b[0m').length - 1, 1, 'exactly one SGR reset')
  eq(out.split('\x1b(B').length - 1, 1, 'exactly one charset designator')
})

test('size accounting stays honest and within the cap', () => {
  // The old `totalSize += 4` for a prepended reset was wrong bookkeeping AND
  // pushed the buffer over its own cap.
  const buf = new RingBuffer(10)
  buf.append('12345')
  buf.append('67890')
  buf.append('abc')
  ok(buf.size <= 10, `size ${buf.size} must be <= 10`)
})

test('clear() empties without reusing sequence numbers', () => {
  const buf = new RingBuffer(1024)
  buf.append('a')
  buf.append('b')
  buf.clear()
  eq(buf.size, 0)
  eq(buf.toString(), '')
  eq(buf.append('c'), 2, 'seq keeps advancing')
})

test('a cleared buffer replays without a stale prelude', () => {
  // clear() is an explicit user action (clear-buffer), not data loss — the
  // terminal is being reset by the caller, so no eviction prelude applies.
  const buf = new RingBuffer(10)
  buf.append('0123456789')
  buf.append('abc') // evicts → prelude armed
  buf.clear()
  buf.append('fresh')
  eq(buf.toString(), 'fresh')
})

console.log('─'.repeat(40))
console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed > 0 ? 1 : 0)
