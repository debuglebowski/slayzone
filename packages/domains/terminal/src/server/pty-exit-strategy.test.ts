/**
 * Tests for PTY exit strategy decision logic.
 */
import { describe, expect, test } from 'vitest'
import {
  shouldShellFallback,
  buildRecoveryMessage,
  decideRecoveryAdoption,
  shouldArmHubStartupDeadline,
  decideUnexpectedExit,
  buildAutoResumeMessage,
  AUTO_RESUME_MIN_UPTIME_MS,
  AUTO_RESUME_WINDOW_MS,
  USER_INTERRUPT_GRACE_MS,
  type UnexpectedExitContext
} from './pty-exit-strategy.js'

const base = {
  exitCode: 1,
  agentId: 'codex',
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
    expect(shouldShellFallback({ ...base, agentId: 'claude-code' })).toBe(true)
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
// Guards the computer-routed recovery shell. The fallback used to be gated on
// `computerId == null`, which silently disabled it once computers ran every pty (a
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

// --- shouldArmHubStartupDeadline ---
//
// The startup deadline belongs to whoever owns the process. The hub runs its own
// only when nothing closer does: a remote hub judging silence across a socket
// cannot tell "printed nothing" from "printed, not yet read by me", and after a
// hub stall it killed healthy agents whose output was already waiting.

describe('shouldArmHubStartupDeadline', () => {
  test('in-process spawn (no confirmation round-trip): the hub is the owner, so it arms', () => {
    expect(shouldArmHubStartupDeadline('synchronous')).toBe(true)
  })

  test('the owner confirmed it armed the deadline itself: the hub must not arm a second one', () => {
    expect(shouldArmHubStartupDeadline({ ownsStartupDeadline: true })).toBe(false)
  })

  test('the owner confirmed WITHOUT owning one (older computer): the hub keeps its own', () => {
    expect(shouldArmHubStartupDeadline({ ownsStartupDeadline: false })).toBe(true)
  })

  test('a confirmation that says nothing about the deadline is treated as not owned', () => {
    expect(shouldArmHubStartupDeadline({})).toBe(true)
  })
})

// --- decideUnexpectedExit (auto-resume of an agent that died mid-session) ---

describe('decideUnexpectedExit', () => {
  const NOW = 1_000_000
  // An agent that printed 10 min ago and was killed behind SlayZone's back (the
  // 2026-11-14 stray sweep: SIGHUP → claude exits 129).
  const died: UnexpectedExitContext = {
    exitCode: 129,
    hasPostSpawnCommand: true,
    usedShellFallback: false,
    isStale: false,
    hasResumeCommand: true,
    resumeEligibleMode: true,
    conversationId: 'conv-1',
    killRequested: false,
    shuttingDown: false,
    hibernating: false,
    firstOutputAt: NOW - 600_000,
    lastInterruptInputAt: null,
    lastAutoResumeAt: null,
    now: NOW
  }
  const skip = (why: string) => ({ action: 'none', why })

  test('unexpected death past startup → resume', () => {
    expect(decideUnexpectedExit(died)).toEqual({ action: 'resume' })
  })
  test('signal death with exit code 0 → resume', () => {
    expect(decideUnexpectedExit({ ...died, exitCode: 0, signal: 9 })).toEqual({ action: 'resume' })
  })
  test('clean exit (0, no signal) → nothing to recover', () => {
    expect(decideUnexpectedExit({ ...died, exitCode: 0 })).toEqual(skip('clean-exit'))
    expect(decideUnexpectedExit({ ...died, exitCode: 0, signal: 0 })).toEqual(skip('clean-exit'))
  })
  test('death SlayZone asked for (close, restart, hibernate, task done, quit) → no resume', () => {
    expect(decideUnexpectedExit({ ...died, killRequested: true })).toEqual(skip('requested'))
    expect(decideUnexpectedExit({ ...died, shuttingDown: true })).toEqual(skip('requested'))
    expect(decideUnexpectedExit({ ...died, hibernating: true })).toEqual(skip('requested'))
  })
  test('exit carrying a transport reason keeps its overlay', () => {
    for (const reason of [
      'exited-while-detached',
      'reattach-timeout',
      'computer-restarted',
      'startup-timeout'
    ])
      expect(decideUnexpectedExit({ ...died, reason })).toEqual(skip('transport'))
  })
  test('user interrupt: exit 130, or ^C/^D shortly before → no resume', () => {
    expect(decideUnexpectedExit({ ...died, exitCode: 130 })).toEqual(skip('user-interrupt'))
    expect(
      decideUnexpectedExit({ ...died, lastInterruptInputAt: NOW - USER_INTERRUPT_GRACE_MS + 1 })
    ).toEqual(skip('user-interrupt'))
    // An old ^C does not explain a death now.
    expect(
      decideUnexpectedExit({ ...died, lastInterruptInputAt: NOW - USER_INTERRUPT_GRACE_MS - 1 })
    ).toEqual({ action: 'resume' })
  })
  test('start failures keep the shell fallback: no output, or died soon after it', () => {
    expect(decideUnexpectedExit({ ...died, firstOutputAt: null })).toEqual(skip('startup'))
    expect(
      decideUnexpectedExit({ ...died, firstOutputAt: NOW - AUTO_RESUME_MIN_UPTIME_MS + 1 })
    ).toEqual(skip('startup'))
    expect(
      decideUnexpectedExit({ ...died, firstOutputAt: NOW - AUTO_RESUME_MIN_UPTIME_MS })
    ).toEqual({ action: 'resume' })
  })
  test('stale / in-use resume keeps its overlay', () => {
    expect(decideUnexpectedExit({ ...died, isStale: true })).toEqual(skip('stale'))
  })
  test('not an agent, or already the recovery shell → today', () => {
    expect(decideUnexpectedExit({ ...died, hasPostSpawnCommand: false })).toEqual(skip('not-agent'))
    expect(decideUnexpectedExit({ ...died, usedShellFallback: true })).toEqual(
      skip('recovery-shell')
    )
  })
  test('provider cannot resume → today', () => {
    expect(decideUnexpectedExit({ ...died, hasResumeCommand: false })).toEqual(skip('no-resume'))
    expect(decideUnexpectedExit({ ...died, resumeEligibleMode: false })).toEqual(skip('no-resume'))
    expect(decideUnexpectedExit({ ...died, conversationId: null })).toEqual(skip('no-conversation'))
  })
  test('at most one auto-resume per window, then the shell', () => {
    expect(
      decideUnexpectedExit({ ...died, lastAutoResumeAt: NOW - AUTO_RESUME_WINDOW_MS + 1 })
    ).toEqual({ action: 'rate-limited' })
    expect(
      decideUnexpectedExit({ ...died, lastAutoResumeAt: NOW - AUTO_RESUME_WINDOW_MS })
    ).toEqual({ action: 'resume' })
  })
  test('rate limit only applies to deaths that would resume', () => {
    expect(decideUnexpectedExit({ ...died, killRequested: true, lastAutoResumeAt: NOW })).toEqual(
      skip('requested')
    )
  })
})

describe('buildAutoResumeMessage', () => {
  test('names the agent, the code and what happened', () => {
    const m = buildAutoResumeMessage('claude-code', 129)
    expect(m).toContain('[SlayZone] claude-code exited unexpectedly (code 129)')
    expect(m).toContain('resuming conversation')
    expect(m.startsWith('\r\n')).toBe(true)
    expect(m.endsWith('\r\n')).toBe(true)
  })
  test('names the signal when there is one', () => {
    expect(buildAutoResumeMessage('codex', 0, 1)).toContain('(signal 1)')
  })
})
