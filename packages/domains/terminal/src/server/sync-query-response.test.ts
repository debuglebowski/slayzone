/**
 * Tests for computeSyncQueryResponse — the pure logic behind interceptSyncQueries.
 * Run with: npx tsx packages/domains/terminal/src/main/sync-query-response.test.ts
 */
import { computeSyncQueryResponse } from './sync-query-response'

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
    const show = (v: unknown) => typeof v === 'string' ? JSON.stringify(v.replace(/\x1b/g, 'ESC')) : JSON.stringify(v)
    throw new Error(`${label ? label + ': ' : ''}expected ${show(expected)}, got ${show(actual)}`)
  }
}

const theme = { foreground: '#abcdef', background: '#123456', cursor: '#fedcba' }

console.log('\ncomputeSyncQueryResponse')
console.log('─'.repeat(40))

test('DA1 — primary device attributes', () => {
  const r = computeSyncQueryResponse('\x1b[c', theme)
  eq(r.response, '\x1b[?62;4;22c')
  eq(r.forwarded, '')
})

test('DA2 — secondary device attributes', () => {
  const r = computeSyncQueryResponse('\x1b[>c', theme)
  eq(r.response, '\x1b[>0;10;1c')
  eq(r.forwarded, '')
})

test('DSR — device status report', () => {
  const r = computeSyncQueryResponse('\x1b[5n', theme)
  eq(r.response, '\x1b[0n')
  eq(r.forwarded, '')
})

test('CPR — cursor position report', () => {
  const r = computeSyncQueryResponse('\x1b[6n', theme)
  eq(r.response, '\x1b[1;1R')
  eq(r.forwarded, '')
})

test('OSC 10 fg color query answered from theme', () => {
  const r = computeSyncQueryResponse('\x1b]10;?\x07', theme)
  eq(r.response, '\x1b]10;rgb:abab/cdcd/efef\x07')
  eq(r.forwarded, '')
})

test('OSC 11 bg color query answered from theme', () => {
  const r = computeSyncQueryResponse('\x1b]11;?\x07', theme)
  eq(r.response, '\x1b]11;rgb:1212/3434/5656\x07')
  eq(r.forwarded, '')
})

test('OSC 12 cursor color query answered from theme', () => {
  const r = computeSyncQueryResponse('\x1b]12;?\x07', theme)
  eq(r.response, '\x1b]12;rgb:fefe/dcdc/baba\x07')
  eq(r.forwarded, '')
})

test('OSC 4 palette query — index 0 (black) from xterm defaults', () => {
  const r = computeSyncQueryResponse('\x1b]4;0;?\x07', theme)
  eq(r.response, '\x1b]4;0;rgb:0000/0000/0000\x07')
  eq(r.forwarded, '')
})

test('OSC 4 palette query — index 9 (bright red)', () => {
  const r = computeSyncQueryResponse('\x1b]4;9;?\x07', theme)
  eq(r.response, '\x1b]4;9;rgb:ffff/0000/0000\x07')
  eq(r.forwarded, '')
})

test('OSC 4 palette query — index 42 (out of 0-15 range) falls through to catch-all', () => {
  const r = computeSyncQueryResponse('\x1b]4;42;?\x07', theme)
  // Catch-all reply is empty of the form ESC ] 4 ; ST — note the body is stripped.
  eq(r.response, '\x1b]4;\x07')
  eq(r.forwarded, '')
})

test('OSC 4 uses theme.ansi when provided (overrides xterm defaults)', () => {
  const ansi = [
    '#111111', '#222222', '#333333', '#444444', '#555555', '#666666', '#777777', '#888888',
    '#999999', '#aaaaaa', '#bbbbbb', '#cccccc', '#dddddd', '#eeeeee', '#ff0000', '#00ff00'
  ]
  const themed = { ...theme, ansi }
  const r = computeSyncQueryResponse('\x1b]4;0;?\x07\x1b]4;14;?\x07', themed)
  eq(r.response, '\x1b]4;0;rgb:1111/1111/1111\x07\x1b]4;14;rgb:ffff/0000/0000\x07')
  eq(r.forwarded, '')
})

