/**
 * Tests for AntigravityAdapter detection methods
 * Run with: npx tsx packages/domains/terminal/src/main/adapters/antigravity-adapter.test.ts
 */
import { AntigravityAdapter } from './antigravity-adapter'

const adapter = new AntigravityAdapter()

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
      if (actual !== expected)
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    }
  }
}

console.log('\nAntigravityAdapter.detectConversationId\n')

test('extracts UUID from box-drawing session output', () => {
  const data = `╭───────────────────────────────────────────────────────────╮
│                                                                               │
│  Session Stats                                                                │
│                                                                               │
│  Session ID:                 410fe90d-0542-49ad-8003-d092114063f6             │
│  Tool Calls:                 45                                              │
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

console.log('\nAntigravityAdapter.detectError\n')

test('detects missing auth (ANTIGRAVITY_TOKEN)', () => {
  const result = adapter.detectError('ANTIGRAVITY_TOKEN environment variable not found')
  expect(result?.code).toBe('MISSING_API_KEY')
})

test('detects missing auth (signed out)', () => {
  const result = adapter.detectError('Error: not authenticated. Run antigravity login.')
  expect(result?.code).toBe('MISSING_API_KEY')
})

test('detects rate limit', () => {
  const result = adapter.detectError('429 Too Many Requests')
  expect(result?.code).toBe('RATE_LIMIT')
})

test('returns null for normal output', () => {
  expect(adapter.detectError('Some normal output')).toBe(null)
})

console.log('\nAntigravityAdapter.detectActivity\n')

test('long raw output does NOT promote to working (hook-driven — no re-flip after Stop)', () => {
  // Regression: antigravity is hook-driven (PreInvocation → running, Stop →
  // idle — see antigravity-hook-installer). A length-based 'working' heuristic
  // re-flipped running right after a Stop hook settled the session to idle,
  // because the TUI keeps redrawing. detectActivity must NOT report 'working'.
  expect(adapter.detectActivity('x'.repeat(200), 'idle')).toBe(null)
  expect(
    adapter.detectActivity('the agent printed a fairly long status line here now', 'idle')
  ).toBe(null)
})

test('approval modal → idle (no permission hook; output is the only signal)', () => {
  // Antigravity registers PreInvocation/PostToolUse/Stop — no permission hook.
  // A pending y/n approval prompt has no hook to flip it, so detectActivity
  // reports 'idle' (the agent is waiting on the user → needs attention).
  expect(adapter.detectActivity('Approve? (y/n)', 'unknown')).toBe('idle')
  expect(adapter.detectActivity('Run this command? Approve? (y/n/always)', 'unknown')).toBe('idle')
  // ANSI-wrapped marker still matches.
  expect(adapter.detectActivity('\x1b[1mApprove?\x1b[0m (y/n)', 'unknown')).toBe('idle')
})

test('plain output without modal → null', () => {
  expect(adapter.detectActivity('Reading file foo.ts', 'unknown')).toBe(null)
  expect(adapter.detectActivity('', 'unknown')).toBe(null)
})

console.log('\nAntigravityAdapter config\n')

test('transitionOnInput is not explicitly false (TUI default → Enter flips to running)', () => {
  // Hook-driven like Claude/Codex: the TUI default keeps the Enter → 'running'
  // flip for instant feedback before the PreInvocation hook lands. An explicit
  // `false` would also pin the idle clock open on every TUI redraw.
  expect(adapter.transitionOnInput !== false).toBe(true)
})

console.log('\nDone\n')
