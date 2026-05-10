/**
 * Tests for ClaudeAdapter activity detection
 * Run with: npx tsx packages/domains/terminal/src/main/adapters/claude-adapter.test.ts
 */
import { ClaudeAdapter } from './claude-adapter'

const adapter = new ClaudeAdapter()

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`✓ ${name}`)
  } catch (e) {
    console.log(`✗ ${name}`)
    console.error(`  ${e}`)
    process.exitCode = 1
  }
}

function expect(actual: unknown) {
  return {
    toBe(expected: unknown) {
      if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    },
    toEqual(expected: unknown) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
      }
    }
  }
}

console.log('\nClaudeAdapter config\n')

test('transitionOnInput is not explicitly false (uses TUI default = idle clock gated by adapter activity)', () => {
  // The 60s idle timer must actually fire on this full-screen TUI — otherwise
  // cursor blink keeps lastOutputTime fresh and state stays 'running'. Default
  // (undefined or true) gives that behavior; an explicit `false` would re-
  // introduce the historical stuck-running bug.
  expect(adapter.transitionOnInput !== false).toBe(true)
})

console.log('\nClaudeAdapter.detectActivity\n')

test('detects spinner as working', () => {
  expect(adapter.detectActivity('· Thinking...', 'unknown')).toBe('working')
  expect(adapter.detectActivity('✻ Clauding...', 'unknown')).toBe('working')
})

test('returns null for unrecognized output', () => {
  expect(adapter.detectActivity('Some random text', 'unknown')).toBe(null)
})

test('completion stamp does NOT report working', () => {
  // "Cooked for 56s" / "Cogitated for 4m 24s" = Claude finished — must not
  // pin state to 'running' (regression from a4b6d8d1 attention-state removal).
  expect(adapter.detectActivity('✻ Cooked for 56s', 'unknown')).toBe(null)
  expect(adapter.detectActivity('· Cogitated for 4m 24s', 'unknown')).toBe(null)
  expect(adapter.detectActivity('✽ Pondering for 2h', 'unknown')).toBe(null)
})

console.log('\nClaudeAdapter.detectPrompt\n')

test('detects Y/n as permission prompt', () => {
  const result = adapter.detectPrompt('Allow? [Y/n]')
  expect(result?.type).toBe('permission')
})

test('detects numbered menu as input prompt', () => {
  const data = `Choose:
❯ 1. Option A
  2. Option B`
  const result = adapter.detectPrompt(data)
  expect(result?.type).toBe('input')
})

test('detects question', () => {
  const result = adapter.detectPrompt('What file should I edit?')
  expect(result?.type).toBe('question')
})

console.log('\nDone\n')
