/**
 * Tests for stripDeviceStatusQueries / stripDeviceStatusResponses.
 *
 * Regression guard for the spontaneous-`/clear` bug: unanswered DECXCPR (`?6n`)
 * queries accumulated in the replayable PTY buffer, and every buffer replay made
 * xterm.js answer them — row=1 answers reached Claude Code, which read them as
 * "screen was externally wiped" and submitted `/clear`, minting a new session.
 *
 * Run with: npx tsx packages/shared/platform/src/device-status-queries.test.ts
 */
import {
  createDeviceStatusQueryStripper,
  stripDeviceStatusQueries,
  stripDeviceStatusResponses
} from './device-status-queries'

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

function assert(actual: string, expected: string, label?: string): void {
  if (actual !== expected) {
    const vis = (s: string) => JSON.stringify(s.replace(/\x1b/g, 'ESC'))
    throw new Error(`${label ? label + ': ' : ''}expected ${vis(expected)}, got ${vis(actual)}`)
  }
}

console.log('\nstripDeviceStatusQueries')
console.log('─'.repeat(40))

// The actual bug: DECXCPR.
test('strips DECXCPR ?6n (the /clear-loop trigger)', () => {
  assert(stripDeviceStatusQueries('\x1b[?6n'), '')
})

test('strips every DECXCPR occurrence in one chunk', () => {
  const chunk = 'a\x1b[?6nb\x1b[?6nc\x1b[?6n'
  assert(stripDeviceStatusQueries(chunk), 'abc')
})

test('strips a realistic poll burst (200ms cadence, thousands accumulated)', () => {
  const burst = '\x1b[?6n'.repeat(1000)
  assert(stripDeviceStatusQueries(`start${burst}end`), 'startend')
})

// Other device-status queries.
test('strips plain CPR 6n', () => {
  assert(stripDeviceStatusQueries('\x1b[6n'), '')
})

test('strips DSR status 5n', () => {
  assert(stripDeviceStatusQueries('\x1b[5n'), '')
})

test('strips DEC private DSR with multi-digit / multi-param forms', () => {
  assert(stripDeviceStatusQueries('\x1b[?15n'), '')
  assert(stripDeviceStatusQueries('\x1b[?26n'), '')
  assert(stripDeviceStatusQueries('\x1b[?1;2n'), '')
})

// Scope guard — the renderer answers these, so they MUST survive. On the local
// path the buffered value is also the value streamed live, so stripping one of
// these would break working capability detection, not just replay.
test('preserves DECRQM mode query (renderer answers it)', () => {
  assert(stripDeviceStatusQueries('\x1b[?2026$p'), '\x1b[?2026$p')
  assert(stripDeviceStatusQueries('\x1b[?1049$p'), '\x1b[?1049$p')
})

test('preserves XTVERSION (renderer answers it)', () => {
  assert(stripDeviceStatusQueries('\x1b[>0q'), '\x1b[>0q')
  assert(stripDeviceStatusQueries('\x1b[>q'), '\x1b[>q')
})

// False-positive guards — real rendering output must survive untouched.
test('preserves plain text', () => {
  assert(stripDeviceStatusQueries('hello world'), 'hello world')
})

test('preserves text containing a bare n', () => {
  assert(stripDeviceStatusQueries('running 6 tests\nnext'), 'running 6 tests\nnext')
})

test('preserves SGR color / attribute sequences', () => {
  assert(stripDeviceStatusQueries('\x1b[0m'), '\x1b[0m')
  assert(stripDeviceStatusQueries('\x1b[1;31m'), '\x1b[1;31m')
  assert(stripDeviceStatusQueries('\x1b[38;2;100;150;200m'), '\x1b[38;2;100;150;200m')
})

test('preserves cursor movement / erase sequences', () => {
  assert(stripDeviceStatusQueries('\x1b[2J'), '\x1b[2J')
  assert(stripDeviceStatusQueries('\x1b[H'), '\x1b[H')
  assert(stripDeviceStatusQueries('\x1b[10;20H'), '\x1b[10;20H')
  assert(stripDeviceStatusQueries('\x1b[2K'), '\x1b[2K')
  assert(stripDeviceStatusQueries('\x1b[6A'), '\x1b[6A')
  assert(stripDeviceStatusQueries('\x1b[6B'), '\x1b[6B')
  assert(stripDeviceStatusQueries('\x1b[6G'), '\x1b[6G')
})

