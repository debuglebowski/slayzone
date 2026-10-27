/**
 * Tests for stripDeviceStatusQueries / stripDeviceStatusResponses.
 *
 * Regression guard for the spontaneous-`/clear` bug: unanswered DECXCPR (`?6n`)
 * queries accumulated in the replayable PTY buffer, and every buffer replay made
 * xterm.js answer them — row=1 answers reached Claude Code, which read them as
 * "screen was externally wiped" and submitted `/clear`, minting a new session.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/shared/platform/src/device-status-queries.test.ts
 */
import { describe, expect, test } from 'vitest'
import {
  createDeviceStatusQueryStripper,
  stripDeviceStatusQueries,
  stripDeviceStatusResponses
} from './device-status-queries'

describe('stripDeviceStatusQueries', () => {
  // The actual bug: DECXCPR.
  test('strips DECXCPR ?6n (the /clear-loop trigger)', () => {
    expect(stripDeviceStatusQueries('\x1b[?6n')).toBe('')
  })

  test('strips every DECXCPR occurrence in one chunk', () => {
    const chunk = 'a\x1b[?6nb\x1b[?6nc\x1b[?6n'
    expect(stripDeviceStatusQueries(chunk)).toBe('abc')
  })

  test('strips a realistic poll burst (200ms cadence, thousands accumulated)', () => {
    const burst = '\x1b[?6n'.repeat(1000)
    expect(stripDeviceStatusQueries(`start${burst}end`)).toBe('startend')
  })

  // Other device-status queries.
  test('strips plain CPR 6n', () => {
    expect(stripDeviceStatusQueries('\x1b[6n')).toBe('')
  })

  test('strips DSR status 5n', () => {
    expect(stripDeviceStatusQueries('\x1b[5n')).toBe('')
  })

  test('strips DEC private DSR with multi-digit / multi-param forms', () => {
    expect(stripDeviceStatusQueries('\x1b[?15n')).toBe('')
    expect(stripDeviceStatusQueries('\x1b[?26n')).toBe('')
    expect(stripDeviceStatusQueries('\x1b[?1;2n')).toBe('')
  })

  // Scope guard — the renderer answers these, so they MUST survive. On the local
  // path the buffered value is also the value streamed live, so stripping one of
  // these would break working capability detection, not just replay.
  test('preserves DECRQM mode query (renderer answers it)', () => {
    expect(stripDeviceStatusQueries('\x1b[?2026$p')).toBe('\x1b[?2026$p')
    expect(stripDeviceStatusQueries('\x1b[?1049$p')).toBe('\x1b[?1049$p')
  })

  test('preserves XTVERSION (renderer answers it)', () => {
    expect(stripDeviceStatusQueries('\x1b[>0q')).toBe('\x1b[>0q')
    expect(stripDeviceStatusQueries('\x1b[>q')).toBe('\x1b[>q')
  })

  // False-positive guards — real rendering output must survive untouched.
  test('preserves plain text', () => {
    expect(stripDeviceStatusQueries('hello world')).toBe('hello world')
  })

  test('preserves text containing a bare n', () => {
    expect(stripDeviceStatusQueries('running 6 tests\nnext')).toBe('running 6 tests\nnext')
  })

  test('preserves SGR color / attribute sequences', () => {
    expect(stripDeviceStatusQueries('\x1b[0m')).toBe('\x1b[0m')
    expect(stripDeviceStatusQueries('\x1b[1;31m')).toBe('\x1b[1;31m')
    expect(stripDeviceStatusQueries('\x1b[38;2;100;150;200m')).toBe('\x1b[38;2;100;150;200m')
  })

  test('preserves cursor movement / erase sequences', () => {
    expect(stripDeviceStatusQueries('\x1b[2J')).toBe('\x1b[2J')
    expect(stripDeviceStatusQueries('\x1b[H')).toBe('\x1b[H')
    expect(stripDeviceStatusQueries('\x1b[10;20H')).toBe('\x1b[10;20H')
    expect(stripDeviceStatusQueries('\x1b[2K')).toBe('\x1b[2K')
    expect(stripDeviceStatusQueries('\x1b[6A')).toBe('\x1b[6A')
    expect(stripDeviceStatusQueries('\x1b[6B')).toBe('\x1b[6B')
    expect(stripDeviceStatusQueries('\x1b[6G')).toBe('\x1b[6G')
  })

  test('preserves private-mode set/reset (alt screen, bracketed paste)', () => {
    expect(stripDeviceStatusQueries('\x1b[?1049h')).toBe('\x1b[?1049h')
    expect(stripDeviceStatusQueries('\x1b[?1049l')).toBe('\x1b[?1049l')
    expect(stripDeviceStatusQueries('\x1b[?2004h')).toBe('\x1b[?2004h')
    expect(stripDeviceStatusQueries('\x1b[?25l')).toBe('\x1b[?25l')
    expect(stripDeviceStatusQueries('\x1b[?25h')).toBe('\x1b[?25h')
  })

  test('preserves scroll region + kitty keyboard sequences', () => {
    expect(stripDeviceStatusQueries('\x1b[1;89r')).toBe('\x1b[1;89r')
    expect(stripDeviceStatusQueries('\x1b[>1u')).toBe('\x1b[>1u')
    expect(stripDeviceStatusQueries('\x1b[<u')).toBe('\x1b[<u')
  })

  test('preserves OSC sequences', () => {
    expect(stripDeviceStatusQueries('\x1b]7;file:///path\x07')).toBe('\x1b]7;file:///path\x07')
    expect(stripDeviceStatusQueries('\x1b]0;title\x07')).toBe('\x1b]0;title\x07')
  })

  test('preserves DA1/DA2 (not in the strip set)', () => {
    expect(stripDeviceStatusQueries('\x1b[c')).toBe('\x1b[c')
    expect(stripDeviceStatusQueries('\x1b[>0c')).toBe('\x1b[>0c')
  })

  test('strips queries interleaved with real output, keeping the output', () => {
    const input = '\x1b[?1049h\x1b[?6n\x1b[1;31mhello\x1b[0m\x1b[?6n\x1b[2J'
    expect(stripDeviceStatusQueries(input)).toBe('\x1b[?1049h\x1b[1;31mhello\x1b[0m\x1b[2J')
  })
})

