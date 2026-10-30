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
import { useFollowBottom, type CallbackRef } from './useFollowBottom'
import { VirtualTimelineRows } from './VirtualTimelineRows'
import { TimelineScroller } from './__tests__/TimelineScroller'
import { installTimelineLayout, type TimelineLayout } from './__tests__/timeline-layout'

const text = (t: string, i: number): TimelineItem =>
  ({ kind: 'text', role: 'assistant', text: t, messageId: `m${i}` }) as unknown as TimelineItem

/** `count` items; only those at `needlesAt` contain "needle". */
const timeline = (count: number, ...needlesAt: number[]): TimelineItem[] =>
  Array.from({ length: count }, (_, i) =>
    text(needlesAt.includes(i) ? `needle ${i}` : `item ${i}`, i)
  )

function makeScrollRef(): CallbackRef<HTMLElement> {
  const ref = ((el: HTMLElement | null) => {
    ref.current = el
  }) as CallbackRef<HTMLElement>
  ref.current = null
  return ref
}

/** A follow lock for hooks rendered without a timeline. */
const detachedFollow = () => ({
  scrollRef: makeScrollRef(),
  isStuck: () => true,
  unstick: () => {},
  restoreAnchor: () => false
})

type Display = ReturnType<typeof useChatDisplay>
let display: Display

/** Mirrors ChatPanel + ChatTimeline: the follow lock, the display, the virtual rows. */
function Harness({ items }: { items: TimelineItem[] }) {
  const follow = useFollowBottom()
  const d = useChatDisplay({
    timeline: items,
    finalOnly: false,
    showLastMessageTools: false,
    follow
  })
  display = d
  return (
    <TimelineScroller scrollRef={d.virtual.bindScroller} contentRef={follow.contentRef}>
      <VirtualTimelineRows
        controller={d.virtual}
        items={d.displayedTimeline}
        itemKey={d.itemKey}
        renderRow={(item) => <p>{(item as { text: string }).text}</p>}
      />
    </TimelineScroller>
  )
}

let layout: TimelineLayout

beforeEach(() => {
  layout = installTimelineLayout({ viewport: 600, rowHeight: () => 50 })
})

afterEach(() => {
  cleanup()
  layout.restore()
})

async function settle(frames = 6): Promise<void> {
  for (let i = 0; i < frames; i++) {
    await act(async () => {
      layout.flushResize()
      await new Promise((r) => requestAnimationFrame(() => r(null)))
    })
  }
}

const rowTop = (index: number): number | null => {
  const row = document.querySelector<HTMLElement>(`[data-virtual-list] > [data-index="${index}"]`)
  return row ? row.getBoundingClientRect().top : null
}

describe('useChatDisplay search over the virtualized timeline', () => {
  it('counts a match in a row far above the view (not mounted) and reveals it, centred', async () => {
    render(<Harness items={timeline(10_000, 10)} />)
    await settle()
    expect(rowTop(10)).toBeNull()

    act(() => display.search.setQuery('needle'))
    expect(display.search.matchCount).toBe(1)
    await settle()
    const top = rowTop(10)
    expect(top).not.toBeNull()
    expect(Math.abs(top! + 25 - 300)).toBeLessThanOrEqual(2)
  })

  it('next / prev reveal each match in turn, wherever it is', async () => {
    render(<Harness items={timeline(5_000, 100, 4_000)} />)
    await settle()
    act(() => display.search.setQuery('needle'))
    expect(display.search.matchCount).toBe(2)
    await settle()
    expect(rowTop(100)).not.toBeNull()
    act(() => display.search.next())
    await settle()
    expect(rowTop(4_000)).not.toBeNull()
    expect(rowTop(100)).toBeNull()
    act(() => display.search.prev())
    await settle()
    expect(rowTop(100)).not.toBeNull()
  })

  it('does not re-reveal the same match when rows are appended', async () => {
    const { rerender } = render(<Harness items={timeline(3_000, 1_000)} />)
    await settle()
    act(() => display.search.setQuery('needle'))
    await settle()
    // The user scrolls on; a streamed row arrives; the active match is unchanged.
    layout.scroller()!.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }))
    layout.scrollTo(20_000)
    await settle()
    const top = layout.scroller()!.scrollTop
    rerender(<Harness items={timeline(3_001, 1_000)} />)
    await settle()
    expect(layout.scroller()!.scrollTop).toBe(top)
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
        follow: detachedFollow()
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

  it('keys a sub-agent row by its Task call, not its position (reveal + anchors)', async () => {
    const { stableAnchorKey } = await import('./useChatDisplay')
    const agent = {
      kind: 'sub-agent',
      toolUseId: 'toolu_task1',
      phase: 'completed',
      timestamp: 0
    } as unknown as TimelineItem
    render(<Harness items={[agent]} />)
    expect(display.itemKey(agent, 0)).toBe('sub-agent:toolu_task1')
    expect(display.itemKey(agent, 7)).toBe('sub-agent:toolu_task1')
    expect(stableAnchorKey(agent)).toBe('sub-agent:toolu_task1')
  })

  it('keys hook and notice rows by their ids', () => {
    render(<Harness items={[hook('blocked', 'h7')]} />)
    expect(display.itemKey(hook('blocked', 'h7'), 0)).toBe('hook:h7')
  })
})