test('preserves private-mode set/reset (alt screen, bracketed paste)', () => {
  assert(stripDeviceStatusQueries('\x1b[?1049h'), '\x1b[?1049h')
  assert(stripDeviceStatusQueries('\x1b[?1049l'), '\x1b[?1049l')
  assert(stripDeviceStatusQueries('\x1b[?2004h'), '\x1b[?2004h')
  assert(stripDeviceStatusQueries('\x1b[?25l'), '\x1b[?25l')
  assert(stripDeviceStatusQueries('\x1b[?25h'), '\x1b[?25h')
})

test('preserves scroll region + kitty keyboard sequences', () => {
  assert(stripDeviceStatusQueries('\x1b[1;89r'), '\x1b[1;89r')
  assert(stripDeviceStatusQueries('\x1b[>1u'), '\x1b[>1u')
  assert(stripDeviceStatusQueries('\x1b[<u'), '\x1b[<u')
})

test('preserves OSC sequences', () => {
  assert(stripDeviceStatusQueries('\x1b]7;file:///path\x07'), '\x1b]7;file:///path\x07')
  assert(stripDeviceStatusQueries('\x1b]0;title\x07'), '\x1b]0;title\x07')
})

test('preserves DA1/DA2 (not in the strip set)', () => {
  assert(stripDeviceStatusQueries('\x1b[c'), '\x1b[c')
  assert(stripDeviceStatusQueries('\x1b[>0c'), '\x1b[>0c')
})

test('strips queries interleaved with real output, keeping the output', () => {
  const input = '\x1b[?1049h\x1b[?6n\x1b[1;31mhello\x1b[0m\x1b[?6n\x1b[2J'
  assert(stripDeviceStatusQueries(input), '\x1b[?1049h\x1b[1;31mhello\x1b[0m\x1b[2J')
})

console.log('\ncreateDeviceStatusQueryStripper (split-safe)')
console.log('─'.repeat(40))

// node-pty splits on read-buffer boundaries, so a query can be torn in half.
// Neither half matches the one-shot pattern, so both survive and reassemble
// downstream — a stateful stripper holds the incomplete tail instead.
test('holds a torn query and strips it once the next chunk completes it', () => {
  const strip = createDeviceStatusQueryStripper()
  assert(strip('head\x1b[?6'), 'head', 'first chunk emits only complete output')
  assert(strip('ntail'), 'tail', 'second chunk completes + drops the query')
})

test('handles the tear at every offset inside the sequence', () => {
  const seq = '\x1b[?6n'
  for (let i = 1; i < seq.length; i++) {
    const strip = createDeviceStatusQueryStripper()
    const out = strip('a' + seq.slice(0, i)) + strip(seq.slice(i) + 'b')
    assert(out, 'ab', `split after ${i} byte(s)`)
  }
})

test('holds a torn plain CPR (no ? introducer)', () => {
  const strip = createDeviceStatusQueryStripper()
  assert(strip('x\x1b[6'), 'x')
  assert(strip('n y'), ' y')
})

test('releases a held tail that turns out NOT to be a query', () => {
  // A held prefix must never be swallowed: if the completing byte proves it was
  // ordinary output (cursor-up, SGR), the whole sequence has to be emitted.
  const strip = createDeviceStatusQueryStripper()
  assert(strip('x\x1b[6'), 'x')
  assert(strip('A'), '\x1b[6A', 'cursor-up emerges intact')
})

test('releases a held DEC private prefix that completes as a mode set', () => {
  const strip = createDeviceStatusQueryStripper()
  assert(strip('x\x1b[?104'), 'x')
  assert(strip('9h'), '\x1b[?1049h', 'alt-screen enter emerges intact')
})

test('does not hold a completed sequence', () => {
  const strip = createDeviceStatusQueryStripper()
  assert(strip('\x1b[?1049h'), '\x1b[?1049h')
  assert(strip('next'), 'next', 'nothing was carried')
})

