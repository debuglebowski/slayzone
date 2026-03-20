/**
 * Tests for QwenAdapter activity/error/prompt detection
 * Run with: npx tsx packages/domains/terminal/src/main/adapters/qwen-adapter.test.ts
 */
import { QwenAdapter } from './qwen-adapter'

const adapter = new QwenAdapter()

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

console.log('\nQwenAdapter.detectActivity\n')

test('detects braille spinner as working', () => {
  for (const char of '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏') {
    expect(adapter.detectActivity(`${char} generating…`, 'unknown')).toBe('working')
  }
})

test('detects braille spinner with ANSI codes as working', () => {
  expect(adapter.detectActivity('\x1b[32m⠙\x1b[0m Thinking...', 'unknown')).toBe('working')
})

test('strips OSC sequences terminated by ST (ESC \\)', () => {
  const oscSt = '\x1b]0;title\x1b\\'
  expect(adapter.detectActivity(`${oscSt}⠙ generating…`, 'unknown')).toBe('working')
})

test('detects completion summary (spinner + "for Xm Ys") as attention', () => {
  expect(adapter.detectActivity('⠏ for 2m 30s', 'working')).toBe('attention')
  expect(adapter.detectActivity('⠋ for 45s', 'working')).toBe('attention')
})

test('completion summary takes priority over plain spinner', () => {
  // "for \d+" should win over bare braille
  expect(adapter.detectActivity('⠙ for 1m', 'working')).toBe('attention')
})

test('detects numbered menu as attention', () => {
  const data = `Would you like to proceed?\n❯ 1. Yes\n  2. No`
  expect(adapter.detectActivity(data, 'working')).toBe('attention')
})

test('detects Y/n prompt as attention', () => {
  expect(adapter.detectActivity('Allow this action? [Y/n]', 'unknown')).toBe('attention')
  expect(adapter.detectActivity('Continue? [y/N]', 'unknown')).toBe('attention')
})

test('detects bare ❯ prompt as attention', () => {
  expect(adapter.detectActivity('❯ ', 'working')).toBe('attention')
  expect(adapter.detectActivity('\n❯ ', 'working')).toBe('attention')
})

test('attention takes priority over braille spinner', () => {
  const data = `⠙ Thinking...\n❯ 1. Yes\n  2. No`
  expect(adapter.detectActivity(data, 'working')).toBe('attention')
})

test('returns null for unrecognized output', () => {
  expect(adapter.detectActivity('Some random output', 'unknown')).toBe(null)
})

console.log('\nQwenAdapter.detectError\n')

test('detects session not found', () => {
  const result = adapter.detectError('No conversation found with session ID: abc-123')
  expect(result?.code).toBe('SESSION_NOT_FOUND')
  expect(result?.recoverable).toBe(false)
})

test('detects authentication failure', () => {
  expect(adapter.detectError('authentication failed')?.code).toBe('NOT_AUTHENTICATED')
  expect(adapter.detectError('not authenticated')?.code).toBe('NOT_AUTHENTICATED')
  expect(adapter.detectError('please log in')?.code).toBe('NOT_AUTHENTICATED')
})

test('auth error is not recoverable', () => {
  expect(adapter.detectError('authentication failed')?.recoverable).toBe(false)
})

test('detects 429 rate limit', () => {
  expect(adapter.detectError('429 Too Many Requests')?.code).toBe('RATE_LIMIT')
})

test('detects rate-limit variants', () => {
  expect(adapter.detectError('rate limit exceeded')?.code).toBe('RATE_LIMIT')
  expect(adapter.detectError('quota exceeded')?.code).toBe('RATE_LIMIT')
  expect(adapter.detectError('ratelimit hit')?.code).toBe('RATE_LIMIT')
})

test('rate limit is recoverable', () => {
  expect(adapter.detectError('429 Too Many Requests')?.recoverable).toBe(true)
})

test('detects generic Error: line', () => {
  const result = adapter.detectError('Error: something went wrong')
  expect(result?.code).toBe('CLI_ERROR')
  expect(result?.recoverable).toBe(true)
})

test('returns null for benign output', () => {
  expect(adapter.detectError('All done!')).toBe(null)
})

console.log('\nQwenAdapter.detectPrompt\n')

test('detects Y/n as permission prompt', () => {
  expect(adapter.detectPrompt('Allow? [Y/n]')?.type).toBe('permission')
})

test('detects numbered menu as input prompt', () => {
  const data = `Choose:\n❯ 1. Option A\n  2. Option B`
  expect(adapter.detectPrompt(data)?.type).toBe('input')
})

test('detects trailing question as question prompt', () => {
  expect(adapter.detectPrompt('What file should I edit?')?.type).toBe('question')
})

test('returns null when no prompt', () => {
  expect(adapter.detectPrompt('Writing file...')).toBe(null)
})

console.log('\nDone\n')
