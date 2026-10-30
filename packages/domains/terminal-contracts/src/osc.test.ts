/**
 * OSC title extraction tests
 */
import { expect, test } from 'vitest'
import { extractOscTitle, stripOscReplies } from './osc.js'

// Client → pty input: OSC strings are answers to colour queries, never user input.
test('stripOscReplies drops a BEL-terminated OSC reply', () => {
  expect(stripOscReplies('\x1b]11;rgb:0000/0000/0000\x07')).toBe('')
})

test('stripOscReplies drops an ST-terminated OSC reply and keeps the keystrokes around it', () => {
  expect(stripOscReplies('a\x1b]10;rgb:ffff/ffff/ffff\x1b\\b')).toBe('ab')
})

test('stripOscReplies leaves plain input and other escapes alone', () => {
  expect(stripOscReplies('ls -la\r')).toBe('ls -la\r')
  expect(stripOscReplies('\x1b[A\x1b')).toBe('\x1b[A\x1b')
})

test('stripOscReplies drops every reply in one write', () => {
  expect(stripOscReplies('\x1b]10;x\x07\x1b]11;y\x07z')).toBe('z')
})

test('extracts OSC 0 title (BEL terminator)', () => {
  expect(extractOscTitle('\x1b]0;my-title\x07')).toBe('my-title')
})

test('extracts OSC 0 title (ST terminator)', () => {
  expect(extractOscTitle('\x1b]0;my-title\x1b\\')).toBe('my-title')
})

test('extracts OSC 1 (icon name)', () => {
  expect(extractOscTitle('\x1b]1;icon\x07')).toBe('icon')
})

test('extracts OSC 2 (window title)', () => {
  expect(extractOscTitle('\x1b]2;window\x07')).toBe('window')
})

test('returns last title when multiple present', () => {
  expect(extractOscTitle('\x1b]0;first\x07some output\x1b]0;second\x07')).toBe('second')
})

test('returns undefined for no OSC sequences', () => {
  expect(extractOscTitle('hello world')).toBeUndefined()
})

test('returns undefined for non-title OSC (e.g. OSC 7)', () => {
  expect(extractOscTitle('\x1b]7;file:///home/user\x07')).toBeUndefined()
})

test('handles title embedded in normal output', () => {
  expect(extractOscTitle('some text\x1b]0;vim\x07more text')).toBe('vim')
})

test('handles empty title', () => {
  expect(extractOscTitle('\x1b]0;\x07')).toBe('')
})

test('handles title with spaces and special chars', () => {
  expect(extractOscTitle('\x1b]0;user@host: ~/dev\x07')).toBe('user@host: ~/dev')
})

test('ignores incomplete OSC (no terminator)', () => {
  expect(extractOscTitle('\x1b]0;partial')).toBeUndefined()
})
