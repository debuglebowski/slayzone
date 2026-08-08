/**
 * Unit tests for the explode-mode layout engine.
 *
 * Run with: npx tsx packages/domains/app-shell/src/client/explodeLayout.test.ts
 */
import {
  computeExplodeLayout,
  explodeColumnCount,
  explodeColumnSizes,
  reconcileExplodeOrder,
  swapExplodeOrder
} from './explodeLayout'

let pass = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
  pass++
}
function eq(a: number, b: number, msg: string): void {
  assert(Math.abs(a - b) < 0.001, `${msg} (got ${a}, want ${b})`)
}

const BASE = { gap: 4, minCellWidth: 480 }
const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `t${i + 1}`)

// ── column count ────────────────────────────────────────────────────────────
{
  eq(explodeColumnCount(1000, 4, 480), 2, '1000px fits 2 columns at 480 min')
  eq(explodeColumnCount(1500, 4, 480), 3, '1500px fits 3')
  eq(explodeColumnCount(400, 4, 480), 1, 'below one min width still yields 1 column')
  // Never more columns than items — extra columns would be the empty cells this fixes.
  eq(explodeColumnCount(5000, 2, 480), 2, 'columns capped by item count')
  eq(explodeColumnCount(1000, 0, 480), 0, 'no items → no columns')
}

// ── column sizes: earlier columns take the remainder ────────────────────────
{
  assert(JSON.stringify(explodeColumnSizes(3, 2)) === '[2,1]', '3/2 → [2,1]')
  assert(JSON.stringify(explodeColumnSizes(5, 2)) === '[3,2]', '5/2 → [3,2]')
  assert(JSON.stringify(explodeColumnSizes(5, 3)) === '[2,2,1]', '5/3 → [2,2,1]')
  assert(JSON.stringify(explodeColumnSizes(4, 2)) === '[2,2]', '4/2 → [2,2] (already even)')
  assert(JSON.stringify(explodeColumnSizes(1, 1)) === '[1]', '1/1 → [1]')
}

// ── THE REGRESSION THIS FIXES: 3 cells, 2 columns ───────────────────────────
// Old behaviour was a 2x2 grid with a dead bottom-right cell and t3 at half
// height. The odd one out must now own its column at FULL height.
{
  const { cols, cells } = computeExplodeLayout({
    ...BASE,
    taskIds: ids(3),
    width: 1000,
    height: 600
  })
  eq(cols, 2, '3 items in 1000px → 2 columns')
  const [t1, t2, t3] = cells
  eq(t1.height, (600 - 4) / 2, 't1 is half height (shares column 1)')
  eq(t2.height, (600 - 4) / 2, 't2 is half height')
  eq(t3.height, 600, 't3 takes the FULL height of its own column')
  eq(t3.top, 0, 't3 starts at the top')
  assert(t1.col === 0 && t2.col === 0 && t3.col === 1, 'column-major placement')
  // No dead space: every column is filled top to bottom.
  eq(t1.top + t1.height + 4, t2.top, 't1 and t2 are flush with one gap')
  eq(t2.top + t2.height, 600, 'column 1 reaches the bottom exactly')
}

// ── widths tile the container exactly ───────────────────────────────────────
{
  const { cells } = computeExplodeLayout({ ...BASE, taskIds: ids(3), width: 1000, height: 600 })
  const colW = (1000 - 4) / 2
  eq(cells[0].width, colW, 'column width accounts for the gutter')
  eq(cells[2].left, colW + 4, 'second column starts after the gutter')
  eq(cells[2].left + cells[2].width, 1000, 'right edge lands exactly on the container')
}

// ── minimize = leave the grid entirely (parked in the header tray) ──────────
// The caller drops minimized ids from `taskIds`; the survivors must repack as if
// the terminal was never there, rather than a strip continuing to hold a row.
{
  const { cols, cells } = computeExplodeLayout({
    ...BASE,
    taskIds: ['t1', 't3'], // t2 minimized out of a 3-task set
    width: 1000,
    height: 600
  })
  eq(cols, 2, '2 remaining tasks → 2 columns')
  eq(cells[0].height, 600, 'each survivor takes a full column')
  eq(cells[1].height, 600, 'no leftover strip holding a row')
  eq(cells[1].left + cells[1].width, 1000, 'survivors still tile the full width')
}

// Minimizing down to one leaves a single full-bleed cell.
{
  const { cols, cells } = computeExplodeLayout({
    ...BASE,
    taskIds: ['t2'],
    width: 1000,
    height: 600
  })
  eq(cols, 1, 'one visible task → one column')
  eq(cells[0].width, 1000, 'full width')
  eq(cells[0].height, 600, 'full height')
}

// Minimizing ALL of them is legal and yields an empty grid, not broken geometry.
{
  const { cols, cells } = computeExplodeLayout({ ...BASE, taskIds: [], width: 1000, height: 600 })
  assert(cols === 0 && cells.length === 0, 'everything minimized → empty grid')
}

