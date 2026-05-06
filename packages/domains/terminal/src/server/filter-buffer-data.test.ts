/**
 * Tests for filterBufferData (underline stripping from PTY output)
 * Run with: npx tsx packages/domains/terminal/src/main/filter-buffer-data.test.ts
 */
import { filterBufferData } from './filter-buffer-data'
import { stripUnderlineCodes } from '../shared/strip-underline'

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
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

function assert(actual: string, expected: string, label?: string) {
  if (actual !== expected) {
    const vis = (s: string) => s.replace(/\x1b/g, 'ESC')
    throw new Error(`${label ? label + ': ' : ''}expected ${vis(expected)}, got ${vis(actual)}`)
  }
}

console.log('\nfilterBufferData')
console.log('─'.repeat(40))

// Basic underline stripping
test('strips standalone SGR 4 (underline)', () => {
  assert(filterBufferData('\x1b[4m'), '')
})

test('strips SGR 4 with subparameters (curly underline 4:3)', () => {
  assert(filterBufferData('\x1b[4:3m'), '')
})

test('strips all underline variants 4:1 through 4:5', () => {
  for (let i = 1; i <= 5; i++) {
    assert(filterBufferData(`\x1b[4:${i}m`), '', `4:${i}`)
  }
})

test('strips double underline (4:2)', () => {
  assert(filterBufferData('\x1b[4:2m'), '')
})

// Combined SGR codes
test('strips underline from combined codes (bold+underline+red)', () => {
  assert(filterBufferData('\x1b[1;4;31m'), '\x1b[1;31m')
})

test('strips curly underline from combined codes', () => {
  assert(filterBufferData('\x1b[1;4:3;32m'), '\x1b[1;32m')
})

test('preserves other codes when underline removed', () => {
  assert(filterBufferData('\x1b[1;4;31;42m'), '\x1b[1;31;42m')
})

// Edge cases
test('preserves SGR 24 (underline off) — not the same as SGR 4', () => {
  assert(filterBufferData('\x1b[24m'), '\x1b[24m')
})

test('preserves SGR 0 (reset)', () => {
  assert(filterBufferData('\x1b[0m'), '\x1b[0m')
})

test('preserves bare reset ESC[m', () => {
  assert(filterBufferData('\x1b[m'), '\x1b[m')
})

test('preserves color codes unchanged', () => {
  assert(filterBufferData('\x1b[31m'), '\x1b[31m')
  assert(filterBufferData('\x1b[38;5;200m'), '\x1b[38;5;200m')
  assert(filterBufferData('\x1b[38;2;100;150;200m'), '\x1b[38;2;100;150;200m')
})

test('preserves bold, italic, inverse, strikethrough', () => {
  assert(filterBufferData('\x1b[1m'), '\x1b[1m')
  assert(filterBufferData('\x1b[3m'), '\x1b[3m')
  assert(filterBufferData('\x1b[7m'), '\x1b[7m')
  assert(filterBufferData('\x1b[9m'), '\x1b[9m')
})

test('preserves plain text unchanged', () => {
  assert(filterBufferData('hello world'), 'hello world')
})

test('handles mixed text and SGR codes', () => {
  assert(
    filterBufferData('hello \x1b[1;4;31mworld\x1b[0m'),
    'hello \x1b[1;31mworld\x1b[0m'
  )
})

test('strips underline code 44 is NOT stripped (it is bg blue)', () => {
  assert(filterBufferData('\x1b[44m'), '\x1b[44m')
})

test('handles SGR 4 alone in combined becoming empty', () => {
  assert(filterBufferData('\x1b[4m'), '')
})

// OSC stripping
test('strips title-setting OSC sequences', () => {
  assert(filterBufferData('\x1b]0;my title\x07'), '')
  assert(filterBufferData('\x1b]2;my title\x07'), '')
})

test('strips clipboard OSC sequences', () => {
  assert(filterBufferData('\x1b]52;c;base64data\x07'), '')
})

test('preserves non-title OSC sequences', () => {
  // OSC 7 (cwd notification) should pass through
  assert(filterBufferData('\x1b]7;file:///path\x07'), '\x1b]7;file:///path\x07')
})

// RGB/256 color combined with underline
test('strips underline from RGB color sequence', () => {
  assert(filterBufferData('\x1b[38;2;100;150;200;4m'), '\x1b[38;2;100;150;200m')
})

test('strips underline from 256-color sequence', () => {
  assert(filterBufferData('\x1b[38;5;200;4m'), '\x1b[38;5;200m')
})

test('strips curly underline from RGB color sequence', () => {
  assert(filterBufferData('\x1b[38;2;100;150;200;4:3m'), '\x1b[38;2;100;150;200m')
})

test('strips underline between color params', () => {
  assert(filterBufferData('\x1b[1;4;38;5;200m'), '\x1b[1;38;5;200m')
})

// Regression: multiple underlines in one stream
test('strips multiple underline sequences in one buffer', () => {
  assert(
    filterBufferData('\x1b[4mfoo\x1b[0m bar \x1b[4:3mbaz\x1b[0m'),
    'foo\x1b[0m bar baz\x1b[0m'
  )
})

// Split sequence simulation — server filter applied per chunk, client filter on joined batch
test('split sequence: server filter misses split escape', () => {
  // Server processes chunks independently — split escape slips through
  const chunk1 = filterBufferData('hello\x1b[')
  const chunk2 = filterBufferData('4mworld')
  assert(chunk1, 'hello\x1b[', 'chunk1 preserves partial escape')
  assert(chunk2, '4mworld', 'chunk2 passes through unmatched')
})

test('split sequence: client-side join + filter catches it', () => {
  // Client batches chunks per rAF frame, joins, then filters — catches the split
  const chunk1 = filterBufferData('hello\x1b[')
  const chunk2 = filterBufferData('4mworld')
  const joined = stripUnderlineCodes(chunk1 + chunk2)
  assert(joined, 'helloworld', 'joined + filtered strips underline')
})

console.log('─'.repeat(40))
console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed > 0 ? 1 : 0)
