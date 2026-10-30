// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import {
  TimelineRevealContext,
  useRevealTimelineItem,
  type RevealTimelineItem
} from './timeline-reveal'

function Probe({ onReady }: { onReady: (reveal: RevealTimelineItem) => void }) {
  onReady(useRevealTimelineItem())
  return null
}

describe('timeline reveal seam', () => {
  afterEach(cleanup)

  it('uses the timeline that provides it', () => {
    const provided = vi.fn<RevealTimelineItem>()
    let reveal: RevealTimelineItem | null = null
    render(
      <TimelineRevealContext.Provider value={provided}>
        <Probe onReady={(r) => (reveal = r)} />
      </TimelineRevealContext.Provider>
    )
    reveal!('user-text:u1', { align: 'center' })
    expect(provided).toHaveBeenCalledWith('user-text:u1', { align: 'center' })
  })

  it('without a provider, scrolls the rendered row with that key into view', () => {
    const { container } = render(
      <div>
        <div data-item-key="tool:a">a</div>
        <div data-item-key="tool:b">b</div>
      </div>
    )
    const row = container.querySelector<HTMLElement>('[data-item-key="tool:b"]')!
    const scrollIntoView = vi.fn()
    row.scrollIntoView = scrollIntoView
    let reveal: RevealTimelineItem | null = null
    render(<Probe onReady={(r) => (reveal = r)} />)
    reveal!('tool:b')
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' })
    reveal!('tool:b', { align: 'center' })
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'center' })
    // An unknown key is a no-op, not a throw.
    expect(() => reveal!('tool:nope')).not.toThrow()
  })
})
