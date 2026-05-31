import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDocumentVisibility, useVisibleInterval } from './use-document-visibility'

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('useDocumentVisibility', () => {
  beforeEach(() => {
    setVisibility('visible')
  })

  it('reads the initial visibilityState', () => {
    setVisibility('hidden')
    const { result } = renderHook(() => useDocumentVisibility())
    expect(result.current).toBe(false)
  })

  it('updates when visibility flips', () => {
    const { result } = renderHook(() => useDocumentVisibility())
    expect(result.current).toBe(true)
    act(() => setVisibility('hidden'))
    expect(result.current).toBe(false)
    act(() => setVisibility('visible'))
    expect(result.current).toBe(true)
  })

  it('shares a single listener across N consumers', () => {
    const spy = vi.spyOn(document, 'addEventListener')
    spy.mockClear()
    renderHook(() => useDocumentVisibility())
    renderHook(() => useDocumentVisibility())
    renderHook(() => useDocumentVisibility())
    // Listener is module-scoped + lazily installed once. Subsequent mounts
    // reuse it via useSyncExternalStore's shared subscribe Set.
    const visibilityRegistrations = spy.mock.calls.filter(
      ([type]) => type === 'visibilitychange'
    )
    expect(visibilityRegistrations.length).toBeLessThanOrEqual(1)
    spy.mockRestore()
  })
})

describe('useVisibleInterval', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setVisibility('visible')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires the callback on the ms cadence while visible', () => {
    const fn = vi.fn()
    renderHook(() => useVisibleInterval(fn, 1000))
    expect(fn).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(2500)
    })
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('pauses while hidden and resumes when visible again', () => {
    const fn = vi.fn()
    renderHook(() => useVisibleInterval(fn, 1000))
    act(() => {
      vi.advanceTimersByTime(1500)
    })
    expect(fn).toHaveBeenCalledTimes(1)

    act(() => setVisibility('hidden'))
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    // Hidden — no further fires.
    expect(fn).toHaveBeenCalledTimes(1)

    act(() => setVisibility('visible'))
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('does not arm the interval when enabled=false', () => {
    const fn = vi.fn()
    renderHook(() => useVisibleInterval(fn, 500, { enabled: false }))
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(fn).not.toHaveBeenCalled()
  })

  it('arms the interval when enabled flips true', () => {
    const fn = vi.fn()
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useVisibleInterval(fn, 1000, { enabled }),
      { initialProps: { enabled: false } }
    )
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(fn).not.toHaveBeenCalled()
    rerender({ enabled: true })
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('runOnVisible fires the callback immediately on visible transition', () => {
    const fn = vi.fn()
    setVisibility('hidden')
    renderHook(() => useVisibleInterval(fn, 1000, { runOnVisible: true }))
    expect(fn).not.toHaveBeenCalled()
    act(() => setVisibility('visible'))
    // Immediate fire on becoming visible (no need to wait a full ms).
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('runOnVisible omitted — does not fire on resume', () => {
    const fn = vi.fn()
    setVisibility('hidden')
    renderHook(() => useVisibleInterval(fn, 1000))
    act(() => setVisibility('visible'))
    expect(fn).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('always picks up the latest callback closure (ref-based)', () => {
    const calls: number[] = []
    let value = 1
    const { rerender } = renderHook(() => {
      const v = value
      useVisibleInterval(() => calls.push(v), 1000)
    })
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(calls).toEqual([1])
    value = 2
    rerender()
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    // Latest closure (value=2) used on the next tick without restarting timer.
    expect(calls).toEqual([1, 2])
  })

  it('clears the interval on unmount', () => {
    const fn = vi.fn()
    const { unmount } = renderHook(() => useVisibleInterval(fn, 1000))
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(fn).toHaveBeenCalledTimes(1)
    unmount()
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
