/**
 * Tests for GeminiAdapter detection methods
 * Run with: npx tsx packages/domains/terminal/src/main/adapters/gemini-adapter.test.ts
 */
import { GeminiAdapter } from './gemini-adapter'

const adapter = new GeminiAdapter()

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

console.log('\nGeminiAdapter.detectConversationId\n')

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
  expect(adapter.detectConversationId('Session ID: aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
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

console.log('\nGeminiAdapter.detectError\n')

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

console.log('\nDone\n')