// ── single column (narrow window) stacks everything ─────────────────────────
{
  const { cols, cells } = computeExplodeLayout({
    ...BASE,
    taskIds: ids(3),
    width: 400,
    height: 600
  })
  eq(cols, 1, 'narrow window collapses to one column')
  eq(cells[0].width, 400, 'full width')
  eq(cells[2].top + cells[2].height, 600, 'stack reaches the bottom')
}

// ── rects are whole pixels and still tile exactly ───────────────────────────
// Awkward sizes that do not divide evenly: xterm derives its row count from the
// measured height, so a fractional one can oscillate between N and N+1 rows on
// sub-pixel jitter — each flip a real fit(), SIGWINCH and atlas re-raster.
{
  const { cells } = computeExplodeLayout({ ...BASE, taskIds: ids(5), width: 1001, height: 601 })
  for (const c of cells) {
    assert(Number.isInteger(c.left), `left is a whole pixel (${c.left})`)
    assert(Number.isInteger(c.top), `top is a whole pixel (${c.top})`)
    assert(Number.isInteger(c.width), `width is a whole pixel (${c.width})`)
    assert(Number.isInteger(c.height), `height is a whole pixel (${c.height})`)
  }
  // Rounding EDGES rather than sizes means neighbours still meet exactly.
  const col0 = cells.filter((c) => c.col === 0)
  const col1 = cells.filter((c) => c.col === 1)
  eq(col0[0].left + col0[0].width + 4, col1[0].left, 'columns meet across the gutter, no drift')
  eq(col0[col0.length - 1].top + col0[col0.length - 1].height, 601, 'column 0 ends on the edge')
  eq(col1[col1.length - 1].top + col1[col1.length - 1].height, 601, 'column 1 ends on the edge')
}

// ── empty / degenerate ──────────────────────────────────────────────────────
{
  const empty = computeExplodeLayout({ ...BASE, taskIds: [], width: 1000, height: 600 })
  assert(empty.cells.length === 0 && empty.cols === 0, 'no items → empty layout')
  const zero = computeExplodeLayout({ ...BASE, taskIds: ids(2), width: 0, height: 0 })
  assert(zero.cells.length === 2, 'zero-size container still yields one rect per item')
}

// ── swap: exchanges exactly two positions, never cascades ───────────────────
{
  const order = ['a', 'b', 'c', 'd']
  assert(JSON.stringify(swapExplodeOrder(order, 'a', 'd')) === '["d","b","c","a"]', 'ends swap')
  assert(JSON.stringify(swapExplodeOrder(order, 'b', 'c')) === '["a","c","b","d"]', 'middle swap')
  assert(
    JSON.stringify(swapExplodeOrder(order, 'a', 'a')) === '["a","b","c","d"]',
    'self is a no-op'
  )
  assert(
    JSON.stringify(swapExplodeOrder(order, 'a', 'zz')) === '["a","b","c","d"]',
    'unknown id is a no-op, not a crash'
  )
  assert(JSON.stringify(order) === '["a","b","c","d"]', 'input array is not mutated')
}

// ── reconcile: keep arrangement, drop closed, append new ────────────────────
{
  assert(
    JSON.stringify(reconcileExplodeOrder(['c', 'a'], ['a', 'b', 'c'])) === '["c","a","b"]',
    'stored order preserved; newly opened task appended'
  )
  assert(
    JSON.stringify(reconcileExplodeOrder(['c', 'a'], ['a'])) === '["a"]',
    'closed tasks dropped'
  )
  assert(
    JSON.stringify(reconcileExplodeOrder([], ['a', 'b'])) === '["a","b"]',
    'no stored order → open order'
  )
}

// ── duplicates in a stored order must collapse ──────────────────────────────
// A duplicate id gets laid out twice while the renderer draws each task once, so
// the grid sizes itself for the larger count and one rect is orphaned as dead
// space — the exact defect this layout exists to remove.
{
  assert(
    JSON.stringify(reconcileExplodeOrder(['a', 'a', 'b'], ['a', 'b'])) === '["a","b"]',
    'duplicate id collapses to one, first position wins'
  )
  assert(
    JSON.stringify(reconcileExplodeOrder(['b', 'a', 'b'], ['a', 'b'])) === '["b","a"]',
    'first occurrence sets the position, later ones are dropped'
  )
  assert(
    JSON.stringify(reconcileExplodeOrder(['a', 'a'], ['a', 'b'])) === '["a","b"]',
    'dedupe still appends the tasks that were never in the stored order'
  )

  // End to end: every allocated rect must belong to a distinct task, or the
  // renderer's id→rect map silently drops one and leaves a hole.
  const reconciled = reconcileExplodeOrder(['a', 'a', 'b'], ['a', 'b'])
  const { cells } = computeExplodeLayout({ ...BASE, taskIds: reconciled, width: 1000, height: 600 })
  const unique = new Set(cells.map((c) => c.taskId))
  assert(cells.length === unique.size, 'no two rects share a task id')
  eq(cells.length, 2, 'grid is sized for the real task count, not the padded one')
}

console.log(`OK — explodeLayout ${pass} checks passed`)
