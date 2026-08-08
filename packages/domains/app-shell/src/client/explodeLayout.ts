/**
 * Explode-mode layout engine.
 *
 * Pure geometry so the packing rules are unit-testable without a DOM, and so the
 * renderer stays a dumb `style={rect}` application. Returns absolute pixel rects
 * rather than CSS grid tracks for three reasons:
 *
 *  1. The cells are ONE flat `tabs.map` shared by explode and normal mode (normal
 *     mode already positions them `absolute inset-0`). Wrapping them in per-column
 *     elements for explode mode would change the React tree between modes and
 *     REMOUNT every terminal — xterm would lose its scrollback on each toggle.
 *  2. Drag-to-swap animates cleanly when every cell already has an explicit rect.
 *
 * MINIMIZE is deliberately NOT modelled here. A minimized terminal is parked in the
 * header tray and leaves the grid entirely, so the caller simply omits its id from
 * `taskIds` and the remaining cells repack to fill the space. Collapsing it to an
 * in-grid strip instead would keep spending a row on a terminal the user just said
 * they were done looking at.
 *
 * PACKING: column-major, no dead cells. Items are split across columns as evenly
 * as possible with earlier columns taking the remainder, so an odd item out lands
 * alone in a later column and takes that column's FULL height — rather than
 * sitting half-height beside an empty cell, which is the layout this replaces.
 *
 *   3 items / 2 cols → [2, 1]   col2's single item is full height
 *   5 items / 2 cols → [3, 2]
 *   5 items / 3 cols → [2, 2, 1]
 *   4 items / 2 cols → [2, 2]   already even, unchanged
 */

export interface ExplodeCellRect {
  taskId: string
  left: number
  top: number
  width: number
  height: number
  /** Column index, for drag hit-testing and debugging. */
  col: number
}

export interface ExplodeLayout {
  cols: number
  cells: ExplodeCellRect[]
}

export interface ExplodeLayoutInput {
  /** Task ids in display order — already reordered by any user drag, and with
   *  minimized ids already removed (they live in the header tray, not the grid). */
  taskIds: readonly string[]
  width: number
  height: number
  /** Gutter between cells, both axes. */
  gap: number
  /** Narrowest a cell may get before dropping a column. */
  minCellWidth: number
}

/**
 * How many columns fit, capped by the item count so N items never produce more
 * than N columns (which would leave trailing empties — the very thing this fixes).
 */
export function explodeColumnCount(width: number, count: number, minCellWidth: number): number {
  if (count <= 0) return 0
  if (width <= 0) return Math.max(1, Math.min(count, Math.ceil(Math.sqrt(count))))
  const fit = Math.max(1, Math.floor(width / minCellWidth))
  return Math.max(1, Math.min(fit, count))
}

/**
 * Items per column, column-major, earlier columns taking the remainder.
 * Never returns a zero-sized column: `cols` is always <= `count`.
 */
export function explodeColumnSizes(count: number, cols: number): number[] {
  if (count <= 0 || cols <= 0) return []
  const base = Math.floor(count / cols)
  const extra = count % cols
  return Array.from({ length: cols }, (_, i) => base + (i < extra ? 1 : 0))
}

export function computeExplodeLayout(input: ExplodeLayoutInput): ExplodeLayout {
  const { taskIds, width, height, gap, minCellWidth } = input
  const count = taskIds.length
  if (count === 0) return { cols: 0, cells: [] }

  const cols = explodeColumnCount(width, count, minCellWidth)
  const sizes = explodeColumnSizes(count, cols)

  const totalGapX = gap * (cols - 1)
  const colWidth = Math.max(0, (width - totalGapX) / cols)

  const cells: ExplodeCellRect[] = []
  let cursor = 0

  for (let col = 0; col < cols; col++) {
    const size = sizes[col]
    const ids = taskIds.slice(cursor, cursor + size)
    cursor += size

    const left = col * (colWidth + gap)
    const totalGapY = gap * (size - 1)
    // Clamp at 0 so a container smaller than its own gutters yields degenerate
    // rects rather than negative ones.
    const cellHeight = Math.max(0, (height - totalGapY) / size)

    // Snap to whole pixels by rounding EDGES, not sizes: adjacent cells then share
    // an exact boundary instead of drifting apart by a rounding error each.
    //
    // Fractional heights are not cosmetic here. xterm derives its row count from
    // the measured container, so a height landing on a row boundary (e.g. 298.4px
    // at a 17px line height) can flip between N and N+1 rows as the observer
    // reports sub-pixel jitter — each flip is a real fit(), a SIGWINCH to the pty
    // and a WebGL atlas re-raster. Integer rects make the row count stable.
    const leftPx = Math.round(left)
    const rightPx = Math.round(left + colWidth)

    let top = 0
    for (const taskId of ids) {
      const topPx = Math.round(top)
      const bottomPx = Math.round(top + cellHeight)
      cells.push({
        taskId,
        left: leftPx,
        top: topPx,
        width: rightPx - leftPx,
        height: bottomPx - topPx,
        col
      })
      top += cellHeight + gap
    }
  }

  return { cols, cells }
}

/**
 * Swap two ids in the display order. Swap, not splice-reorder: dragging cell A
 * onto cell B should exchange exactly those two positions and leave every other
 * cell where the user last put it. A splice would cascade-shift the tail, which
 * reads as "everything moved" when the user asked for one trade.
 */
export function swapExplodeOrder(order: readonly string[], a: string, b: string): string[] {
  const next = [...order]
  const ia = next.indexOf(a)
  const ib = next.indexOf(b)
  if (ia === -1 || ib === -1 || ia === ib) return next
  next[ia] = b
  next[ib] = a
  return next
}

/**
 * Reconcile a persisted order against the tabs that are actually open: keep the
 * user's arrangement, drop closed tasks, append newly-opened ones. Without this a
 * stored order silently hides a task that was opened after it was saved.
 *
 * Guarantees each open id appears EXACTLY ONCE. A duplicate would otherwise be
 * laid out twice while the renderer draws each task once — the grid sizes itself
 * for the larger count and one rect is left orphaned as dead space, which is the
 * exact defect this layout exists to remove. Deduping here rather than at the
 * persistence boundary because this is the single choke point every read passes
 * through, so the invariant holds for any source of a bad order, not just a
 * hand-edited settings blob.
 */
export function reconcileExplodeOrder(
  order: readonly string[],
  openTaskIds: readonly string[]
): string[] {
  const open = new Set(openTaskIds)
  const seen = new Set<string>()
  const kept: string[] = []
  for (const id of order) {
    if (!open.has(id) || seen.has(id)) continue
    seen.add(id)
    kept.push(id)
  }
  return [...kept, ...openTaskIds.filter((id) => !seen.has(id))]
}
