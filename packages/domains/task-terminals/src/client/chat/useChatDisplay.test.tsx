// @vitest-environment jsdom
import type React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { TimelineItem } from '@slayzone/terminal/client'

// renderers.tsx (isRenderable) pulls these in; irrelevant here and heavy to load.
vi.mock('@slayzone/diff-view', () => ({
  DiffView: () => null
}))
vi.mock('@slayzone/markdown/client', () => ({
  GhMarkdown: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}))

import { useChatDisplay } from './useChatDisplay'
import type { CallbackRef } from './useFollowBottom'

const text = (t: string, i: number): TimelineItem =>
  ({ kind: 'text', role: 'assistant', text: t, messageId: `m${i}` }) as unknown as TimelineItem

/** `count` items; only `needleAt` contains "needle". */
const timeline = (count: number, needleAt: number): TimelineItem[] =>
  Array.from({ length: count }, (_, i) => text(i === needleAt ? `needle ${i}` : `item ${i}`, i))

function makeScrollRef(): CallbackRef<HTMLElement> {
  const ref = ((el: HTMLElement | null) => {
    ref.current = el
  }) as CallbackRef<HTMLElement>
  ref.current = null
  return ref
}

type Display = ReturnType<typeof useChatDisplay>
let display: Display

/** Mirrors ChatTimeline: one `data-index` row per visible item inside the scroll viewport. */
function Harness({
  items,
  scrollRef
}: {
  items: TimelineItem[]
  scrollRef: CallbackRef<HTMLElement>
}) {
  const d = useChatDisplay({
    timeline: items,
    finalOnly: false,
    showLastMessageTools: false,
    scrollRef
  })
  display = d
  return (
    <div ref={scrollRef}>
      {d.visibleItems.map((item, i) => (
        <div key={d.itemKey(item, d.visibleStart + i)} data-index={d.visibleStart + i} />
      ))}
    </div>
  )
}

let scrolled: Array<string | null>
const originalScrollIntoView = Element.prototype.scrollIntoView

beforeEach(() => {
  scrolled = []
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this.getAttribute('data-index'))
  }
})

afterEach(() => {
  cleanup()
  Element.prototype.scrollIntoView = originalScrollIntoView
})

describe('useChatDisplay search scroll', () => {
  it('scrolls to a match inside the render window', () => {
    render(<Harness items={timeline(150, 120)} scrollRef={makeScrollRef()} />)
    expect(display.visibleStart).toBe(50)

    act(() => display.search.setQuery('needle'))
    expect(scrolled).toEqual(['120'])
  })

  it('scrolls to a match above the render window once the window has expanded to it', () => {
    render(<Harness items={timeline(150, 10)} scrollRef={makeScrollRef()} />)
    expect(display.visibleStart).toBe(50)

    act(() => display.search.setQuery('needle'))
    expect(display.visibleStart).toBe(10)
    expect(scrolled).toEqual(['10'])
  })

  it('does not re-scroll to the same match when the window later moves', () => {
    const scrollRef = makeScrollRef()
    const { rerender } = render(<Harness items={timeline(150, 120)} scrollRef={scrollRef} />)
    act(() => display.search.setQuery('needle'))
    expect(scrolled).toEqual(['120'])

    // A streamed item shifts the window start; the active match is unchanged.
    rerender(<Harness items={timeline(151, 120)} scrollRef={scrollRef} />)
    expect(display.visibleStart).toBe(51)
    expect(scrolled).toEqual(['120'])
  })
})

describe('useChatDisplay final-only view', () => {
  const hook = (effect: string, id: string): TimelineItem =>
    ({
      kind: 'hook',
      hookId: id,
      hookName: 'PreToolUse:Bash',
      hookEvent: 'PreToolUse',
      effect,
      audience: 'agent',
      text: 'x',
      timestamp: 0
    }) as unknown as TimelineItem

  it('keeps hooks that blocked or failed something and CLI notices; hides added context', () => {
    let shown: TimelineItem[] = []
    function Final({ items }: { items: TimelineItem[] }) {
      const d = useChatDisplay({
        timeline: items,
        finalOnly: true,
        showLastMessageTools: false,
        scrollRef: makeScrollRef()
      })
      shown = d.displayedTimeline
      return null
    }
    const user = { kind: 'user-text', text: 'go', timestamp: 0 } as unknown as TimelineItem
    const notice = {
      kind: 'notice',
      id: 'n1',
      level: 'notice',
      text: 'hi',
      timestamp: 0
    } as unknown as TimelineItem
    render(
      <Final
        items={[
          user,
          hook('context', 'h0'),
          hook('blocked', 'h1'),
          hook('failed', 'h2'),
          notice,
          text('done', 9)
        ]}
      />
    )
    expect(shown.map((i) => (i.kind === 'hook' ? `hook:${i.effect}` : i.kind))).toEqual([
      'user-text',
      'hook:blocked',
      'hook:failed',
      'notice',
      'text'
    ])
  })

  it('keys hook and notice rows by their ids', () => {
    render(<Harness items={[hook('blocked', 'h7')]} scrollRef={makeScrollRef()} />)
    expect(display.itemKey(hook('blocked', 'h7'), 0)).toBe('hook:h7')
  })
})
