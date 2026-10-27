/**
 * Tests for GeminiAdapter detection methods
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run --config packages/shared/test-utils/vitest.harness.config.ts packages/domains/terminal/src/server/adapters/gemini-adapter.test.ts
 */
import { describe, expect, test } from 'vitest'
import { GeminiAdapter } from './gemini-adapter'

const adapter = new GeminiAdapter()

describe('GeminiAdapter.detectConversationId', () => {
  test('extracts UUID from real /stats box-drawing output', () => {
    const data = `╭───────────────────────────────────────────────────────────╮
│                                                                               │
│  Session Stats                                                                │
│                                                                               │
│  Interaction Summary                                                          │
│  Session ID:                 410fe90d-0542-49ad-8003-d092114063f6             │
│  Auth Method:                Signed in with Google (kalle@normain.com)        │
│  Tier:                       Gemini Code Assist for individuals               │
│  Tool Calls:                 45 ( ✓ 43 x 2 )                                 │
│  Success Rate:               95.6%                                            │
│                                                                               │
╰───────────────────────────────────────────────────────────╯`
    expect(adapter.detectConversationId(data)).toBe('410fe90d-0542-49ad-8003-d092114063f6')
  })

  test('extracts UUID from plain Session ID: line', () => {
    expect(adapter.detectConversationId('Session ID: aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')).toBe(
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    )
  })

  test('falls back to bare UUID when label is mangled', () => {
    const data = '\rSession ID:\r\n410fe90d-0542-49ad-8003-d092114063f6\r\n'
    expect(adapter.detectConversationId(data)).toBe('410fe90d-0542-49ad-8003-d092114063f6')
  })

  test('returns null when no session ID present', () => {
    expect(adapter.detectConversationId('Tool Calls: 45\nSuccess Rate: 95.6%\n')).toBe(null)
  })

  test('handles ANSI codes in session line', () => {
    const data = '\x1b[1mSession ID:\x1b[0m  410fe90d-0542-49ad-8003-d092114063f6'
    expect(adapter.detectConversationId(data)).toBe('410fe90d-0542-49ad-8003-d092114063f6')
  })
})

describe('GeminiAdapter.detectError', () => {
  test('detects missing API key', () => {
    const result = adapter.detectError('GEMINI_API_KEY environment variable not found')
    expect(result?.code).toBe('MISSING_API_KEY')
  })

  test('detects rate limit', () => {
    const result = adapter.detectError('429 Too Many Requests')
    expect(result?.code).toBe('RATE_LIMIT')
  })

  test('returns null for normal output', () => {
    expect(adapter.detectError('Some normal output')).toBe(null)
  })
})
