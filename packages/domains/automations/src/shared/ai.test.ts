/**
 * AI action helper tests
 * Run with: npx tsx packages/domains/automations/src/shared/ai.test.ts
 */
import { buildAiHeadlessCommand, getHeadlessPattern, shellSingleQuote } from './ai.js'

let pass = 0
let fail = 0

function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}`); console.error(`    ${e}`); fail++; process.exitCode = 1 }
}

function expect(actual: unknown) {
  return {
    toBe(expected: unknown) {
      if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    },
    toBeNull() {
      if (actual !== null) throw new Error(`Expected null, got ${JSON.stringify(actual)}`)
    },
  }
}

console.log('\nshellSingleQuote')

test('wraps in single quotes', () => {
  expect(shellSingleQuote('hello')).toBe(`'hello'`)
})

test('escapes embedded single quote', () => {
  // a'b -> 'a'\''b'
  expect(shellSingleQuote(`a'b`)).toBe(`'a'\\''b'`)
})

test('escapes multiple single quotes', () => {
  expect(shellSingleQuote(`it's 'fine'`)).toBe(`'it'\\''s '\\''fine'\\'''`)
})

test('handles double quotes literally', () => {
  expect(shellSingleQuote(`say "hi"`)).toBe(`'say "hi"'`)
})

test('handles backticks literally', () => {
  expect(shellSingleQuote('`whoami`')).toBe(`'\`whoami\`'`)
})

test('empty string', () => {
  expect(shellSingleQuote('')).toBe(`''`)
})

console.log('\ngetHeadlessPattern')

test('returns pattern for known type', () => {
  const p = getHeadlessPattern('claude-code')
  if (!p || !p.includes('{prompt}')) throw new Error(`Bad pattern: ${p}`)
})

test('returns null for unknown type', () => {
  expect(getHeadlessPattern('terminal')).toBeNull()
  expect(getHeadlessPattern('nonexistent')).toBeNull()
})

console.log('\nbuildAiHeadlessCommand — known providers')

test('claude-code: prompt + flags', () => {
  const cmd = buildAiHeadlessCommand(
    { provider: 'claude-code', prompt: 'do thing', flags: '--verbose' },
    { id: 'claude-code', type: 'claude-code', defaultFlags: '--allow' },
  )
  expect(cmd).toBe(`claude -p 'do thing' --verbose`)
})

test('claude-code: falls back to default flags', () => {
  const cmd = buildAiHeadlessCommand(
    { provider: 'claude-code', prompt: 'hello' },
    { id: 'claude-code', type: 'claude-code', defaultFlags: '--allow-x' },
  )
  expect(cmd).toBe(`claude -p 'hello' --allow-x`)
})

test('claude-code: no flags at all', () => {
  const cmd = buildAiHeadlessCommand(
    { provider: 'claude-code', prompt: 'hello' },
    { id: 'claude-code', type: 'claude-code', defaultFlags: null },
  )
  expect(cmd).toBe(`claude -p 'hello'`)
})

test('codex: prompt comes after flags', () => {
  const cmd = buildAiHeadlessCommand(
    { provider: 'codex', prompt: 'fix this', flags: '--full-auto' },
    { id: 'codex', type: 'codex', defaultFlags: null },
  )
  expect(cmd).toBe(`codex exec --full-auto 'fix this'`)
})

test('gemini -p pattern', () => {
  const cmd = buildAiHeadlessCommand(
    { provider: 'gemini', prompt: 'go' },
    { id: 'gemini', type: 'gemini', defaultFlags: '--yolo' },
  )
  expect(cmd).toBe(`gemini -p 'go' --yolo`)
})

test('escapes single quote in prompt', () => {
  const cmd = buildAiHeadlessCommand(
    { provider: 'claude-code', prompt: `it's broken` },
    { id: 'claude-code', type: 'claude-code', defaultFlags: null },
  )
  expect(cmd).toBe(`claude -p 'it'\\''s broken'`)
})

test('explicit empty flags overrides default — no flags applied', () => {
  const cmd = buildAiHeadlessCommand(
    { provider: 'claude-code', prompt: 'hi', flags: '' },
    { id: 'claude-code', type: 'claude-code', defaultFlags: '--allow' },
  )
  expect(cmd).toBe(`claude -p 'hi'`)
})

test('whitespace-only flags also count as explicit empty', () => {
  const cmd = buildAiHeadlessCommand(
    { provider: 'claude-code', prompt: 'hi', flags: '   ' },
    { id: 'claude-code', type: 'claude-code', defaultFlags: '--allow' },
  )
  expect(cmd).toBe(`claude -p 'hi'`)
})

test('undefined flags falls back to default', () => {
  const cmd = buildAiHeadlessCommand(
    { provider: 'claude-code', prompt: 'hi' },
    { id: 'claude-code', type: 'claude-code', defaultFlags: '--allow' },
  )
  expect(cmd).toBe(`claude -p 'hi' --allow`)
})

console.log('\nbuildAiHeadlessCommand — unknown provider type')

test('unknown type returns null', () => {
  const cmd = buildAiHeadlessCommand(
    { provider: 'custom', prompt: 'hi' },
    { id: 'custom', type: 'terminal', defaultFlags: null },
  )
  expect(cmd).toBeNull()
})

console.log(`\n${pass} passed, ${fail} failed`)
