// @vitest-environment jsdom
/**
 * The turn outline (plan 4.3): one entry per user turn; picking one scrolls the
 * virtualized timeline to it (mounted or not) through the reveal seam, and the
 * turn in view is marked. jsdom layout: `__tests__/timeline-layout.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { TimelineItem } from '@slayzone/terminal/client'
import { installTimelineLayout, type TimelineLayout } from './__tests__/timeline-layout'
import { ChatTurnOutline } from './ChatTurnOutline'
import { TimelineRevealContext } from './timeline-reveal'
import { useFollowBottom } from './useFollowBottom'
import { useTurnOutline } from './useTurnOutline'
import { useVirtualTimeline } from './useVirtualTimeline'
import { VirtualTimelineRows } from './VirtualTimelineRows'
import { TimelineScroller } from './__tests__/TimelineScroller'

/** `turns` turns of a prompt and four reply rows each. */
function session(turns: number): TimelineItem[] {
  const out: TimelineItem[] = []
  for (let t = 0; t < turns; t++) {
    out.push({
      kind: 'user-text',
      id: `u${t}`,
      text: `question ${t}`,
      timestamp: 0
    } as TimelineItem)
    for (let r = 0; r < 4; r++) {
      out.push({
        kind: 'text',
        role: 'assistant',
        messageId: `m${t}_${r}`,
        text: `answer ${t}.${r}`,
        timestamp: 0
      } as TimelineItem)
    }
    out.push({ kind: 'result', isError: false, timestamp: 0 } as unknown as TimelineItem)
  }
  return out
}

const itemKey = (item: TimelineItem, index: number) =>
  item.kind === 'user-text' ? `user-text:${item.id}` : `${item.kind}:${index}`

let jump: ((dir: -1 | 1) => void) | null = null

function Harness({ items }: { items: TimelineItem[] }) {
  const follow = useFollowBottom()
  const virtual = useVirtualTimeline(follow)
  const outline = useTurnOutline({ items, itemKey, virtual, turnOpen: false })
  jump = outline.jump
  return (
    <TimelineRevealContext.Provider value={virtual.revealKey}>
      <ChatTurnOutline turns={outline.turns} virtual={virtual} />
      <TimelineScroller scrollRef={virtual.bindScroller} contentRef={follow.contentRef}>
        <VirtualTimelineRows
          controller={virtual}
          items={items}
          itemKey={itemKey}
          renderRow={(item) => <p>{(item as { text?: string }).text ?? 'result'}</p>}
        />
      </TimelineScroller>
    </TimelineRevealContext.Provider>
  )
}

let layout: TimelineLayout
async function settle(frames = 6): Promise<void> {
  for (let i = 0; i < frames; i++) {
    await act(async () => {
      layout.flushResize()
      await new Promise((r) => requestAnimationFrame(() => r(null)))
    })
  }
}
/** Where the timeline row showing `text` is, relative to the view's top (null: not mounted). */
const topOf = (text: string): number | null => {
  const rows = document.querySelectorAll<HTMLElement>('[data-virtual-list] > [data-index]')
  const row = Array.from(rows).find((r) => r.textContent === text)
  return row ? Math.round(row.getBoundingClientRect().top) : null
}
const current = () =>
  screen
    .getAllByTestId('chat-turn-outline-item')
    .findIndex((el) => el.getAttribute('data-current') === 'true')

describe('ChatTurnOutline', () => {
  beforeEach(() => {
    layout = installTimelineLayout({ viewport: 600, rowHeight: () => 50 })
  })
  afterEach(() => {
    cleanup()
    layout.restore()
    jump = null
  })

  it('lists the turns; picking one far up scrolls it to the top of the view and marks it', async () => {
    render(<Harness items={session(400)} />)
    await settle()
    expect(screen.queryByTestId('chat-turn-outline')).toBeNull()
    fireEvent.click(screen.getByTestId('chat-turn-outline-toggle'))
    const entries = screen.getAllByTestId('chat-turn-outline-item')
    expect(entries).toHaveLength(400)
    expect(entries[3].textContent).toContain('question 3')
    // At the bottom: the turn of the row at the top of the view (the last turn is short).
    expect(current()).toBe(398)

    expect(topOf('question 3')).toBeNull() // not mounted
    fireEvent.click(entries[3])
    await settle()
    expect(topOf('question 3')).toBe(0)
    expect(current()).toBe(3)
  })

  it('previous / next turn from where the view is', async () => {
    render(<Harness items={session(50)} />)
    await settle()
    fireEvent.click(screen.getByTestId('chat-turn-outline-toggle'))
    fireEvent.click(screen.getAllByTestId('chat-turn-outline-item')[30])
    await settle()
    expect(topOf('question 30')).toBe(0)
    act(() => jump!(-1))
    await settle()
    expect(topOf('question 29')).toBe(0)
    act(() => jump!(1))
    await settle()
    expect(topOf('question 30')).toBe(0)
    act(() => jump!(1))
    await settle()
    expect(topOf('question 31')).toBe(0)
    // Scrolled into turn 31: previous goes to its own start first.
    layout.scroller()!.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }))
    layout.scrollTo(layout.scroller()!.scrollTop + 120)
    await settle()
    act(() => jump!(-1))
    await settle()
    expect(topOf('question 31')).toBe(0)
  })

  it('shows nothing without a user turn', async () => {
    render(<Harness items={[]} />)
    await settle()
    expect(screen.queryByTestId('chat-turn-outline-toggle')).toBeNull()
  })
})
