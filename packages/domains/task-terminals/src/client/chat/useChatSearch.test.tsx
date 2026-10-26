// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { TimelineItem } from '@slayzone/terminal/client'
import { useChatSearch } from './useChatSearch'

const text = (t: string, i: number): TimelineItem =>
  ({ kind: 'text', role: 'assistant', text: t, messageId: `m${i}` }) as unknown as TimelineItem

const timeline = (count: number): TimelineItem[] =>
  Array.from({ length: count }, (_, i) => text(`foo ${i}`, i))

function setup(initialCount: number) {
  const hook = renderHook(({ items }) => useChatSearch(items), {
    initialProps: { items: timeline(initialCount) }
  })
  act(() => hook.result.current.setQuery('foo'))
  return hook
}

describe('useChatSearch active match', () => {
  it('keeps the stored index in range when the match set shrinks', () => {
    const { result, rerender } = setup(5)
    act(() => {
      for (let i = 0; i < 4; i++) result.current.next()
    })
    expect(result.current.activeIdx).toBe(4)

    rerender({ items: timeline(3) })
    expect(result.current.activeIdx).toBe(2)
    expect(result.current.activeItemIdx).toBe(2)

    // From the clamped index (2): next wraps to 0. From an unclamped 4 it would be 2.
    act(() => result.current.next())
    expect(result.current.activeIdx).toBe(0)
  })

  it('resets the stored index when every match disappears', () => {
    const { result, rerender } = setup(5)
    act(() => {
      for (let i = 0; i < 3; i++) result.current.next()
    })
    expect(result.current.activeIdx).toBe(3)

    rerender({ items: [] })
    expect(result.current.matchCount).toBe(0)
    expect(result.current.activeIdx).toBe(-1)
    expect(result.current.activeItemIdx).toBe(-1)

    // Matches come back: the search restarts from the first one, not from 3.
    rerender({ items: timeline(5) })
    expect(result.current.activeIdx).toBe(0)
    expect(result.current.activeItemIdx).toBe(0)
  })

  it('leaves an in-range index alone', () => {
    const { result, rerender } = setup(5)
    act(() => result.current.next())
    rerender({ items: timeline(4) })
    expect(result.current.activeIdx).toBe(1)
  })
})
