/**
 * Tests for useLoopMode pure functions.
 */
import { expect, test } from 'vitest'
import { checkCriteria, stripAnsi } from './useLoopMode'

// --- stripAnsi ---

test('stripAnsi removes CSI sequences', () => {
  expect(stripAnsi('\x1b[32mhello\x1b[0m')).toBe('hello')
})

test('stripAnsi removes OSC sequences', () => {
  expect(stripAnsi('\x1b]0;title\x07text')).toBe('text')
})

test('stripAnsi removes control chars', () => {
  expect(stripAnsi('hello\x01\x02world')).toBe('helloworld')
})

test('stripAnsi preserves newlines', () => {
  expect(stripAnsi('line1\nline2')).toBe('line1\nline2')
})

// --- checkCriteria: contains ---

test('contains: matches when pattern present', () => {
  expect(checkCriteria('the answer is yes', 'contains', 'yes')).toBe(true)
})

test('contains: fails when pattern absent', () => {
  expect(checkCriteria('the answer is no', 'contains', 'yes')).toBe(false)
})

test('contains: works with ANSI in output', () => {
  expect(checkCriteria('\x1b[32myes\x1b[0m', 'contains', 'yes')).toBe(true)
})

// --- checkCriteria: not-contains ---

test('not-contains: matches when pattern absent', () => {
  expect(checkCriteria('all good', 'not-contains', 'error')).toBe(true)
})

test('not-contains: fails when pattern present', () => {
  expect(checkCriteria('found an error', 'not-contains', 'error')).toBe(false)
})

// --- checkCriteria: regex ---

test('regex: matches valid pattern', () => {
  expect(checkCriteria('count: 42', 'regex', '\\d+')).toBe(true)
})

test('regex: fails when no match', () => {
  expect(checkCriteria('no numbers here', 'regex', '^\\d+$')).toBe(false)
})

test('regex: returns false on invalid regex', () => {
  expect(checkCriteria('anything', 'regex', '[invalid')).toBe(false)
})

test('regex: works with ANSI in output', () => {
  expect(checkCriteria('\x1b[1m42\x1b[0m', 'regex', '^42$')).toBe(true)
})
