/**
 * AI action helper tests
 * Run with: npx tsx packages/domains/automations/src/shared/ai.test.ts
 */
import { buildAiHeadlessCommand, shellSingleQuote } from './ai.js'

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
  expect(shellSingleQuote(`it's`)).toBe(`'it'\\''s'`)
})

test('preserves newlines bytewise', () => {
  expect(shellSingleQuote('a\nb')).toBe(`'a\nb'`)
})

test('preserves internal whitespace', () => {
  expect(shellSingleQuote('a  b   c')).toBe(`'a  b   c'`)
})

test('null/undefined become empty string', () => {
  expect(shellSingleQuote(null)).toBe(`''`)
  expect(shellSingleQuote(undefined)).toBe(`''`)
})

console.log('\nbuildAiHeadlessCommand')

const claudeProvider = {
  id: 'claude-code',
  type: 'claude-code',
  headlessCommand: 'claude -p {prompt} {flags}',
  defaultFlags: '--allow-dangerously-skip-permissions',
}

const codexProvider = {
  id: 'codex',
  type: 'codex',
  headlessCommand: 'codex exec {flags} {prompt}',
  defaultFlags: '--sandbox workspace-write',
}

test('builds claude w/ default flags', () => {
  expect(buildAiHeadlessCommand({ provider: 'claude-code', prompt: 'hi' }, claudeProvider))
    .toBe(`claude -p 'hi' --allow-dangerously-skip-permissions`)
})

test('builds codex w/ flags-in-middle', () => {
  expect(buildAiHeadlessCommand({ provider: 'codex', prompt: 'hi' }, codexProvider))
    .toBe(`codex exec --sandbox workspace-write 'hi'`)
})

test('explicit empty flags overrides default — trailing position', () => {
  expect(buildAiHeadlessCommand({ provider: 'claude-code', prompt: 'hi', flags: '' }, claudeProvider))
    .toBe(`claude -p 'hi'`)
})

test('explicit empty flags overrides default — middle position', () => {
  expect(buildAiHeadlessCommand({ provider: 'codex', prompt: 'hi', flags: '' }, codexProvider))
    .toBe(`codex exec 'hi'`)
})

test('whitespace-only flags also count as explicit empty', () => {
  expect(buildAiHeadlessCommand({ provider: 'claude-code', prompt: 'hi', flags: '   ' }, claudeProvider))
    .toBe(`claude -p 'hi'`)
})

test('user flags replace defaults', () => {
  expect(buildAiHeadlessCommand({ provider: 'claude-code', prompt: 'hi', flags: '--verbose' }, claudeProvider))
    .toBe(`claude -p 'hi' --verbose`)
})

test('preserves multi-line prompt — newlines stay in quotes', () => {
  expect(buildAiHeadlessCommand({ provider: 'claude-code', prompt: 'line1\nline2', flags: '' }, claudeProvider))
    .toBe(`claude -p 'line1\nline2'`)
})

test('preserves internal double-spaces in prompt', () => {
  expect(buildAiHeadlessCommand({ provider: 'claude-code', prompt: 'two  spaces', flags: '--verbose' }, claudeProvider))
    .toBe(`claude -p 'two  spaces' --verbose`)
})

test('literal {flags} in prompt does not corrupt flags slot', () => {
  expect(buildAiHeadlessCommand({ provider: 'claude-code', prompt: 'use {flags} here', flags: '--verbose' }, { ...claudeProvider, defaultFlags: null }))
    .toBe(`claude -p 'use {flags} here' --verbose`)
})

test('literal {prompt} in flags does not break substitution', () => {
  expect(buildAiHeadlessCommand({ provider: 'claude-code', prompt: 'hi', flags: '--note={prompt}' }, { ...claudeProvider, defaultFlags: null }))
    .toBe(`claude -p 'hi' --note={prompt}`)
})

test('escapes single quote in prompt', () => {
  expect(buildAiHeadlessCommand({ provider: 'claude-code', prompt: `it's`, flags: '' }, claudeProvider))
    .toBe(`claude -p 'it'\\''s'`)
})

test('returns null when provider has no headless template', () => {
  expect(buildAiHeadlessCommand(
    { provider: 'terminal', prompt: 'hi' },
    { id: 'terminal', type: 'terminal', headlessCommand: null, defaultFlags: null },
  )).toBeNull()
})

test('returns null when template is empty string', () => {
  expect(buildAiHeadlessCommand(
    { provider: 'x', prompt: 'hi' },
    { id: 'x', type: 'x', headlessCommand: '', defaultFlags: null },
  )).toBeNull()
})

test('returns null when template is whitespace only', () => {
  expect(buildAiHeadlessCommand(
    { provider: 'x', prompt: 'hi' },
    { id: 'x', type: 'x', headlessCommand: '   ', defaultFlags: null },
  )).toBeNull()
})

test('custom template w/ no flag slot still works', () => {
  expect(buildAiHeadlessCommand(
    { provider: 'x', prompt: 'hi', flags: 'ignored' },
    { id: 'x', type: 'x', headlessCommand: 'mycli {prompt}', defaultFlags: null },
  )).toBe(`mycli 'hi'`)
})

test('custom template w/ no prompt slot still works (degenerate)', () => {
  expect(buildAiHeadlessCommand(
    { provider: 'x', prompt: 'hi' },
    { id: 'x', type: 'x', headlessCommand: 'mycli {flags}', defaultFlags: '--foo' },
  )).toBe(`mycli --foo`)
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
