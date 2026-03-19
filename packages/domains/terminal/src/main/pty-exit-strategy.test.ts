/**
 * Tests for PTY exit strategy decision logic.
 * Run with: npx tsx packages/domains/terminal/src/main/pty-exit-strategy.test.ts
 */
import { shouldShellFallback, shouldNotifySessionNotFound, buildRecoveryMessage } from './pty-exit-strategy.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}`)
    console.error(`    ${e}`)
    failed++
  }
}

function expect(actual: unknown) {
  return {
    toBe(expected: unknown) {
      if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    }
  }
}

function describe(name: string, fn: () => void) {
  console.log(`\n${name}`)
  fn()
}

const base = { exitCode: 1, terminalMode: 'codex', hasPostSpawnCommand: true, resuming: false, usedShellFallback: false }

// --- shouldShellFallback ---

describe('shouldShellFallback', () => {
  test('true when AI provider exits non-zero', () => {
    expect(shouldShellFallback(base)).toBe(true)
  })

  test('false when exit code is 0', () => {
    expect(shouldShellFallback({ ...base, exitCode: 0 })).toBe(false)
  })

  test('false when no postSpawnCommand (plain terminal)', () => {
    expect(shouldShellFallback({ ...base, hasPostSpawnCommand: false })).toBe(false)
  })

  test('false when shell fallback already used', () => {
    expect(shouldShellFallback({ ...base, usedShellFallback: true })).toBe(false)
  })

  test('true for claude-code mode', () => {
    expect(shouldShellFallback({ ...base, terminalMode: 'claude-code' })).toBe(true)
  })

  test('true for any exit code > 0', () => {
    expect(shouldShellFallback({ ...base, exitCode: 127 })).toBe(true)
  })

  test('true for negative exit code (signal)', () => {
    expect(shouldShellFallback({ ...base, exitCode: -1 })).toBe(true)
  })

  test('no double fallback — false after first fallback used', () => {
    // Simulates: CLI crashes → shell fallback → fallback shell also exits non-zero
    expect(shouldShellFallback({ ...base, exitCode: 1, usedShellFallback: true })).toBe(false)
  })
})

// --- shouldNotifySessionNotFound ---

describe('shouldNotifySessionNotFound', () => {
  test('true when resuming and exit non-zero', () => {
    expect(shouldNotifySessionNotFound({ ...base, resuming: true })).toBe(true)
  })

  test('false when not resuming', () => {
    expect(shouldNotifySessionNotFound({ ...base, resuming: false })).toBe(false)
  })

  test('false when resuming but exit code 0', () => {
    expect(shouldNotifySessionNotFound({ ...base, resuming: true, exitCode: 0 })).toBe(false)
  })
})

// --- buildRecoveryMessage ---

describe('buildRecoveryMessage', () => {
  test('includes mode and exit code', () => {
    const msg = buildRecoveryMessage('codex', 1)
    expect(msg.includes('codex')).toBe(true)
    expect(msg.includes('1')).toBe(true)
    expect(msg.includes('[SlayZone]')).toBe(true)
  })

  test('uses \\r\\n line endings for terminal', () => {
    const msg = buildRecoveryMessage('codex', 1)
    expect(msg.startsWith('\r\n')).toBe(true)
    expect(msg.endsWith('\r\n')).toBe(true)
  })
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
