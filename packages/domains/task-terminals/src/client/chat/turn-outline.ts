import type { Key } from 'react'
import type { TimelineItem } from '@slayzone/terminal/client'

export interface TurnEntry {
  /** The user message row's `itemKey`: what "Go to turn" reveals. */
  key: Key
  /** Its index in the displayed timeline (not loaded here: its placeholder's). */
  index: number
  /** Its row in the timeline (a paged history loads it to reveal it). */
  row?: number
  /** The message's first line (or its attachments' names). */
  title: string
}

const MAX_TITLE = 120

function titleOf(item: Extract<TimelineItem, { kind: 'user-text' }>): string {
  const line = item.text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (line) return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1)}…` : line
  const files = (item.attachments ?? []).map((a) => a.name).filter(Boolean)
  return files.length > 0 ? files.join(', ') : '(empty message)'
}

/**
 * One entry per user turn of the displayed timeline (plan 4.3): where it is and
 * its first line — for Cmd+K "Go to turn…" and previous / next turn.
 */
export function selectTurnOutline(
  items: readonly TimelineItem[],
  itemKey: (item: TimelineItem, index: number) => Key,
  opts: {
    /** Item `i`'s display index (default `i`) and timeline row, when `items` stands in for more. */
    placeOf?: (i: number) => { index: number; row?: number }
  } = {}
): TurnEntry[] {
  const turns: TurnEntry[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.kind !== 'user-text') continue
    const place = opts.placeOf?.(i) ?? { index: i }
    turns.push({
      key: itemKey(item, i),
      index: place.index,
      ...(place.row !== undefined ? { row: place.row } : {}),
      title: titleOf(item)
    })
  }
  return turns
}

/**
 * Where "previous / next turn" goes from the row at the top of the view:
 * next = the first turn starting below it; previous = the start of the turn it
 * is in (when scrolled into it), else the turn before. Null at either end.
 */
export function turnToJumpTo(
  starts: readonly number[],
  topIndex: number,
  dir: -1 | 1
): number | null {
  if (dir === 1) return starts.find((s) => s > topIndex) ?? null
  for (let i = starts.length - 1; i >= 0; i--) if (starts[i] < topIndex) return starts[i]
  return null
}