describe('createDeviceStatusQueryStripper (split-safe)', () => {
  // node-pty splits on read-buffer boundaries, so a query can be torn in half.
  // Neither half matches the one-shot pattern, so both survive and reassemble
  // downstream — a stateful stripper holds the incomplete tail instead.
  test('holds a torn query and strips it once the next chunk completes it', () => {
    const strip = createDeviceStatusQueryStripper()
    expect(strip('head\x1b[?6'), 'first chunk emits only complete output').toBe('head')
    expect(strip('ntail'), 'second chunk completes + drops the query').toBe('tail')
  })

  test('handles the tear at every offset inside the sequence', () => {
    const seq = '\x1b[?6n'
    for (let i = 1; i < seq.length; i++) {
      const strip = createDeviceStatusQueryStripper()
      const out = strip('a' + seq.slice(0, i)) + strip(seq.slice(i) + 'b')
      expect(out, `split after ${i} byte(s)`).toBe('ab')
    }
  })

  test('holds a torn plain CPR (no ? introducer)', () => {
    const strip = createDeviceStatusQueryStripper()
    expect(strip('x\x1b[6')).toBe('x')
    expect(strip('n y')).toBe(' y')
  })

  test('releases a held tail that turns out NOT to be a query', () => {
    // A held prefix must never be swallowed: if the completing byte proves it was
    // ordinary output (cursor-up, SGR), the whole sequence has to be emitted.
    const strip = createDeviceStatusQueryStripper()
    expect(strip('x\x1b[6')).toBe('x')
    expect(strip('A'), 'cursor-up emerges intact').toBe('\x1b[6A')
  })

  test('releases a held DEC private prefix that completes as a mode set', () => {
    const strip = createDeviceStatusQueryStripper()
    expect(strip('x\x1b[?104')).toBe('x')
    expect(strip('9h'), 'alt-screen enter emerges intact').toBe('\x1b[?1049h')
  })

  test('does not hold a completed sequence', () => {
    const strip = createDeviceStatusQueryStripper()
    expect(strip('\x1b[?1049h')).toBe('\x1b[?1049h')
    expect(strip('next'), 'nothing was carried').toBe('next')
  })

  test('passes plain text straight through with no carry', () => {
    const strip = createDeviceStatusQueryStripper()
    expect(strip('hello ')).toBe('hello ')
    expect(strip('world')).toBe('world')
  })

  test('does not hold a trailing ESC-less partial', () => {
    const strip = createDeviceStatusQueryStripper()
    expect(strip('cost: 6')).toBe('cost: 6')
    expect(strip('n items')).toBe('n items')
  })

  test('holds a lone trailing ESC', () => {
    const strip = createDeviceStatusQueryStripper()
    expect(strip('x\x1b')).toBe('x')
    expect(strip('[?6n'), 'query assembled across the introducer split').toBe('')
  })

  test('caps the held tail so an unterminated sequence cannot stall the stream', () => {
    const strip = createDeviceStatusQueryStripper()
    // A CSI whose params never terminate (pathological / binary output) must be
    // released once it exceeds any plausible query length, not buffered forever.
    const runaway = '\x1b[' + '1;'.repeat(200)
    const out = strip('x' + runaway)
    expect(out.length, 'runaway CSI was held instead of released').toBeGreaterThan(0)
    // Nothing is lost: what was held is emitted on the next chunk at the latest.
    expect(out + strip('') + strip('END')).toBe('x' + runaway + 'END')
  })

  test('strips a burst that is torn across many chunks', () => {
    const strip = createDeviceStatusQueryStripper()
    // Feed `?6n` x100 one byte at a time — the worst case.
    const stream = '\x1b[?6n'.repeat(100)
    let out = ''
    for (const ch of stream) out += strip(ch)
    expect(out).toBe('')
  })
})

