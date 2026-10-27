/**
 * Tests for raiseFdLimitWith — pure decision logic around RLIMIT_NOFILE.
 */
import { describe, expect, test } from 'vitest'
import { raiseFdLimitWith, FD_LIMIT_TARGET_SOFT, type PosixModule } from './raise-fd-limit'

function mockPosix(
  initial: { soft: number | null; hard: number | null },
  opts: { setrlimitThrows?: boolean } = {}
): PosixModule & { lastSet?: { soft?: number | null; hard?: number | null } } {
  const state = { ...initial }
  const mod: PosixModule & { lastSet?: { soft?: number | null; hard?: number | null } } = {
    getrlimit: () => ({ soft: state.soft, hard: state.hard }),
    setrlimit: (_, limits) => {
      if (opts.setrlimitThrows) throw new Error('setrlimit: permission denied')
      mod.lastSet = limits
      if (typeof limits.soft === 'number') state.soft = limits.soft
      else if (limits.soft === null) state.soft = null
      if (typeof limits.hard === 'number') state.hard = limits.hard
      else if (limits.hard === null) state.hard = null
    }
  }
  return mod
}

describe('raiseFdLimitWith', () => {
  test('win32 — no-op, returns windows-unsupported', () => {
    const r = raiseFdLimitWith(() => {
      throw new Error('should not be called')
    }, 'win32')
    expect(r.ok).toBe(true)
    expect(r.raised).toBe(false)
    expect(r.reason).toBe('windows-unsupported')
  })

  test('posix load failure — returns load-failed', () => {
    const r = raiseFdLimitWith(() => {
      throw new Error('native bindings missing')
    }, 'darwin')
    expect(r.ok).toBe(false)
    expect(r.raised).toBe(false)
    expect(r.reason).toMatch(/^load-failed/)
  })

  test('soft already high (== target) — no raise, reason=already-high', () => {
    const posix = mockPosix({ soft: FD_LIMIT_TARGET_SOFT, hard: FD_LIMIT_TARGET_SOFT })
    const r = raiseFdLimitWith(() => posix, 'darwin')
    expect(r.ok).toBe(true)
    expect(r.raised).toBe(false)
    expect(r.reason).toBe('already-high')
    expect(posix.lastSet, 'setrlimit should not be called').toBeUndefined()
  })

  test('soft already above target — no raise, soft preserved', () => {
    const posix = mockPosix({ soft: 100000, hard: null })
    const r = raiseFdLimitWith(() => posix, 'darwin')
    expect(r.raised).toBe(false)
    expect(r.soft).toBe(100000)
    expect(r.hard).toBe('unlimited')
    expect(posix.lastSet).toBeUndefined()
  })

  test('soft=unlimited (null) — treated as infinity, no raise', () => {
    const posix = mockPosix({ soft: null, hard: null })
    const r = raiseFdLimitWith(() => posix, 'darwin')
    expect(r.raised).toBe(false)
    expect(r.soft).toBe('unlimited')
    expect(r.reason).toBe('already-high')
    expect(posix.lastSet).toBeUndefined()
  })

  test('soft=256 hard=unlimited (macOS default) — raises soft to target, hard preserved', () => {
    const posix = mockPosix({ soft: 256, hard: null })
    const r = raiseFdLimitWith(() => posix, 'darwin')
    expect(r.ok).toBe(true)
    expect(r.raised).toBe(true)
    expect(r.soft).toBe(FD_LIMIT_TARGET_SOFT)
    expect(r.hard).toBe('unlimited')
    expect(posix.lastSet?.soft).toBe(FD_LIMIT_TARGET_SOFT)
    expect(posix.lastSet?.hard, 'hard should be preserved (null = unlimited)').toBe(null)
  })

  test('soft=1024 hard=4096 — raises soft but may be clamped by hard', () => {
    // The mock does not enforce kernel clamping, so soft just takes the new
    // value. In production, the kernel would clamp to hard. This test just
    // confirms we do not attempt to change hard here.
    const posix = mockPosix({ soft: 1024, hard: 4096 })
    const r = raiseFdLimitWith(() => posix, 'darwin')
    expect(r.raised).toBe(true)
    expect(posix.lastSet?.hard, 'hard should be passed through unchanged').toBe(4096)
  })

  test('setrlimit throws (EPERM) — returns setrlimit-failed reason', () => {
    const posix = mockPosix({ soft: 256, hard: 256 }, { setrlimitThrows: true })
    const r = raiseFdLimitWith(() => posix, 'darwin')
    expect(r.ok).toBe(false)
    expect(r.raised).toBe(false)
    expect(r.reason).toMatch(/^setrlimit-failed/)
  })
})
