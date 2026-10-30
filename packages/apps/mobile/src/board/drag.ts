/**
 * Where a dragged task lands, as plain data: the board registers its drop targets —
 * each column's area (a phone's column chip is one too: dropping there = that column's
 * end) and each visible row — in window coordinates when a drag starts, and the finger's
 * position picks the column it is in and the first row of it whose middle is below the
 * finger (the task lands before that row; none = the column's end). The later-registered
 * column wins where areas overlap (a chip drawn over a column).
 */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface DropTargets {
  columns: readonly { id: string; rect: Rect }[]
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
  const rows = targets.rows
    .filter((r) => r.columnId === column.id)
    .sort((a, b) => a.rect.y - b.rect.y)
  const before = rows.find((r) => r.rect.y + r.rect.height / 2 > point.y)
  return { column: column.id, beforeTaskId: before?.taskId ?? null }
}