describe('stripDeviceStatusResponses', () => {
  test('strips DECXCPR response (the byte that triggers /clear)', () => {
    expect(stripDeviceStatusResponses('\x1b[?1;1R')).toBe('')
    expect(stripDeviceStatusResponses('\x1b[?40;11R')).toBe('')
  })

  test('strips CPR response', () => {
    expect(stripDeviceStatusResponses('\x1b[1;1R')).toBe('')
    expect(stripDeviceStatusResponses('\x1b[24;80R')).toBe('')
  })

  test('strips DSR status response', () => {
    expect(stripDeviceStatusResponses('\x1b[0n')).toBe('')
  })

  test('preserves DECRPM response (renderer-owned, must reach the program)', () => {
    expect(stripDeviceStatusResponses('\x1b[?2026;2$y')).toBe('\x1b[?2026;2$y')
  })

  test('strips a replay-flood of responses', () => {
    const flood = '\x1b[?1;1R'.repeat(500)
    expect(stripDeviceStatusResponses(flood)).toBe('')
  })

  test('preserves ordinary typed text', () => {
    expect(stripDeviceStatusResponses('hello world')).toBe('hello world')
    expect(stripDeviceStatusResponses('R')).toBe('R')
    expect(stripDeviceStatusResponses('1;1R')).toBe('1;1R')
  })

  test('preserves control keys the user actually presses', () => {
    expect(stripDeviceStatusResponses('\r')).toBe('\r')
    expect(stripDeviceStatusResponses('\x03')).toBe('\x03') // Ctrl+C
    expect(stripDeviceStatusResponses('\x1b')).toBe('\x1b') // bare Esc
    expect(stripDeviceStatusResponses('\x7f')).toBe('\x7f') // Backspace
  })

  test('preserves arrow keys and kitty shift-enter', () => {
    expect(stripDeviceStatusResponses('\x1b[A')).toBe('\x1b[A')
    expect(stripDeviceStatusResponses('\x1b[B')).toBe('\x1b[B')
    expect(stripDeviceStatusResponses('\x1b[C')).toBe('\x1b[C')
    expect(stripDeviceStatusResponses('\x1b[D')).toBe('\x1b[D')
    expect(stripDeviceStatusResponses('\x1b[13;2u')).toBe('\x1b[13;2u')
  })

  test('preserves bracketed-paste wrappers and pasted content', () => {
    expect(stripDeviceStatusResponses('\x1b[200~pasted text\x1b[201~')).toBe(
      '\x1b[200~pasted text\x1b[201~'
    )
  })

  test('keeps typed text while dropping an embedded response', () => {
    expect(stripDeviceStatusResponses('foo\x1b[?1;1Rbar')).toBe('foobar')
  })
})

describe('createDeviceStatusQueryStripper — flush()', () => {
  // The module's contract is "NOTHING is ever lost — the concatenation of all
  // return values is the input minus queries only". A held tail breaks that at the
  // moment the stripper is retired: the warm-pool handoff disposes the pty listener
  // and hands `seedBuffer` to the live path (a *stateless* filter), so a tail still
  // sitting in the closure is dropped and its continuation arrives orphaned.
  test('flush() returns a held tail so a retired stripper loses nothing', () => {
    const strip = createDeviceStatusQueryStripper()
    expect(strip('hello\x1b[2'), 'incomplete CSI held back').toBe('hello')
    expect(strip.flush(), 'flush returns the held bytes').toBe('\x1b[2')
  })

  test('flush() is idempotent — a second call returns nothing', () => {
    const strip = createDeviceStatusQueryStripper()
    strip('x\x1b[?6')
    expect(strip.flush(), 'first flush drains').toBe('\x1b[?6')
    expect(strip.flush(), 'second flush is empty').toBe('')
  })

  test('flush() returns empty when no tail is held', () => {
    const strip = createDeviceStatusQueryStripper()
    expect(strip('plain output\n')).toBe('plain output\n')
    expect(strip.flush(), 'nothing held, nothing to flush').toBe('')
  })

  test('flush() does not resurrect an already-stripped query', () => {
    const strip = createDeviceStatusQueryStripper()
    expect(strip('a\x1b[?6nb'), 'complete query stripped inline').toBe('ab')
    expect(strip.flush(), 'no leftover').toBe('')
  })

  test('stream + flush concatenates to the input minus queries', () => {
    // The documented invariant, asserted end to end over a torn tail.
    const strip = createDeviceStatusQueryStripper()
    const out = strip('one\x1b[?6ntwo\x1b[3') + strip.flush()
    expect(out, 'query gone, torn tail preserved verbatim').toBe('onetwo\x1b[3')
  })
})
