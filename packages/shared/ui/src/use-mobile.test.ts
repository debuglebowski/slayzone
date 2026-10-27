import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useIsMobile } from './use-mobile'

const QUERY = '(max-width: 767px)'
const listeners = new Set<() => void>()
const queries: string[] = []

function setWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
}

beforeEach(() => {
  listeners.clear()
  queries.length = 0
  window.matchMedia = vi.fn((query: string) => {
    queries.push(query)
    return {
      matches: window.innerWidth < 768,
      media: query,
      addEventListener: (_type: string, cb: () => void) => listeners.add(cb),
      removeEventListener: (_type: string, cb: () => void) => listeners.delete(cb)
    } as unknown as MediaQueryList
  })
})

afterEach(() => {
  setWidth(1024)
})

function crossBreakpoint(width: number): void {
  setWidth(width)
  for (const cb of [...listeners]) cb()
}

describe('useIsMobile', () => {
  it('is false at desktop width', () => {
    setWidth(1024)
    const { result } = renderHook(() => useIsMobile())
    expect(result.current).toBe(false)
  })

  it('is true below the 768px breakpoint once mounted', () => {
    setWidth(500)
    const { result } = renderHook(() => useIsMobile())
    expect(result.current).toBe(true)
  })

  it('treats exactly 768px as desktop and 767px as mobile', () => {
    setWidth(768)
    expect(renderHook(() => useIsMobile()).result.current).toBe(false)
    setWidth(767)
    expect(renderHook(() => useIsMobile()).result.current).toBe(true)
  })

  it('follows the media query across the breakpoint', () => {
    setWidth(1024)
    const { result } = renderHook(() => useIsMobile())
    act(() => crossBreakpoint(600))
    expect(result.current).toBe(true)
    act(() => crossBreakpoint(900))
    expect(result.current).toBe(false)
  })

  // Flagged change (lint pass 2): the effect version rendered `false` first and
  // corrected it after mount; reading the width while rendering drops that frame.
  it('renders the real value from the first render on', () => {
    setWidth(500)
    const seen: boolean[] = []
    renderHook(() => {
      const isMobile = useIsMobile()
      seen.push(isMobile)
      return isMobile
    })
    expect(seen).toEqual([true])
  })

  it('listens to the max-width query and stops on unmount', () => {
    setWidth(1024)
    const { unmount } = renderHook(() => useIsMobile())
    expect(queries).toContain(QUERY)
    expect(listeners.size).toBe(1)
    unmount()
    expect(listeners.size).toBe(0)
  })
})
