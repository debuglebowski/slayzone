import type { Key } from 'react'
import type { TimelineItem } from '@slayzone/terminal/client'

/** How a user's turn went, for the turn outline. */
export type TurnStatus = 'running' | 'done' | 'error' | 'stopped' | 'sending' | 'failed'

export interface TurnEntry {
  /** The user message row's `itemKey`: what the outline reveals. */
  key: Key
  /** Its index in the displayed timeline (not loaded here: its placeholder's). */
  index: number
  /** Its row in the timeline (a paged history loads it to reveal it). */
  row?: number
  /** The message's first line (or its attachments' names). */
  title: string
  timestamp: number
  status: TurnStatus
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
 * One entry per user turn of the displayed timeline (plan 4.3): its first
 * line, when it was sent, how it went. A turn is the rows from a user message
 * to the next one; its status comes from what ended it — a result (error or
 * not), a Stop, a turn error — or, for the last turn, whether the agent still
 * works (`turnOpen`). A message not delivered (yet) shows that instead.
 */
export function selectTurnOutline(
  items: readonly TimelineItem[],
  itemKey: (item: TimelineItem, index: number) => Key,
  opts: {
    turnOpen: boolean
    /** Item `i`'s display index (default `i`) and timeline row, when `items` stands in for more. */
    placeOf?: (i: number) => { index: number; row?: number }
  }
): TurnEntry[] {
  const turns: TurnEntry[] = []
  let current: TurnEntry | null = null
  /** The current message's delivery state, used only if nothing ended its turn. */
  let delivery: TurnStatus | null = null
  let ended = false
  const close = (last: boolean): void => {
    if (!current || ended) return
    current.status = delivery ?? (last && opts.turnOpen ? 'running' : 'done')
  }
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.kind === 'user-text') {
      close(false)
      ended = false
      delivery =
        item.delivery === 'failed'
          ? 'failed'
          : item.delivery === 'sending' || item.delivery === 'queued'
            ? 'sending'
            : null
      const place = opts.placeOf?.(i) ?? { index: i }
      current = {
        key: itemKey(item, i),
        index: place.index,
        ...(place.row !== undefined ? { row: place.row } : {}),
        title: titleOf(item),
        timestamp: item.timestamp,
        status: 'running'
      }
      turns.push(current)
      continue
    }
    if (!current || ended) continue
    // What ended the turn says how it went (it was delivered, whatever the
    // message's own state reads).
    if (item.kind === 'result') current.status = item.isError ? 'error' : 'done'
    else if (item.kind === 'turn-error') current.status = 'error'
    else if (item.kind === 'interrupted') current.status = 'stopped'
    else continue
    ended = true
  }
  close(true)
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
