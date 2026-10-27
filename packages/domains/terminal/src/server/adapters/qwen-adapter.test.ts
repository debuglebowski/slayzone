/**
 * Tests for QwenAdapter activity/error/prompt detection
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run --config packages/shared/test-utils/vitest.harness.config.ts packages/domains/terminal/src/server/adapters/qwen-adapter.test.ts
 */
import { describe, expect, test } from 'vitest'
import { QwenAdapter } from './qwen-adapter'

const adapter = new QwenAdapter()

describe('QwenAdapter.detectActivity', () => {
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

  test('returns null for unrecognized output', () => {
    expect(adapter.detectActivity('Some random output', 'unknown')).toBe(null)
  })
})

describe('QwenAdapter.detectError', () => {
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
})

describe('QwenAdapter.detectPrompt', () => {
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
})
