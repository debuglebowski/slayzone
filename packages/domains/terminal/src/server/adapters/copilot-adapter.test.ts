/**
 * Tests for CopilotAdapter activity and error detection
 * Run with: npx tsx packages/domains/terminal/src/main/adapters/copilot-adapter.test.ts
 */
import { CopilotAdapter } from './copilot-adapter'

const adapter = new CopilotAdapter()

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
    }
  }
}

console.log('\nCopilotAdapter.detectActivity\n')

test('returns null for generic output (input-driven detection)', () => {
  expect(adapter.detectActivity('Some TUI output', 'unknown')).toBe(null)
})

console.log('\nCopilotAdapter.detectPrompt\n')

test('detects Y/n prompt as permission', () => {
  expect(adapter.detectPrompt('Continue? [Y/n]')?.type).toBe('permission')
})

test('detects numbered menu as input prompt', () => {
  expect(adapter.detectPrompt('❯ 1. Continue')?.type).toBe('input')
})

test('detects question line as question prompt', () => {
  expect(adapter.detectPrompt('Should I proceed?')?.type).toBe('question')
})

console.log('\nCopilotAdapter.detectError\n')

test('detects stale session as SESSION_NOT_FOUND', () => {
  const result = adapter.detectError('ERROR: No saved session found with ID 019c7a76-280a-7dc0-8af6-affe6cf174b2')
  expect(result?.code).toBe('SESSION_NOT_FOUND')
})

test('detects auth errors', () => {
  const result = adapter.detectError('Please run copilot login to continue')
  expect(result?.code).toBe('AUTH_ERROR')
})

test('detects rate limits', () => {
  const result = adapter.detectError('429 Too Many Requests')
  expect(result?.code).toBe('RATE_LIMIT')
})

test('detects generic CLI errors', () => {
  const result = adapter.detectError('ERROR: Something went wrong')
  expect(result?.code).toBe('CLI_ERROR')
})

console.log('\nDone\n')
