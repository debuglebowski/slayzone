/**
 * containsSubmitEnter tests — submit-Enter detection across input encodings.
 */
import { expect, test } from 'vitest'
import {
  arrowKey,
  BACKSPACE,
  containsSubmitEnter,
  ctrlKey,
  ESCAPE,
  KITTY_SHIFT_ENTER,
  SHIFT_TAB,
  TAB
} from './key-sequences.js'

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

// Keys a client without a keyboard sends (the phone's key bar): the bytes a
// terminal (xterm) sends for the same key, so the program cannot tell them apart.
test('Esc, Tab, Shift+Tab, Backspace bytes', () => {
  expect(ESCAPE).toBe('\x1b')
  expect(TAB).toBe('\t')
  expect(SHIFT_TAB).toBe('\x1b[Z')
  expect(BACKSPACE).toBe('\x7f')
})

test('Ctrl+letter is the letter’s C0 control byte', () => {
  expect(ctrlKey('c')).toBe('\x03')
  expect(ctrlKey('C')).toBe('\x03')
  expect(ctrlKey('d')).toBe('\x04')
  expect(ctrlKey('a')).toBe('\x01')
  expect(ctrlKey('z')).toBe('\x1a')
  expect(() => ctrlKey('1')).toThrow()
  expect(() => ctrlKey('cc')).toThrow()
})

test('arrow keys follow the cursor-key mode (DECCKM)', () => {
  expect(arrowKey('up', false)).toBe('\x1b[A')
  expect(arrowKey('down', false)).toBe('\x1b[B')
  expect(arrowKey('right', false)).toBe('\x1b[C')
  expect(arrowKey('left', false)).toBe('\x1b[D')
  expect(arrowKey('up', true)).toBe('\x1bOA')
  expect(arrowKey('left', true)).toBe('\x1bOD')
})