describe('useChatDisplay — a hook block folded into its card', () => {
  const tool = {
    kind: 'tool',
    invocation: {
      id: 't1',
      name: 'Bash',
      input: {},
      status: 'denied',
      blockedBy: { hookId: 'h1', hookName: 'PreToolUse:Bash', text: 'no', audience: 'agent' }
    },
    timestamp: 0
  } as unknown as TimelineItem
  const folded = {
    kind: 'hook',
    hookId: 'h1',
    hookName: 'PreToolUse:Bash',
    hookEvent: 'PreToolUse',
    effect: 'blocked',
    audience: 'agent',
    text: 'no',
    timestamp: 0,
    foldedInto: 't1'
  } as unknown as TimelineItem
  const other = { ...folded, hookId: 'h2', effect: 'failed', foldedInto: undefined } as TimelineItem
  const shown = (finalOnly: boolean, items: TimelineItem[]) => {
    let out: TimelineItem[] = []
    function Probe() {
      out = useChatDisplay({
        timeline: items,
        finalOnly,
        showLastMessageTools: false,
        follow: detachedFollow()
      }).displayedTimeline
      return null
    }
    render(<Probe />)
    cleanup()
    return out.map((i) => (i.kind === 'hook' ? `hook:${i.hookId}` : i.kind))
  }

  it('the card shows the block: its hook row is not shown on its own; other hooks are', () => {
    expect(shown(false, [tool, folded, other])).toEqual(['tool', 'hook:h2'])
  })

  it('where the card is not shown (final-only view), the hook row still explains the block', () => {
    expect(shown(true, [tool, folded, other])).toEqual(['hook:h1', 'hook:h2'])
  })
})

describe('useChatDisplay scroll anchors', () => {
  it('stable anchor keys: rows the same after a reload; none for rows keyed by position', async () => {
    const { stableAnchorKey } = await import('./useChatDisplay')
    expect(
      stableAnchorKey({ kind: 'user-text', id: 'm1', text: 'x', timestamp: 1 } as TimelineItem)
    ).toBe('user:m1')
    expect(stableAnchorKey(text('a', 7))).toBe('text:m7')
    // A streamed block: its own key (two text blocks of one message never share one).
    expect(stableAnchorKey({ ...text('a', 7), blockOrdinal: 1 } as TimelineItem)).toBe('text:m7:1')
    expect(
      stableAnchorKey({ kind: 'user-text', text: 'x', timestamp: 1 } as TimelineItem)
    ).toBeNull()
    expect(stableAnchorKey({ kind: 'result', timestamp: 1 } as unknown as TimelineItem)).toBeNull()
  })

  it("revealAnchor scrolls a saved anchor's row into view, mounted or not", async () => {
    render(<Harness items={timeline(5_000)} />)
    await settle()
    expect(rowTop(20)).toBeNull()
    act(() => display.revealAnchor('text:m20'))
    await settle()
    expect(rowTop(20)).toBe(0)
    // A key not in the timeline changes nothing.
    const top = layout.scroller()!.scrollTop
    act(() => display.revealAnchor('text:nope'))
    await settle()
    expect(layout.scroller()!.scrollTop).toBe(top)
  })
})
