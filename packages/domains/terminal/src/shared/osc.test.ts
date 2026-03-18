/**
 * OSC title extraction tests
 * Run with: pnpm tsx packages/domains/terminal/src/shared/osc.test.ts
 */
import { extractOscTitle } from './osc.js'

function test(name: string, fn: () => void) { try { fn(); console.log(`  ✓ ${name}`) } catch (e) { console.error(`  ✗ ${name}`); throw e } }
function expect<T>(v: T) { return { toBe(e: T) { if (v !== e) throw new Error(`expected ${JSON.stringify(e)}, got ${JSON.stringify(v)}`) }, toBeUndefined() { if (v !== undefined) throw new Error(`expected undefined, got ${JSON.stringify(v)}`) } } }

console.log('extractOscTitle')

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

console.log('\nDone')
