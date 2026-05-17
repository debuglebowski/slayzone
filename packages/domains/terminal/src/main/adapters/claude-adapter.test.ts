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
  // The idle timer must actually fire on this full-screen TUI — otherwise
  // cursor blink keeps lastOutputTime fresh and state stays 'running'. Default
  // (undefined or true) gives that behavior; an explicit `false` would re-
  // introduce the historical stuck-running bug.
  expect(adapter.transitionOnInput !== false).toBe(true)
})

test('idleTimeoutMs is a tight 5s fallback (active completion-stamp signal is primary)', () => {
  // The active 'idle' signal handles the common case (completion stamp in
  // chunk → instant flip). This timer is a safety net for chunks where the
  // stamp is missing or scrolled off. 5s is small because Claude's animated
  // spinner emits bullet glyphs every ~100ms during real work — the timer
  // only elapses when output truly stops.
  expect(adapter.idleTimeoutMs).toBe(5000)
})

console.log('\nClaudeAdapter.detectActivity\n')

test('detectActivity is a no-op — hook events are the source of truth', () => {
  // Legacy bullet/spinner regex was retired in favor of Claude Code hooks
  // (see rest-api/agent-hook.ts + notify.sh). detectActivity must return
  // null for every input so the state machine is exclusively hook-driven.
  // Inputs below all matched the old regex and previously promoted state.
  expect(adapter.detectActivity('· Thinking...', 'unknown')).toBe(null)
  expect(adapter.detectActivity('✻ Clauding...', 'unknown')).toBe(null)
  expect(adapter.detectActivity('·\x1b[1CBefuddling…', 'unknown')).toBe(null)
  expect(adapter.detectActivity('✻ Cooked for 56s', 'unknown')).toBe(null)
  expect(adapter.detectActivity('· Cogitated for 4m 24s', 'unknown')).toBe(null)
  expect(adapter.detectActivity('Some random text', 'unknown')).toBe(null)
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
