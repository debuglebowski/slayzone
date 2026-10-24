import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useStableCallback } from './use-stable-callback'

describe('useStableCallback', () => {
  it('keeps one identity across renders', () => {
    const { result, rerender } = renderHook(({ n }) => useStableCallback(() => n), {
      initialProps: { n: 1 }
    })
    const first = result.current
    rerender({ n: 2 })
    rerender({ n: 3 })
    expect(result.current).toBe(first)
  })

  it('runs the function from the latest committed render', () => {
    const { result, rerender } = renderHook(({ n }) => useStableCallback((x: number) => x + n), {
      initialProps: { n: 1 }
    })
    expect(result.current(10)).toBe(11)
    rerender({ n: 5 })
    expect(result.current(10)).toBe(15)
  })
})
