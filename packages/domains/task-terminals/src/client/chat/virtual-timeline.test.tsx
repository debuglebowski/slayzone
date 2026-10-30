// @vitest-environment jsdom
/**
 * The virtualized timeline (plan 4.1): only rows in view are mounted, the view
 * follows the bottom, a row far away can be revealed, and a tab hidden with
 * `display:none` keeps its rows and its place. jsdom has no layout, so
 * `__tests__/timeline-layout.ts` provides one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { TimelineItem } from '@slayzone/terminal/client'
import { installTimelineLayout, type TimelineLayout } from './__tests__/timeline-layout'
import { useFollowBottom, type FollowBottomApi } from './useFollowBottom'
import { useVirtualTimeline } from './useVirtualTimeline'
import { VirtualTimelineRows } from './VirtualTimelineRows'
import { TimelineScroller } from './__tests__/TimelineScroller'
import type { VirtualTimelineController } from './virtual-timeline'

type TextItem = Extract<TimelineItem, { kind: 'text' }>

function rows(n: number): TimelineItem[] {
  return Array.from(
    { length: n },
    (_, i): TextItem => ({
      kind: 'text',
      role: 'assistant',
      messageId: `m${i}`,
      text: `row ${i}`,
      timestamp: 0
    })
  )
}

const itemKey = (item: TimelineItem) => `k:${(item as TextItem).messageId}`

let api: { follow: FollowBottomApi; virtual: VirtualTimelineController } | null = null

function Harness({ items, hidden = false }: { items: TimelineItem[]; hidden?: boolean }) {
  const follow = useFollowBottom()
  const virtual = useVirtualTimeline(follow)
  api = { follow, virtual }
  return (
    <div style={hidden ? { display: 'none' } : undefined}>
      <TimelineScroller scrollRef={virtual.bindScroller} contentRef={follow.contentRef}>
        <VirtualTimelineRows
          controller={virtual}
          items={items}
          itemKey={itemKey}
          renderRow={(item) => <p>{(item as TextItem).text}</p>}
        />
      </TimelineScroller>
    </div>
  )
}

const mountedIndexes = (container: HTMLElement): number[] =>
  Array.from(container.querySelectorAll<HTMLElement>('[data-virtual-list] > [data-index]')).map(
    (el) => Number(el.dataset.index)
  )

async function settle(layout: TimelineLayout, frames = 4): Promise<void> {
  for (let i = 0; i < frames; i++) {
    await act(async () => {
      layout.flushResize()
      await new Promise((r) => requestAnimationFrame(() => r(null)))
    })
  }
}

describe('virtual timeline', () => {
  let layout: TimelineLayout
  beforeEach(() => {
    layout = installTimelineLayout({ viewport: 600, rowHeight: () => 50 })
    api = null
  })
  afterEach(() => {
    cleanup()
    layout.restore()
  })

  it('mounts only the rows in view of a 10,000-row timeline, opened at the bottom', async () => {
    const items = rows(10_000)
    const { container } = render(<Harness items={items} />)
    await settle(layout)
    const mounted = mountedIndexes(container)
    expect(mounted.length).toBeGreaterThan(0)
    expect(mounted.length).toBeLessThan(60)
    expect(mounted).toContain(9_999)
    const scroller = layout.scroller()!
    expect(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight).toBeLessThanOrEqual(
      1
    )
    expect(api!.follow.isAtBottom).toBe(true)
  })

  it('reveals a row far away by its key, and stops following the bottom', async () => {
    const items = rows(10_000)
    const { container } = render(<Harness items={items} />)
    await settle(layout)
    act(() => api!.virtual.revealKey('k:m1234'))
    await settle(layout, 6)
    expect(mountedIndexes(container)).toContain(1234)
    const row = container.querySelector<HTMLElement>('[data-item-key="k:m1234"]')!
    expect(row.getBoundingClientRect().top).toBeGreaterThanOrEqual(-1)
    expect(row.getBoundingClientRect().top).toBeLessThan(60)
    expect(api!.follow.isStuck()).toBe(false)
    // New rows arriving no longer pull the view down.
    const top = layout.scroller()!.scrollTop
    await settle(layout)
    expect(layout.scroller()!.scrollTop).toBe(top)
  })

  it('centres a revealed row when asked', async () => {
    const items = rows(2_000)
    const { container } = render(<Harness items={items} />)
    await settle(layout)
    act(() => api!.virtual.revealKey('k:m500', { align: 'center' }))
    await settle(layout, 6)
    const row = container.querySelector<HTMLElement>('[data-item-key="k:m500"]')!
    const mid = row.getBoundingClientRect().top + 25
    expect(Math.abs(mid - 300)).toBeLessThanOrEqual(2)
  })

  it('an unknown key is a no-op', async () => {
    render(<Harness items={rows(100)} />)
    await settle(layout)
    const top = layout.scroller()!.scrollTop
    act(() => api!.virtual.revealKey('k:nope'))
    await settle(layout)
    expect(layout.scroller()!.scrollTop).toBe(top)
    expect(api!.follow.isStuck()).toBe(true)
  })

  it('a hidden tab (display:none) keeps its rows mounted and its place when shown again', async () => {
    const items = rows(5_000)
    const { container, rerender } = render(<Harness items={items} />)
    await settle(layout)
    // The user scrolls up into the history.
    const scroller = layout.scroller()!
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }))
    layout.scrollTo(2000 * 50)
    await settle(layout)
    const before = mountedIndexes(container)
    const top = scroller.scrollTop
    expect(before[0]).toBeGreaterThan(1000)
    expect(before.at(-1)).toBeLessThan(4000)
    expect(api!.follow.isStuck()).toBe(false)

    const listHeight = () =>
      container.querySelector<HTMLElement>('[data-virtual-list]')!.style.height
    const heightBefore = listHeight()
    rerender(<Harness items={items} hidden />)
    await settle(layout)
    // Hidden: nothing re-renders away, and rows measured 0 tall don't shrink the list.
    expect(mountedIndexes(container)).toEqual(before)
    expect(listHeight()).toBe(heightBefore)
    // A browser can drop a hidden scroller's offset.
    layout.scroller()!.scrollTop = 0

    rerender(<Harness items={items} />)
    await settle(layout)
    expect(layout.scroller()!.scrollTop).toBe(top)
    expect(mountedIndexes(container)).toContain(before[10])
  })

  it('a row revealed near the end stays in view while it grows (not pulled back to the bottom)', async () => {
    // A revealed card that opens (E's files-changed reveal) grows downward.
    const tall = new Set<string>()
    layout.restore()
    layout = installTimelineLayout({
      viewport: 600,
      rowHeight: (row) => (tall.has(row.dataset.itemKey ?? '') ? 2_000 : 50)
    })
    const items = rows(1_000)
    const { container } = render(<Harness items={items} />)
    await settle(layout)
    // The user scrolled up; code reveals a row near the end — the view lands at
    // the bottom, where the follow lock would normally re-engage.
    layout.scroller()!.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }))
    layout.scrollTo(10_000)
    await settle(layout)
    act(() => api!.virtual.revealKey('k:m997'))
    await settle(layout)
    const row = () => container.querySelector<HTMLElement>('[data-item-key="k:m997"]')!
    expect(row().getBoundingClientRect().top).toBeLessThan(600)
    // It opens: 2,000px tall.
    tall.add('k:m997')
    await settle(layout, 8)
    expect(api!.follow.isStuck()).toBe(false)
    const top = row().getBoundingClientRect().top
    expect(top).toBeGreaterThanOrEqual(-1)
    expect(top).toBeLessThan(600)
    // The user scrolling to the end by hand follows the bottom again.
    layout.scroller()!.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }))
    layout.scrollTo(10_000_000)
    await settle(layout)
    expect(api!.follow.isStuck()).toBe(true)
  })

  it('a position set right after a reveal (an anchor restore) is kept when the reveal stops', async () => {
    const items = rows(5_000)
    const { container } = render(<Harness items={items} />)
    await settle(layout)
    act(() => api!.virtual.revealKey('k:m1000'))
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)))
    })
    // Before the scroll event: the restore puts the exact offset back (37px into the row).
    const scroller = layout.scroller()!
    const row = () => container.querySelector<HTMLElement>('[data-item-key="k:m1000"]')!
    scroller.scrollTop += row().getBoundingClientRect().top + 37
    act(() => api!.virtual.cancelReveal())
    await settle(layout)
    // Still 37px into that row (rows above it measured meanwhile: kept in place).
    expect(Math.round(row().getBoundingClientRect().top)).toBe(-37)
  })

  it('reports the row at the top of the view', async () => {
    render(<Harness items={rows(1_000)} />)
    await settle(layout)
    act(() => api!.virtual.revealKey('k:m400'))
    await settle(layout, 6)
    expect(api!.virtual.topIndex()).toBe(400)
  })

  it('reports where the view IS right after a reveal, before its scroll event (fast key repeat)', async () => {
    render(<Harness items={rows(1_000)} />)
    await settle(layout)
    act(() => {
      api!.virtual.revealKey('k:m400')
      expect(api!.virtual.topIndex()).toBe(400)
      api!.virtual.revealKey('k:m300')
      expect(api!.virtual.topIndex()).toBe(300)
    })
  })
})
