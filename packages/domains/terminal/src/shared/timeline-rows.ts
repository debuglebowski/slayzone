/**
 * A conversation's rows as the reducer sees them, when only some are loaded
 * (paged history): `undefined` = a row this state does not hold. The reducer
 * reads rows only through {@link rowAt} / {@link rowAtIfAny}, so an unloaded one
 * stops it ({@link RowsNotLoaded}) instead of reading as "no such row" — it then
 * waits for the row and goes on exactly as a full replay would.
 */
import type { TimelineItem } from './chat-timeline'

export type TimelineRows = Array<TimelineItem | undefined>

/** The reducer needs row `row`, which this state does not hold. */
export class RowsNotLoaded extends Error {
  constructor(readonly row: number) {
    super(`chat timeline row ${row} is not loaded`)
    this.name = 'RowsNotLoaded'
  }
}

/** Row `i`, which must exist; an unloaded one throws {@link RowsNotLoaded}. */
export function rowAt(timeline: Readonly<TimelineRows>, i: number): TimelineItem {
  if (i < 0 || i >= timeline.length) throw new RangeError(`chat timeline row ${i} out of range`)
  const it = timeline[i]
  if (it === undefined) throw new RowsNotLoaded(i)
  return it
}

/** Row `i` when `i` points into the timeline, else undefined (unloaded: as {@link rowAt}). */
export function rowAtIfAny(
  timeline: Readonly<TimelineRows>,
  i: number | undefined
): TimelineItem | undefined {
  if (i === undefined || i < 0 || i >= timeline.length) return undefined
  return rowAt(timeline, i)
}

/** The first unloaded row, or -1 when every row is loaded. */
export function firstUnloaded(timeline: Readonly<TimelineRows>): number {
  for (let i = 0; i < timeline.length; i++) if (timeline[i] === undefined) return i
  return -1
}
