/**
 * Tests for CodexAdapter activity detection
 * Run with: npx tsx packages/domains/terminal/src/main/adapters/codex-adapter.test.ts
 */
import { CodexAdapter } from './codex-adapter'

const adapter = new CodexAdapter()

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

console.log('\nCodexAdapter.detectActivity\n')

test('detects "esc to interrupt" as working', () => {
  const data = '• Planning typecheck and minor updates (3m 37s • esc to interrupt)'
  expect(adapter.detectActivity(data, 'unknown')).toBe('working')
})

test('detects "esc to interrupt" with ANSI codes as working', () => {
  const data = '\x1b[1m• Planning\x1b[0m (1m 2s • \x1b[2mesc to interrupt\x1b[0m)'
  expect(adapter.detectActivity(data, 'unknown')).toBe('working')
})

test('detects "esc to interrupt" case-insensitively', () => {
  expect(adapter.detectActivity('Esc to interrupt', 'unknown')).toBe('working')
  expect(adapter.detectActivity('ESC TO INTERRUPT', 'unknown')).toBe('working')
})

test('keeps working latched when chunk lacks indicator', () => {
  expect(adapter.detectActivity('Some output without the indicator', 'working')).toBe(null)
})

test('returns null for text when not currently working', () => {
  expect(adapter.detectActivity('Some random text', 'unknown')).toBe(null)
  expect(adapter.detectActivity('Some random text', 'attention')).toBe(null)
})

test('returns null for whitespace-only output when working', () => {
  expect(adapter.detectActivity('   \n\r  ', 'working')).toBe(null)
})

test('"esc to interrupt" takes priority even when currently working', () => {
  const data = '• Editing files (5s • esc to interrupt)'
  expect(adapter.detectActivity(data, 'working')).toBe('working')
})

test('detects alternative working indicator phrases', () => {
  expect(adapter.detectActivity('Escape to cancel', 'unknown')).toBe('working')
  expect(adapter.detectActivity('Ctrl+C to stop', 'unknown')).toBe('working')
})

console.log('\nCodexAdapter.detectError\n')

test('detects stale codex resume session as SESSION_NOT_FOUND', () => {
  const result = adapter.detectError('ERROR: No saved session found with ID 019c7a76-280a-7dc0-8af6-affe6cf174b2')
  expect(result?.code).toBe('SESSION_NOT_FOUND')
})

test('detects generic codex error line', () => {
  const result = adapter.detectError('ERROR: Something went wrong')
  expect(result?.code).toBe('CLI_ERROR')
  expect(result?.message).toBe('Something went wrong')
})

console.log('\nCodexAdapter.detectConversationId\n')

test('extracts UUID from real /status box-drawing output', () => {
  const data = `╭────────────────────────────────────────────────────────────────────────────────╮
│  >_ OpenAI Codex (v0.118.0)                                                    │
│                                                                                │
│  Model:                gpt-5.4 (reasoning high, summaries auto)                │
│  Directory:            ~/dev/projects/slayzone                                 │
│  Permissions:          Custom (workspace-write, on-request)                    │
│  Session:              019d5014-bedf-7363-a87f-f476d22053d4                    │
│                                                                                │
│  5h limit:             [█████████████████░░░] 84% left (resets 01:23 on 3 Apr) │
╰────────────────────────────────────────────────────────────────────────────────╯`
  expect(adapter.detectConversationId(data)).toBe('019d5014-bedf-7363-a87f-f476d22053d4')
})

test('extracts UUID from plain Session: line', () => {
  expect(adapter.detectConversationId('Session: aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
})

test('extracts UUID from rollout filename format', () => {
  expect(adapter.detectConversationId('rollout-1234567890-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl')).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
})

test('falls back to bare UUID when label is mangled by TUI artifacts', () => {
  // Real TUI output may have cursor positioning between label and UUID
  const data = '\rSession:\r\n019d5014-bedf-7363-a87f-f476d22053d4\r\n'
  expect(adapter.detectConversationId(data)).toBe('019d5014-bedf-7363-a87f-f476d22053d4')
})

test('returns null when no session ID present', () => {
  expect(adapter.detectConversationId('Model: gpt-5.4\nDirectory: ~/dev\n')).toBe(null)
})

test('handles ANSI codes in session line', () => {
  const data = '\x1b[1mSession:\x1b[0m  019d5014-bedf-7363-a87f-f476d22053d4'
  expect(adapter.detectConversationId(data)).toBe('019d5014-bedf-7363-a87f-f476d22053d4')
})

console.log('\nDone\n')
