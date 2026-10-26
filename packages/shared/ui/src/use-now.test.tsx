// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useNow } from './use-now'

const START = 1_000_000

describe('useNow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(START)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts at the mount-time clock', () => {
    const { result } = renderHook(() => useNow())
    expect(result.current).toBe(START)
  })

  it('advances once per interval', () => {
    const { result } = renderHook(() => useNow(1_000))
    act(() => vi.advanceTimersByTime(1_000))
    expect(result.current).toBe(START + 1_000)
    act(() => vi.advanceTimersByTime(1_000))
    expect(result.current).toBe(START + 2_000)
  })

  it('stays put while disabled, catches up when re-enabled', () => {
    const { result, rerender } = renderHook(({ enabled }) => useNow(1_000, { enabled }), {
      initialProps: { enabled: false }
    })
    act(() => vi.advanceTimersByTime(5_000))
    expect(result.current).toBe(START)
    rerender({ enabled: true })
    expect(result.current).toBe(START + 5_000)
  })
})