test('passes plain text straight through with no carry', () => {
  const strip = createDeviceStatusQueryStripper()
  assert(strip('hello '), 'hello ')
  assert(strip('world'), 'world')
})

test('does not hold a trailing ESC-less partial', () => {
  const strip = createDeviceStatusQueryStripper()
  assert(strip('cost: 6'), 'cost: 6')
  assert(strip('n items'), 'n items')
})

test('holds a lone trailing ESC', () => {
  const strip = createDeviceStatusQueryStripper()
  assert(strip('x\x1b'), 'x')
  assert(strip('[?6n'), '', 'query assembled across the introducer split')
})

test('caps the held tail so an unterminated sequence cannot stall the stream', () => {
  const strip = createDeviceStatusQueryStripper()
  // A CSI whose params never terminate (pathological / binary output) must be
  // released once it exceeds any plausible query length, not buffered forever.
  const runaway = '\x1b[' + '1;'.repeat(200)
  const out = strip('x' + runaway)
  if (out.length === 0) throw new Error('runaway CSI was held instead of released')
  // Nothing is lost: what was held is emitted on the next chunk at the latest.
  assert(out + strip('') + strip('END'), 'x' + runaway + 'END')
})

test('strips a burst that is torn across many chunks', () => {
  const strip = createDeviceStatusQueryStripper()
  // Feed `?6n` x100 one byte at a time — the worst case.
  const stream = '\x1b[?6n'.repeat(100)
  let out = ''
  for (const ch of stream) out += strip(ch)
  assert(out, '')
})

console.log('\nstripDeviceStatusResponses')
console.log('─'.repeat(40))

test('strips DECXCPR response (the byte that triggers /clear)', () => {
  assert(stripDeviceStatusResponses('\x1b[?1;1R'), '')
  assert(stripDeviceStatusResponses('\x1b[?40;11R'), '')
})

test('strips CPR response', () => {
  assert(stripDeviceStatusResponses('\x1b[1;1R'), '')
  assert(stripDeviceStatusResponses('\x1b[24;80R'), '')
})

test('strips DSR status response', () => {
  assert(stripDeviceStatusResponses('\x1b[0n'), '')
})

test('preserves DECRPM response (renderer-owned, must reach the program)', () => {
  assert(stripDeviceStatusResponses('\x1b[?2026;2$y'), '\x1b[?2026;2$y')
})

test('strips a replay-flood of responses', () => {
  const flood = '\x1b[?1;1R'.repeat(500)
  assert(stripDeviceStatusResponses(flood), '')
})

test('preserves ordinary typed text', () => {
  assert(stripDeviceStatusResponses('hello world'), 'hello world')
  assert(stripDeviceStatusResponses('R'), 'R')
  assert(stripDeviceStatusResponses('1;1R'), '1;1R')
})

test('preserves control keys the user actually presses', () => {
  assert(stripDeviceStatusResponses('\r'), '\r')
  assert(stripDeviceStatusResponses('\x03'), '\x03') // Ctrl+C
  assert(stripDeviceStatusResponses('\x1b'), '\x1b') // bare Esc
  assert(stripDeviceStatusResponses('\x7f'), '\x7f') // Backspace
})

test('preserves arrow keys and kitty shift-enter', () => {
  assert(stripDeviceStatusResponses('\x1b[A'), '\x1b[A')
  assert(stripDeviceStatusResponses('\x1b[B'), '\x1b[B')
  assert(stripDeviceStatusResponses('\x1b[C'), '\x1b[C')
  assert(stripDeviceStatusResponses('\x1b[D'), '\x1b[D')
  assert(stripDeviceStatusResponses('\x1b[13;2u'), '\x1b[13;2u')
})

test('preserves bracketed-paste wrappers and pasted content', () => {
  assert(stripDeviceStatusResponses('\x1b[200~pasted text\x1b[201~'), '\x1b[200~pasted text\x1b[201~')
})

test('keeps typed text while dropping an embedded response', () => {
  assert(stripDeviceStatusResponses('foo\x1b[?1;1Rbar'), 'foobar')
})

console.log('─'.repeat(40))
console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed > 0 ? 1 : 0)
