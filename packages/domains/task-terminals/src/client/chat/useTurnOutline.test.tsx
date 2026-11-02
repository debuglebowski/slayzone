// @vitest-environment jsdom
/**
 * The user turns (plan 4.3) as Cmd+K "Go to turn…" and the previous / next keys
 * use them: picking a turn scrolls the virtualized timeline to it (mounted or
 * not) through the reveal seam. jsdom layout: `__tests__/timeline-layout.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { TimelineItem } from '@slayzone/terminal/client'
import { installTimelineLayout, type TimelineLayout } from './__tests__/timeline-layout'
import { turnOutlinePaletteCommands } from './turn-outline-palette'
import type { PaletteCommand } from '@slayzone/ui'
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
/** The chat's Cmd+K commands for the turns, as ChatPanel builds them. */
let commands: PaletteCommand[] = []

function Harness({ items }: { items: TimelineItem[] }) {
  const follow = useFollowBottom()
  const virtual = useVirtualTimeline(follow)
  const outline = useTurnOutline({ items, itemKey, virtual })
  jump = outline.jump
  commands = turnOutlinePaletteCommands({
    turns: outline.turns,
    reveal: virtual.revealKey,
    jump: outline.jump
  })
  return (
    <>
      <TimelineScroller scrollRef={virtual.bindScroller} contentRef={follow.contentRef}>
        <VirtualTimelineRows
          controller={virtual}
          items={items}
          itemKey={itemKey}
          renderRow={(item) => <p>{(item as { text?: string }).text ?? 'result'}</p>}
        />
      </TimelineScroller>
    </>
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
/** The "Go to turn…" page's entries. */
const goToTurn = (): PaletteCommand[] => {
  const page = commands.find((c) => c.id === 'chat-turn-goto')?.page
  return page?.kind === 'list' ? page.items : []
}

describe('useTurnOutline + Go to turn', () => {
  beforeEach(() => {
    layout = installTimelineLayout({ viewport: 600, rowHeight: () => 50 })
  })
  afterEach(() => {
    cleanup()
    layout.restore()
    jump = null
    commands = []
  })

  it('lists the turns; picking one far up scrolls it to the top of the view', async () => {
    render(<Harness items={session(400)} />)
    await settle()
    const entries = goToTurn()
    expect(entries).toHaveLength(400)
    expect(entries[3].label).toBe('4. question 3')

    expect(topOf('question 3')).toBeNull() // not mounted
    act(() => void entries[3].run?.())
    await settle()
    expect(topOf('question 3')).toBe(0)
  })

  it('previous / next turn from where the view is', async () => {
    render(<Harness items={session(50)} />)
    await settle()
    act(() => void goToTurn()[30].run?.())
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
    expect(commands).toEqual([])
  })
})
