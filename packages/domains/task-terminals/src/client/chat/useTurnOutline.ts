import { useMemo, type Key } from 'react'
import { useStableCallback } from '@slayzone/ui'
import type { TimelineItem, TimelinePageSummary } from '@slayzone/terminal/client'
import { selectTurnOutline, turnToJumpTo, type TurnEntry } from './turn-outline'
import { isRenderable } from './renderers'
import type { RevealTimelineItem } from './timeline-reveal'
import type { VirtualTimelineController } from './virtual-timeline'

/**
 * What the outline reads: the displayed rows, a placeholder of rows not loaded
 * (paged history) standing for its user turns and turn ends from the summary.
 */
function outlineSource(
  items: readonly TimelineItem[],
  itemKey: (item: TimelineItem, index: number) => Key,
  summary: TimelinePageSummary | undefined,
  folded: ReadonlySet<number> | undefined,
  rowOf: ((item: TimelineItem) => number | undefined) | undefined
): {
  items: TimelineItem[]
  places: Array<{ index: number; row?: number }>
  keys: Key[]
} {
  const out: TimelineItem[] = []
  const places: Array<{ index: number; row?: number }> = []
  const keys: Key[] = []
  items.forEach((item, index) => {
    if (item.kind !== 'history-gap' || !summary) {
      out.push(item)
      places.push({ index, row: rowOf?.(item) })
      keys.push(itemKey(item, index))
      return
    }
    const inGap = (row: number): boolean => row >= item.from && row < item.to && !folded?.has(row)
    const rows: Array<{ row: number; item: TimelineItem }> = []
    for (const u of summary.users) {
      if (inGap(u.row) && u.item.parentToolUseId == null && isRenderable(u.item)) rows.push(u)
    }
    for (const e of summary.ends) {
      if (!inGap(e.row)) continue
      const end =
        e.kind === 'result'
          ? { kind: 'result', isError: e.isError }
          : e.kind === 'turn-error'
            ? { kind: 'turn-error' }
            : { kind: 'interrupted' }
      rows.push({ row: e.row, item: end as TimelineItem })
    }
    rows.sort((a, b) => a.row - b.row)
    for (const r of rows) {
      out.push(r.item)
      places.push({ index, row: r.row })
      // The key the row will have once loaded (`user-text:<id>`).
      keys.push(
        r.item.kind === 'user-text' && r.item.id ? `user-text:${r.item.id}` : `row:${r.row}`
      )
    }
  })
  return { items: out, places, keys }
}

/**
 * The turn outline's data and its keyboard: the user turns of the whole
 * history (rows not loaded: from the summary), and "jump to the previous /
 * next turn" from where the view is — a turn not loaded loads first.
 */
export function useTurnOutline({
  items,
  itemKey,
  virtual,
  turnOpen,
  summary,
  folded,
  rowOf,
  reveal
}: {
  items: TimelineItem[]
  itemKey: (item: TimelineItem, index: number) => Key
  virtual: VirtualTimelineController
  /** The agent is working (the last turn runs). */
  turnOpen: boolean
  /** Paged history: the whole history's summary, the folded rows, rows' indexes. */
  summary?: TimelinePageSummary
  folded?: ReadonlySet<number>
  rowOf?: (item: TimelineItem) => number | undefined
  /** Reveal by key (and row): loads a row not here first. Default: the list's. */
  reveal?: RevealTimelineItem
}): { turns: TurnEntry[]; jump: (dir: -1 | 1) => void } {
  const turns = useMemo(() => {
    const source = outlineSource(items, itemKey, summary, folded, rowOf)
    return selectTurnOutline(source.items, (_item, i) => source.keys[i], {
      turnOpen,
      placeOf: (i) => source.places[i]
    })
  }, [items, itemKey, turnOpen, summary, folded, rowOf])
  const jump = useStableCallback((dir: -1 | 1): void => {
    const to = turnToJumpTo(
      turns.map((t) => t.index),
      virtual.topIndex(),
      dir
    )
    if (to === null) return
    // Several turns of rows not loaded share their placeholder's index: going
    // up, the nearest is its last; going down, its first.
    const turn =
      dir === 1 ? turns.find((t) => t.index === to) : turns.findLast((t) => t.index === to)
    if (!turn) return
    if (reveal) reveal(turn.key, { align: 'start', row: turn.row })
    else virtual.revealIndex(to, { align: 'start' })
  })
  return { turns, jump }
}
