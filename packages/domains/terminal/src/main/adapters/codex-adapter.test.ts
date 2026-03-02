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

console.log('\nCodexAdapter.buildSpawnConfig\n')

const isWin = process.platform === 'win32'

test('starts fresh codex session by default', () => {
  const result = adapter.buildSpawnConfig('/tmp')
  expect(result.config.postSpawnCommand).toBe(isWin ? 'codex' : "exec 'codex'")
})

test('resumes codex session when existing conversation ID is provided', () => {
  const result = adapter.buildSpawnConfig('/tmp', '11111111-2222-4333-8444-555555555555', true)
  expect(result.config.postSpawnCommand).toBe(
    isWin
      ? 'codex resume 11111111-2222-4333-8444-555555555555'
      : "exec 'codex' 'resume' '11111111-2222-4333-8444-555555555555'"
  )
})

test('includes provider flags while resuming', () => {
  const result = adapter.buildSpawnConfig('/tmp', 'thread-123', true, undefined, ['--search'])
  expect(result.config.postSpawnCommand).toBe(
    isWin
      ? 'codex resume thread-123 --search'
      : "exec 'codex' 'resume' 'thread-123' '--search'"
  )
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

console.log('\nDone\n')
