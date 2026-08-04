/**
 * Tests for stdin-input — classifying what the renderer writes to a PTY.
 *
 * Run with: npx tsx packages/domains/terminal/src/server/stdin-input.test.ts
 *
 * Both functions exist because "stdin contains an ESC byte" is not a useful
 * signal: with mouse tracking on (every agent TUI turns it on), the renderer
 * writes an SGR mouse report on every pointer move over the pane. Measured on a
 * live session, 94.3% of all ESC-bearing writes were mouse reports and 0.1%
 * were the user's actual Esc key.
 */
import { isInterruptKey, stripTerminalReports, appendInput, INPUT_BUFFER_MAX } from './stdin-input'

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

const show = (v: unknown): string =>
  typeof v === 'string' ? JSON.stringify(v.replace(/\x1b/g, 'ESC')) : JSON.stringify(v)

function eq<T>(actual: T, expected: T, label?: string): void {
  if (actual !== expected) {
    throw new Error(`${label ? label + ': ' : ''}expected ${show(expected)}, got ${show(actual)}`)
  }
}

// An SGR mouse report: CSI < Cb ; Cx ; Cy (M press/motion | m release).
const sgr = (cb: number, x: number, y: number, rel = false): string =>
  `\x1b[<${cb};${x};${y}${rel ? 'm' : 'M'}`

console.log('\nisInterruptKey')
console.log('─'.repeat(40))

test('a bare ESC is the interrupt key', () => {
  eq(isInterruptKey('\x1b'), true)
})

test('kitty CSI-u encodes Escape as keycode 27', () => {
  // Claude Code enables the kitty keyboard protocol, after which the Esc key
  // never reaches stdin as a bare \x1b.
  eq(isInterruptKey('\x1b[27u'), true)
})

test('kitty CSI-u Escape with a modifier still counts', () => {
  eq(isInterruptKey('\x1b[27;1u'), true)
  eq(isInterruptKey('\x1b[27;5u'), true)
})

test('kitty CSI-u Escape with an event-type subparam still counts', () => {
  eq(isInterruptKey('\x1b[27;1:1u'), true)
})

test('an SGR mouse report is NOT the interrupt key', () => {
  // The whole point: this is what was being counted as an Esc press.
  eq(isInterruptKey(sgr(35, 80, 12)), false)
  eq(isInterruptKey(sgr(0, 12, 34)), false)
  eq(isInterruptKey(sgr(0, 12, 34, true)), false)
})

test('Alt+key word-nav is NOT the interrupt key', () => {
  // The terminal client writes these itself for word-left / word-right.
  eq(isInterruptKey('\x1bb'), false)
  eq(isInterruptKey('\x1bf'), false)
})

test('arrow keys are NOT the interrupt key', () => {
  eq(isInterruptKey('\x1b[A'), false)
  eq(isInterruptKey('\x1b[B'), false)
  eq(isInterruptKey('\x1b[C'), false)
  eq(isInterruptKey('\x1b[D'), false)
})

test('focus reports are NOT the interrupt key', () => {
  eq(isInterruptKey('\x1b[I'), false)
  eq(isInterruptKey('\x1b[O'), false)
})

test('another kitty keycode is NOT the interrupt key', () => {
  eq(isInterruptKey('\x1b[13u'), false, 'Enter')
  eq(isInterruptKey('\x1b[270u'), false, 'must anchor, not prefix-match 27')
})

test('plain text and empty input are NOT the interrupt key', () => {
  eq(isInterruptKey('hello'), false)
  eq(isInterruptKey(''), false)
  eq(isInterruptKey('\x1bhello'), false)
})

console.log('\nstripTerminalReports')
console.log('─'.repeat(40))

test('an SGR mouse press/motion/release report is removed', () => {
  eq(stripTerminalReports(sgr(0, 12, 34)), '')
  eq(stripTerminalReports(sgr(35, 123, 45)), '')
  eq(stripTerminalReports(sgr(0, 12, 34, true)), '')
})

test('mouse reports interleaved with typing leave the typing intact', () => {
  // The real-world shape: the pointer drifts over the pane while the user types.
  eq(stripTerminalReports(`he${sgr(35, 10, 5)}llo`), 'hello')
})

test('a burst of motion reports collapses to nothing', () => {
  const burst = Array.from({ length: 20 }, (_, i) => sgr(35, i, i)).join('')
  eq(stripTerminalReports(burst), '')
})

test('X10 mouse reports are removed with their 3 payload bytes', () => {
  eq(stripTerminalReports('\x1b[M\x20\x21\x22'), '')
  eq(stripTerminalReports(`a\x1b[M\x20\x21\x22b`), 'ab')
})

test('focus in/out reports are removed', () => {
  eq(stripTerminalReports('\x1b[I'), '')
  eq(stripTerminalReports('\x1b[O'), '')
  eq(stripTerminalReports('a\x1b[Ib\x1b[Oc'), 'abc')
})

test('the Esc key survives stripping', () => {
  // Stripping must never eat the one byte the interrupt path cares about.
  eq(stripTerminalReports('\x1b'), '\x1b')
  eq(stripTerminalReports('\x1b[27u'), '\x1b[27u')
})

test('arrow keys survive stripping', () => {
  eq(stripTerminalReports('\x1b[A'), '\x1b[A')
  eq(stripTerminalReports('\x1b[D'), '\x1b[D')
})

test('SS3 function keys survive stripping', () => {
  // ESC O P is F1 — one bracket away from the ESC [ O focus report.
  eq(stripTerminalReports('\x1bOP'), '\x1bOP')
  eq(stripTerminalReports('\x1bOQ'), '\x1bOQ')
})

test('Alt+key word-nav survives stripping', () => {
  eq(stripTerminalReports('\x1bb'), '\x1bb')
  eq(stripTerminalReports('\x1bf'), '\x1bf')
})

test('ordinary typing is untouched', () => {
  eq(stripTerminalReports('git commit -m "fix: thing"\r'), 'git commit -m "fix: thing"\r')
  eq(stripTerminalReports(''), '')
})

console.log('\nappendInput')
console.log('─'.repeat(40))

test('appended input has reports stripped', () => {
  eq(appendInput('git ', `st${sgr(35, 4, 9)}atus`), 'git status')
})

test('a hovered-but-never-submitted pane cannot grow without bound', () => {
  // The bug: inputBuffer only reset on Enter, so pointer motion over a pane the
  // user never types in accumulated forever (~800 B/s while hovering).
  let buf = ''
  for (let i = 0; i < 5000; i++) buf = appendInput(buf, sgr(35, i % 200, i % 50))
  eq(buf, '', 'pure mouse noise must accumulate to nothing')
})

test('the buffer is capped even when the input is not strippable', () => {
  // Backstop for report shapes we do not strip: a long paste must not be able
  // to pin unbounded memory in a long-lived session.
  const buf = appendInput('x'.repeat(INPUT_BUFFER_MAX), 'y'.repeat(500))
  eq(buf.length, INPUT_BUFFER_MAX)
  eq(buf.endsWith('y'.repeat(500)), true, 'cap keeps the most recent input')
})

test('a buffer under the cap is left alone', () => {
  eq(appendInput('abc', 'def'), 'abcdef')
})

console.log('\n' + '─'.repeat(40))
console.log(`${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
