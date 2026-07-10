/**
 * containsSubmitEnter tests — submit-Enter detection across input encodings.
 * Run with: pnpm tsx packages/domains/terminal/src/shared/key-sequences.test.ts
 */
import { containsSubmitEnter, KITTY_SHIFT_ENTER } from './key-sequences.js'

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (e) {
    console.error(`  ✗ ${name}`)
    throw e
  }
}
function expect(v: boolean) {
  return {
    toBe(e: boolean) {
      if (v !== e) throw new Error(`expected ${e}, got ${v}`)
    }
  }
}

// Legacy encodings — must keep matching.
test('CR matches', () => expect(containsSubmitEnter('\r')).toBe(true))
test('LF matches', () => expect(containsSubmitEnter('\n')).toBe(true))
test('CR embedded in text matches', () => expect(containsSubmitEnter('fix the bug\r')).toBe(true))

// Kitty CSI-u plain Enter — the encoding xterm emits once a TUI (Claude Code)
// enables the kitty keyboard protocol. No \r ever reaches the PTY.
test('kitty plain Enter matches', () => expect(containsSubmitEnter('\x1b[13u')).toBe(true))
test('kitty Enter with explicit no-modifier matches', () =>
  expect(containsSubmitEnter('\x1b[13;1u')).toBe(true))
test('kitty Enter with event-type subparam matches', () =>
  expect(containsSubmitEnter('\x1b[13;1:1u')).toBe(true))
test('kitty Enter embedded in text matches', () =>
  expect(containsSubmitEnter('hello\x1b[13u')).toBe(true))

// Non-submit input — must NOT match.
test('Shift+Enter (newline-in-input) does not match', () =>
  expect(containsSubmitEnter(KITTY_SHIFT_ENTER)).toBe(false))
test('Shift+Enter with event subparam does not match', () =>
  expect(containsSubmitEnter('\x1b[13;2:1u')).toBe(false))
test('other CSI-u keycode does not match', () =>
  expect(containsSubmitEnter('\x1b[97u')).toBe(false))
test('plain text does not match', () => expect(containsSubmitEnter('hello world')).toBe(false))
test('empty string does not match', () => expect(containsSubmitEnter('')).toBe(false))
test('bare ESC does not match', () => expect(containsSubmitEnter('\x1b')).toBe(false))
test('CSI 13~ (legacy F3-style) does not match', () =>
  expect(containsSubmitEnter('\x1b[13~')).toBe(false))

console.log('key-sequences: all tests passed')