test('OSC 4 falls back to xterm defaults when theme.ansi is undefined', () => {
  const r = computeSyncQueryResponse('\x1b]4;0;?\x07', theme)
  eq(r.response, '\x1b]4;0;rgb:0000/0000/0000\x07')
})

test('OSC 4 falls back to xterm defaults when theme.ansi is a short array', () => {
  const themed = { ...theme, ansi: ['#112233'] } // only index 0 provided
  const r = computeSyncQueryResponse('\x1b]4;5;?\x07', themed)
  // Index 5 not in ansi → falls back to XTERM_ANSI_PALETTE[5] = magenta #cd00cd
  eq(r.response, '\x1b]4;5;rgb:cdcd/0000/cdcd\x07')
})

test('catch-all — unknown OSC 52 (clipboard) gets empty reply', () => {
  const r = computeSyncQueryResponse('\x1b]52;c;?\x07', theme)
  eq(r.response, '\x1b]52;\x07')
  eq(r.forwarded, '')
})

test('catch-all — OSC 7 cwd query gets empty reply', () => {
  const r = computeSyncQueryResponse('\x1b]7;?\x07', theme)
  eq(r.response, '\x1b]7;\x07')
  eq(r.forwarded, '')
})

test('catch-all — OSC with ST terminator (ESC \\)', () => {
  const r = computeSyncQueryResponse('\x1b]99;?\x1b\\', theme)
  eq(r.response, '\x1b]99;\x07')
  eq(r.forwarded, '')
})

test('non-query OSC sequences are passed through unchanged', () => {
  // OSC 0 title set (no trailing ?) must NOT be consumed.
  const input = '\x1b]0;my-title\x07hello'
  const r = computeSyncQueryResponse(input, theme)
  eq(r.response, '')
  eq(r.forwarded, input)
})

test('plain output passed through unchanged', () => {
  const r = computeSyncQueryResponse('hello world\n', theme)
  eq(r.response, '')
  eq(r.forwarded, 'hello world\n')
})

test('mixed — DA1 + OSC 11 + plain text — all answered, text preserved', () => {
  const r = computeSyncQueryResponse('before\x1b[cmiddle\x1b]11;?\x07after', theme)
  eq(r.response, '\x1b[?62;4;22c\x1b]11;rgb:1212/3434/5656\x07')
  eq(r.forwarded, 'beforemiddleafter')
})

test('trailing partial OSC held for next chunk', () => {
  const r = computeSyncQueryResponse('done\x1b]4;0;?', theme)
  // The OSC lacks a terminator so it must be held, not consumed.
  eq(r.response, '')
  eq(r.forwarded, 'done')
  eq(r.pendingPartial, '\x1b]4;0;?')
})

test('trailing partial CSI held for next chunk', () => {
  const r = computeSyncQueryResponse('data\x1b[0', theme)
  eq(r.response, '')
  eq(r.forwarded, 'data')
  eq(r.pendingPartial, '\x1b[0')
})

test('lone trailing ESC held (possible ST start)', () => {
  const r = computeSyncQueryResponse('data\x1b', theme)
  eq(r.response, '')
  eq(r.forwarded, 'data')
  eq(r.pendingPartial, '\x1b')
})

test('answers query assembled across two chunks', () => {
  const r1 = computeSyncQueryResponse('pre\x1b]4;0;?', theme)
  eq(r1.pendingPartial, '\x1b]4;0;?')
  eq(r1.forwarded, 'pre')
  const r2 = computeSyncQueryResponse(r1.pendingPartial + '\x07post', theme)
  eq(r2.response, '\x1b]4;0;rgb:0000/0000/0000\x07')
  eq(r2.forwarded, 'post')
})

console.log('\n' + '─'.repeat(40))
console.log(`${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
