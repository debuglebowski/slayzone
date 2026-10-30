import { useMemo, type Key } from 'react'
import { useStableCallback } from '@slayzone/ui'
import type { TimelineItem } from '@slayzone/terminal/client'
import { selectTurnOutline, turnToJumpTo, type TurnEntry } from './turn-outline'
import type { VirtualTimelineController } from './virtual-timeline'

/**
 * The turn outline's data and its keyboard: the user turns of the displayed
 * timeline, and "jump to the previous / next turn" from where the view is.
 */
export function useTurnOutline({
  items,
  itemKey,
  virtual,
  turnOpen
}: {
  items: TimelineItem[]
  itemKey: (item: TimelineItem, index: number) => Key
  virtual: VirtualTimelineController
  /** The agent is working (the last turn runs). */
  turnOpen: boolean
}): { turns: TurnEntry[]; jump: (dir: -1 | 1) => void } {
  const turns = useMemo(
    () => selectTurnOutline(items, itemKey, { turnOpen }),
    [items, itemKey, turnOpen]
  )
  const jump = useStableCallback((dir: -1 | 1): void => {
    const to = turnToJumpTo(
      turns.map((t) => t.index),
      virtual.topIndex(),
      dir
    )
    if (to !== null) virtual.revealIndex(to, { align: 'start' })
  })
  return { turns, jump }
}
