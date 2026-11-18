/**
 * Where a dragged task lands, as plain data: the board registers its drop targets —
 * each column's area (a phone's column chip is one too, `atEnd`: dropping there = that
 * column's end) and each visible row — in window coordinates when a drag starts, and the
 * finger's position picks the column it is in and the first row of it whose middle is
 * below the finger (the task lands before that row; none = the column's end). The
 * later-registered column wins where areas overlap (a chip drawn over a column).
 *
 * And how fast a drag near a scroller's edge scrolls it (`edgeScrollSpeed`, clamped to
 * its content by `clampScroll`): a long column scrolls under the finger, and an iPad's
 * row of columns scrolls sideways, so every place is reachable while dragging.
 */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface DropTargets {
  /** `atEnd`: a stand-in for the column (a phone's chip): a drop there = its end. */
  columns: readonly { id: string; rect: Rect; atEnd?: boolean }[]
  rows: readonly { taskId: string; columnId: string; rect: Rect }[]
}

export interface DropPoint {
  column: string
  beforeTaskId: string | null
}

const contains = (r: Rect, p: { x: number; y: number }): boolean =>
  p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height

export function dropTarget(
  targets: DropTargets,
  point: { x: number; y: number }
): DropPoint | null {
  const column = [...targets.columns].reverse().find((c) => contains(c.rect, point))
  if (!column) return null
  // A chip is not where the column's rows are: its rows say nothing about the finger.
  if (column.atEnd) return { column: column.id, beforeTaskId: null }
  const rows = targets.rows
    .filter((r) => r.columnId === column.id)
    .sort((a, b) => a.rect.y - b.rect.y)
  const before = rows.find((r) => r.rect.y + r.rect.height / 2 > point.y)
  return { column: column.id, beforeTaskId: before?.taskId ?? null }
}

/** How deep the edge zones are (points) and the top speed (points per frame). */
export interface EdgeScroll {
  zone: number
  max: number
}

export const EDGE_SCROLL: EdgeScroll = { zone: 56, max: 14 }

/**
 * The scroll speed (points per frame, signed) for a finger at `pos` along a scroller
 * whose viewport spans `start`…`start + length` on that axis: back (negative) in the zone
 * at its start, on (positive) in the zone at its end, faster the closer to the edge;
 * 0 in between and anywhere outside the viewport (a finger over the column strip, say).
 * A viewport shorter than two zones splits into halves.
 */
export function edgeScrollSpeed(
  pos: number,
  start: number,
  length: number,
  { zone, max }: EdgeScroll = EDGE_SCROLL
): number {
  if (length <= 0 || pos < start || pos > start + length) return 0
  const depth = Math.min(zone, length / 2)
  if (depth <= 0) return 0
  const fromStart = pos - start
  const fromEnd = start + length - pos
  if (fromStart < depth) return -max * (1 - fromStart / depth)
  if (fromEnd < depth) return max * (1 - fromEnd / depth)
  return 0
}

/** `offset + delta`, kept within what the content can scroll (0 … content − viewport). */
export function clampScroll(
  offset: number,
  delta: number,
  size: { content: number; viewport: number }
): number {
  const most = Math.max(0, size.content - size.viewport)
  return Math.min(most, Math.max(0, offset + delta))
}
