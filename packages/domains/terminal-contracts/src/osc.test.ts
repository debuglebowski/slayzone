/**
 * OSC title extraction tests
 */
import { expect, test } from 'vitest'
import { extractOscTitle } from './osc.js'

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
