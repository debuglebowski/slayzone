/**
 * Tests for stdin-input — classifying what the renderer writes to a PTY.
 *
 * Both functions exist because "stdin contains an ESC byte" is not a useful
 * signal: with mouse tracking on (every agent TUI turns it on), the renderer
 * writes an SGR mouse report on every pointer move over the pane. Measured on a
 * live session, 94.3% of all ESC-bearing writes were mouse reports and 0.1%
 * were the user's actual Esc key.
 */
import { expect, test } from 'vitest'
import { isInterruptKey, stripTerminalReports, appendInput, INPUT_BUFFER_MAX } from './stdin-input'

// An SGR mouse report: CSI < Cb ; Cx ; Cy (M press/motion | m release).
const sgr = (cb: number, x: number, y: number, rel = false): string =>
  `\x1b[<${cb};${x};${y}${rel ? 'm' : 'M'}`

test('a bare ESC is the interrupt key', () => {
  expect(isInterruptKey('\x1b')).toBe(true)
})

test('kitty CSI-u encodes Escape as keycode 27', () => {
  // Claude Code enables the kitty keyboard protocol, after which the Esc key
  // never reaches stdin as a bare \x1b.
  expect(isInterruptKey('\x1b[27u')).toBe(true)
})

test('kitty CSI-u Escape with a modifier still counts', () => {
  expect(isInterruptKey('\x1b[27;1u')).toBe(true)
  expect(isInterruptKey('\x1b[27;5u')).toBe(true)
})

test('kitty CSI-u Escape with an event-type subparam still counts', () => {
  expect(isInterruptKey('\x1b[27;1:1u')).toBe(true)
})

test('an SGR mouse report is NOT the interrupt key', () => {
  // The whole point: this is what was being counted as an Esc press.
  expect(isInterruptKey(sgr(35, 80, 12))).toBe(false)
  expect(isInterruptKey(sgr(0, 12, 34))).toBe(false)
  expect(isInterruptKey(sgr(0, 12, 34, true))).toBe(false)
})

test('Alt+key word-nav is NOT the interrupt key', () => {
  // The terminal client writes these itself for word-left / word-right.
  expect(isInterruptKey('\x1bb')).toBe(false)
  expect(isInterruptKey('\x1bf')).toBe(false)
})

test('arrow keys are NOT the interrupt key', () => {
  expect(isInterruptKey('\x1b[A')).toBe(false)
  expect(isInterruptKey('\x1b[B')).toBe(false)
  expect(isInterruptKey('\x1b[C')).toBe(false)
  expect(isInterruptKey('\x1b[D')).toBe(false)
})

test('focus reports are NOT the interrupt key', () => {
  expect(isInterruptKey('\x1b[I')).toBe(false)
  expect(isInterruptKey('\x1b[O')).toBe(false)
})

test('another kitty keycode is NOT the interrupt key', () => {
  expect(isInterruptKey('\x1b[13u'), 'Enter').toBe(false)
  expect(isInterruptKey('\x1b[270u'), 'must anchor, not prefix-match 27').toBe(false)
})

test('plain text and empty input are NOT the interrupt key', () => {
  expect(isInterruptKey('hello')).toBe(false)
  expect(isInterruptKey('')).toBe(false)
  expect(isInterruptKey('\x1bhello')).toBe(false)
})

test('an SGR mouse press/motion/release report is removed', () => {
  expect(stripTerminalReports(sgr(0, 12, 34))).toBe('')
  expect(stripTerminalReports(sgr(35, 123, 45))).toBe('')
  expect(stripTerminalReports(sgr(0, 12, 34, true))).toBe('')
})

test('mouse reports interleaved with typing leave the typing intact', () => {
  // The real-world shape: the pointer drifts over the pane while the user types.
  expect(stripTerminalReports(`he${sgr(35, 10, 5)}llo`)).toBe('hello')
})

test('a burst of motion reports collapses to nothing', () => {
  const burst = Array.from({ length: 20 }, (_, i) => sgr(35, i, i)).join('')
  expect(stripTerminalReports(burst)).toBe('')
})

test('X10 mouse reports are removed with their 3 payload bytes', () => {
  expect(stripTerminalReports('\x1b[M\x20\x21\x22')).toBe('')
  expect(stripTerminalReports(`a\x1b[M\x20\x21\x22b`)).toBe('ab')
})

test('focus in/out reports are removed', () => {
  expect(stripTerminalReports('\x1b[I')).toBe('')
  expect(stripTerminalReports('\x1b[O')).toBe('')
  expect(stripTerminalReports('a\x1b[Ib\x1b[Oc')).toBe('abc')
})

test('the Esc key survives stripping', () => {
  // Stripping must never eat the one byte the interrupt path cares about.
  expect(stripTerminalReports('\x1b')).toBe('\x1b')
  expect(stripTerminalReports('\x1b[27u')).toBe('\x1b[27u')
})

test('arrow keys survive stripping', () => {
  expect(stripTerminalReports('\x1b[A')).toBe('\x1b[A')
  expect(stripTerminalReports('\x1b[D')).toBe('\x1b[D')
})

test('SS3 function keys survive stripping', () => {
  // ESC O P is F1 — one bracket away from the ESC [ O focus report.
  expect(stripTerminalReports('\x1bOP')).toBe('\x1bOP')
  expect(stripTerminalReports('\x1bOQ')).toBe('\x1bOQ')
})

test('Alt+key word-nav survives stripping', () => {
  expect(stripTerminalReports('\x1bb')).toBe('\x1bb')
  expect(stripTerminalReports('\x1bf')).toBe('\x1bf')
})

test('ordinary typing is untouched', () => {
  expect(stripTerminalReports('git commit -m "fix: thing"\r')).toBe('git commit -m "fix: thing"\r')
  expect(stripTerminalReports('')).toBe('')
})

test('appended input has reports stripped', () => {
  expect(appendInput('git ', `st${sgr(35, 4, 9)}atus`)).toBe('git status')
})

test('a hovered-but-never-submitted pane cannot grow without bound', () => {
  // The bug: inputBuffer only reset on Enter, so pointer motion over a pane the
  // user never types in accumulated forever (~800 B/s while hovering).
  let buf = ''
  for (let i = 0; i < 5000; i++) buf = appendInput(buf, sgr(35, i % 200, i % 50))
  expect(buf, 'pure mouse noise must accumulate to nothing').toBe('')
})

test('the buffer is capped even when the input is not strippable', () => {
  // Backstop for report shapes we do not strip: a long paste must not be able
  // to pin unbounded memory in a long-lived session.
  const buf = appendInput('x'.repeat(INPUT_BUFFER_MAX), 'y'.repeat(500))
  expect(buf.length).toBe(INPUT_BUFFER_MAX)
  expect(buf.endsWith('y'.repeat(500)), 'cap keeps the most recent input').toBe(true)
})

test('a buffer under the cap is left alone', () => {
  expect(appendInput('abc', 'def')).toBe('abcdef')
})
