/**
 * Tests for PTY exit strategy decision logic.
 * Run with: npx tsx packages/domains/terminal/src/main/pty-exit-strategy.test.ts
 */
import {
  shouldShellFallback,
  buildRecoveryMessage,
  decideRecoveryAdoption
} from './pty-exit-strategy.js'

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
      if (actual !== expected)
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    }
  }
}

function describe(name: string, fn: () => void) {
  console.log(`\n${name}`)
  fn()
}

const base = {
  exitCode: 1,
  terminalMode: 'codex',
  hasPostSpawnCommand: true,
  resuming: false,
  usedShellFallback: false,
  isStale: false
}

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

  test('false when stale resume — surface dead overlay, not a recovery shell (#90)', () => {
    // The real bug: stale `--resume` exits code 1 → without this guard the
    // shell fallback fired and buried "No conversation found" in a raw shell.
    expect(shouldShellFallback({ ...base, exitCode: 1, resuming: true, isStale: true })).toBe(false)
  })

  test('true for a genuine non-zero crash on resume (not stale)', () => {
    expect(shouldShellFallback({ ...base, exitCode: 1, resuming: true, isStale: false })).toBe(true)
  })
})

// --- decideRecoveryAdoption ---
//
// Guards the runner-routed recovery shell. The fallback used to be gated on
// `runnerId == null`, which silently disabled it once runners ran every pty (a
// crashed agent left a dead pane with no recovery shell). Enabling it remotely
// introduced a window the local path never had: the spawn is a network
// round-trip, so the session can be torn down while it is in flight. Only the
// happy path is reachable from e2e, hence these.

const adopt = { finalized: false, sessionReplaced: false, isShuttingDown: false }

describe('decideRecoveryAdoption', () => {
  test('adopts when the session is still live', () => {
    expect(decideRecoveryAdoption(adopt).action).toBe('adopt')
  })

  test('discards when the exit was already finalized — and does NOT re-finalize', () => {
    const v = decideRecoveryAdoption({ ...adopt, finalized: true })
    expect(v.action).toBe('discard')
    // A concurrent path already reported the exit; finalizing again would be
    // redundant (it is idempotent, but the verdict must say so explicitly).
    expect(v.action === 'discard' && v.finalize).toBe(false)
  })

  test('discards + finalizes when the session id was replaced (tab closed / reused)', () => {
    // Adopting here would attach a live pty to a session nothing owns, and the
    // original exit would never be reported — a permanently "running" tab.
    const v = decideRecoveryAdoption({ ...adopt, sessionReplaced: true })
    expect(v.action).toBe('discard')
    expect(v.action === 'discard' && v.finalize).toBe(true)
  })

  test('discards + finalizes during shutdown', () => {
    // The session map is still intact on quit, so the identity check alone would
    // wrongly adopt — spawning a shell into an app that is going away.
    const v = decideRecoveryAdoption({ ...adopt, isShuttingDown: true })
    expect(v.action).toBe('discard')
    expect(v.action === 'discard' && v.finalize).toBe(true)
  })

  test('finalized wins over a concurrent replacement (no double finalize)', () => {
    const v = decideRecoveryAdoption({
      finalized: true,
      sessionReplaced: true,
      isShuttingDown: true
    })
    expect(v.action).toBe('discard')
    expect(v.action === 'discard' && v.finalize).toBe(false)
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
