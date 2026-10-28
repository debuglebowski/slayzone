// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { Project } from '@slayzone/projects-contracts'
import {
  clearLockOverrides,
  overrideDurationLock,
  overrideScheduleLock,
  useProjectLockState
} from './useProjectLockGuard'

const START = new Date('2026-10-26T12:00:30.000Z').getTime()

function project(
  id: string,
  lockedUntil: string | null,
  schedule: { from: string; to: string } | null = null
): Project {
  return {
    id,
    name: id,
    lock_config: { locked_until: lockedUntil, rate_limit: null, schedule }
  } as unknown as Project
}

describe('useProjectLockState', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(START)
  })
  afterEach(() => {
    for (const id of ['p1', 'p2', 'p3', 'p4']) clearLockOverrides(id)
    vi.useRealTimers()
  })

  it('unlocks on its own when a duration lock expires (same project object)', () => {
    const p = project('p1', new Date(START + 3_000).toISOString())
    const { result } = renderHook(() => useProjectLockState(p))
    expect(result.current.locked).toBe(true)
    act(() => vi.advanceTimersByTime(3_100))
    expect(result.current.locked).toBe(false)
  })

  it('unlocks immediately on an early-unlock override, re-locks when cleared', () => {
    const p = project('p2', new Date(START + 60 * 60_000).toISOString())
    const { result } = renderHook(() => useProjectLockState(p))
    expect(result.current).toEqual({ locked: true, overrideActive: false })
    act(() => overrideDurationLock('p2', p.lock_config?.locked_until))
    expect(result.current).toEqual({ locked: false, overrideActive: true })
    act(() => clearLockOverrides('p2'))
    expect(result.current).toEqual({ locked: true, overrideActive: false })
  })

  it('follows a schedule lock across its end minute', () => {
    // 12:00:30 local-independent: build the window from the fake clock's local time.
    const now = new Date(START)
    const hhmm = (d: Date) =>
      `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    const to = new Date(START + 60_000)
    const p = project('p3', null, { from: hhmm(new Date(START - 60 * 60_000)), to: hhmm(to) })
    const { result } = renderHook(() => useProjectLockState(p))
    expect(result.current.locked).toBe(true)
    expect(hhmm(now)).not.toBe(hhmm(to))
    act(() => vi.advanceTimersByTime(60_000))
    expect(result.current.locked).toBe(false)
    act(() => overrideScheduleLock('p3'))
    expect(result.current.overrideActive).toBe(false) // override only counts inside the window
  })

  it('does not spin on locks beyond the setTimeout range (~24.8 days)', () => {
    const p = project('p4', new Date(START + 40 * 24 * 60 * 60_000).toISOString())
    const { result } = renderHook(() => useProjectLockState(p))
    act(() => vi.advanceTimersByTime(60_000))
    expect(result.current.locked).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('null project is unlocked', () => {
    const { result } = renderHook(() => useProjectLockState(null))
    expect(result.current).toEqual({ locked: false, overrideActive: false })
  })
})
