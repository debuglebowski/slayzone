import { describe, expect, it } from 'vitest'
import { DebuggerHolders } from './debugger-holders'

describe('DebuggerHolders', () => {
  it('attaches on the first holder only', () => {
    const h = new DebuggerHolders()
    expect(h.acquire('lock', false)).toBe(true)
    expect(h.acquire('theme', true)).toBe(false)
    expect(h.size).toBe(2)
  })

  it('detaches only when the last holder leaves', () => {
    const h = new DebuggerHolders()
    h.acquire('lock', false)
    h.acquire('theme', true)
    expect(h.release('lock')).toBe(false)
    expect(h.release('theme')).toBe(true)
    expect(h.size).toBe(0)
  })

  // The bug this class exists to prevent: unlocking used to detach outright,
  // which drops a still-wanted Emulation.setEmulatedMedia override with it.
  it('keeps the session when the lock releases but a theme is still held', () => {
    const h = new DebuggerHolders()
    h.acquire('theme', false)
    h.acquire('lock', true)
    expect(h.release('lock')).toBe(false)
    expect(h.has('theme')).toBe(true)
  })

  it('never detaches a session it did not attach', () => {
    const h = new DebuggerHolders()
    expect(h.acquire('theme', true)).toBe(false)
    expect(h.release('theme')).toBe(false)
  })

  it('is idempotent for a repeated acquire', () => {
    const h = new DebuggerHolders()
    expect(h.acquire('theme', false)).toBe(true)
    expect(h.acquire('theme', false)).toBe(false)
    expect(h.size).toBe(1)
    expect(h.release('theme')).toBe(true)
  })

  it('ignores releasing a holder that never acquired', () => {
    const h = new DebuggerHolders()
    h.acquire('lock', false)
    expect(h.release('theme')).toBe(false)
    expect(h.size).toBe(1)
  })

  it('forgets everything on reset, and re-attaches on the next acquire', () => {
    const h = new DebuggerHolders()
    h.acquire('lock', false)
    h.acquire('theme', true)
    h.reset()
    expect(h.size).toBe(0)
    expect(h.release('lock')).toBe(false)
    expect(h.acquire('theme', false)).toBe(true)
  })

  it('does not detach after a reset stole ownership', () => {
    // DevTools displaced the session: reset() ran, then DevTools closed and we
    // re-acquired. Releasing must reflect the new ownership, not the old.
    const h = new DebuggerHolders()
    h.acquire('theme', false)
    h.reset()
    h.acquire('theme', true)
    expect(h.release('theme')).toBe(false)
  })
})
