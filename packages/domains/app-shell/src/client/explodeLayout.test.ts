/**
 * Unit tests for the explode-mode layout engine.
 */
import { describe, expect, test } from 'vitest'
import {
  computeExplodeLayout,
  explodeColumnCount,
  explodeColumnSizes,
  reconcileExplodeOrder,
  swapExplodeOrder
} from './explodeLayout'

/** Numeric equality within the old `eq` helper's 0.001 tolerance. */
function eq(a: number, b: number): void {
  expect(a).toBeCloseTo(b, 3)
}

const BASE = { gap: 4, minCellWidth: 480 }
const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `t${i + 1}`)

// ── column count ────────────────────────────────────────────────────────────
describe('column count', () => {
  test('1000px fits 2 columns at 480 min', () => {
    expect(explodeColumnCount(1000, 4, 480)).toBe(2)
  })
  test('1500px fits 3', () => {
    expect(explodeColumnCount(1500, 4, 480)).toBe(3)
  })
  test('below one min width still yields 1 column', () => {
    expect(explodeColumnCount(400, 4, 480)).toBe(1)
  })
  // Never more columns than items — extra columns would be the empty cells this fixes.
  test('columns capped by item count', () => {
    expect(explodeColumnCount(5000, 2, 480)).toBe(2)
  })
  test('no items → no columns', () => {
    expect(explodeColumnCount(1000, 0, 480)).toBe(0)
  })
})

// ── column sizes: earlier columns take the remainder ────────────────────────
describe('column sizes: earlier columns take the remainder', () => {
  test('3/2 → [2,1]', () => {
    expect(explodeColumnSizes(3, 2)).toEqual([2, 1])
  })
  test('5/2 → [3,2]', () => {
    expect(explodeColumnSizes(5, 2)).toEqual([3, 2])
  })
  test('5/3 → [2,2,1]', () => {
    expect(explodeColumnSizes(5, 3)).toEqual([2, 2, 1])
  })
  test('4/2 → [2,2] (already even)', () => {
    expect(explodeColumnSizes(4, 2)).toEqual([2, 2])
  })
  test('1/1 → [1]', () => {
    expect(explodeColumnSizes(1, 1)).toEqual([1])
  })
})

// ── THE REGRESSION THIS FIXES: 3 cells, 2 columns ───────────────────────────
// Old behaviour was a 2x2 grid with a dead bottom-right cell and t3 at half
// height. The odd one out must now own its column at FULL height.
describe('regression: 3 cells, 2 columns', () => {
  const layout = (): ReturnType<typeof computeExplodeLayout> =>
    computeExplodeLayout({ ...BASE, taskIds: ids(3), width: 1000, height: 600 })

  test('3 items in 1000px → 2 columns', () => {
    eq(layout().cols, 2)
  })
  test('t1 is half height (shares column 1)', () => {
    eq(layout().cells[0].height, (600 - 4) / 2)
  })
  test('t2 is half height', () => {
    eq(layout().cells[1].height, (600 - 4) / 2)
  })
  test('t3 takes the FULL height of its own column', () => {
    eq(layout().cells[2].height, 600)
  })
  test('t3 starts at the top', () => {
    eq(layout().cells[2].top, 0)
  })
  test('column-major placement', () => {
    expect(layout().cells.map((c) => c.col)).toEqual([0, 0, 1])
  })
  // No dead space: every column is filled top to bottom.
  test('t1 and t2 are flush with one gap', () => {
    const [t1, t2] = layout().cells
    eq(t1.top + t1.height + 4, t2.top)
  })
  test('column 1 reaches the bottom exactly', () => {
    const t2 = layout().cells[1]
    eq(t2.top + t2.height, 600)
  })
})

// ── widths tile the container exactly ───────────────────────────────────────
describe('widths tile the container exactly', () => {
  const cells = (): ReturnType<typeof computeExplodeLayout>['cells'] =>
    computeExplodeLayout({ ...BASE, taskIds: ids(3), width: 1000, height: 600 }).cells
  const colW = (1000 - 4) / 2

  test('column width accounts for the gutter', () => {
    eq(cells()[0].width, colW)
  })
  test('second column starts after the gutter', () => {
    eq(cells()[2].left, colW + 4)
  })
  test('right edge lands exactly on the container', () => {
    const c = cells()[2]
    eq(c.left + c.width, 1000)
  })
})

// ── minimize = leave the grid entirely (parked in the header tray) ──────────
// The caller drops minimized ids from `taskIds`; the survivors must repack as if
// the terminal was never there, rather than a strip continuing to hold a row.
describe('minimize = leave the grid entirely', () => {
  const layout = (): ReturnType<typeof computeExplodeLayout> =>
    computeExplodeLayout({
      ...BASE,
      taskIds: ['t1', 't3'], // t2 minimized out of a 3-task set
      width: 1000,
      height: 600
    })

  test('2 remaining tasks → 2 columns', () => {
    eq(layout().cols, 2)
  })
  test('each survivor takes a full column', () => {
    eq(layout().cells[0].height, 600)
  })
  test('no leftover strip holding a row', () => {
    eq(layout().cells[1].height, 600)
  })
  test('survivors still tile the full width', () => {
    const c = layout().cells[1]
    eq(c.left + c.width, 1000)
  })
})

// Minimizing down to one leaves a single full-bleed cell.
describe('minimizing down to one', () => {
  const layout = (): ReturnType<typeof computeExplodeLayout> =>
    computeExplodeLayout({ ...BASE, taskIds: ['t2'], width: 1000, height: 600 })

  test('one visible task → one column', () => {
    eq(layout().cols, 1)
  })
  test('full width', () => {
    eq(layout().cells[0].width, 1000)
  })
  test('full height', () => {
    eq(layout().cells[0].height, 600)
  })
})

// Minimizing ALL of them is legal and yields an empty grid, not broken geometry.
test('everything minimized → empty grid', () => {
  const { cols, cells } = computeExplodeLayout({ ...BASE, taskIds: [], width: 1000, height: 600 })
  expect(cols).toBe(0)
  expect(cells).toHaveLength(0)
})

// ── single column (narrow window) stacks everything ─────────────────────────
describe('single column (narrow window) stacks everything', () => {
  const layout = (): ReturnType<typeof computeExplodeLayout> =>
    computeExplodeLayout({ ...BASE, taskIds: ids(3), width: 400, height: 600 })

  test('narrow window collapses to one column', () => {
    eq(layout().cols, 1)
  })
  test('full width', () => {
    eq(layout().cells[0].width, 400)
  })
  test('stack reaches the bottom', () => {
    const c = layout().cells[2]
    eq(c.top + c.height, 600)
  })
})

// ── rects are whole pixels and still tile exactly ───────────────────────────
// Awkward sizes that do not divide evenly: xterm derives its row count from the
// measured height, so a fractional one can oscillate between N and N+1 rows on
// sub-pixel jitter — each flip a real fit(), SIGWINCH and atlas re-raster.
describe('rects are whole pixels and still tile exactly', () => {
  const layout = (): ReturnType<typeof computeExplodeLayout> =>
    computeExplodeLayout({ ...BASE, taskIds: ids(5), width: 1001, height: 601 })
  // Pure computation: safe to evaluate at collection time to emit one test per rect edge.
  const cellCount = layout().cells.length

  test('awkward size yields one rect per item', () => {
    expect(cellCount).toBe(5)
  })

  for (let i = 0; i < cellCount; i++) {
    for (const key of ['left', 'top', 'width', 'height'] as const) {
      test(`cell ${i}: ${key} is a whole pixel`, () => {
        const v = layout().cells[i][key]
        expect(Number.isInteger(v), `${key} = ${v}`).toBe(true)
      })
    }
  }

  // Rounding EDGES rather than sizes means neighbours still meet exactly.
  const cols = (): {
    col0: ReturnType<typeof computeExplodeLayout>['cells']
    col1: ReturnType<typeof computeExplodeLayout>['cells']
  } => {
    const cells = layout().cells
    return { col0: cells.filter((c) => c.col === 0), col1: cells.filter((c) => c.col === 1) }
  }
  test('columns meet across the gutter, no drift', () => {
    const { col0, col1 } = cols()
    eq(col0[0].left + col0[0].width + 4, col1[0].left)
  })
  test('column 0 ends on the edge', () => {
    const { col0 } = cols()
    eq(col0[col0.length - 1].top + col0[col0.length - 1].height, 601)
  })
  test('column 1 ends on the edge', () => {
    const { col1 } = cols()
    eq(col1[col1.length - 1].top + col1[col1.length - 1].height, 601)
  })
})

// ── empty / degenerate ──────────────────────────────────────────────────────
describe('empty / degenerate', () => {
  test('no items → empty layout', () => {
    const empty = computeExplodeLayout({ ...BASE, taskIds: [], width: 1000, height: 600 })
    expect(empty.cells).toHaveLength(0)
    expect(empty.cols).toBe(0)
  })
  test('zero-size container still yields one rect per item', () => {
    const zero = computeExplodeLayout({ ...BASE, taskIds: ids(2), width: 0, height: 0 })
    expect(zero.cells).toHaveLength(2)
  })
})

// ── swap: exchanges exactly two positions, never cascades ───────────────────
describe('swap: exchanges exactly two positions, never cascades', () => {
  const order = ['a', 'b', 'c', 'd']
  test('ends swap', () => {
    expect(swapExplodeOrder(order, 'a', 'd')).toEqual(['d', 'b', 'c', 'a'])
  })
  test('middle swap', () => {
    expect(swapExplodeOrder(order, 'b', 'c')).toEqual(['a', 'c', 'b', 'd'])
  })
  test('self is a no-op', () => {
    expect(swapExplodeOrder(order, 'a', 'a')).toEqual(['a', 'b', 'c', 'd'])
  })
  test('unknown id is a no-op, not a crash', () => {
    expect(swapExplodeOrder(order, 'a', 'zz')).toEqual(['a', 'b', 'c', 'd'])
  })
  test('input array is not mutated', () => {
    const input = ['a', 'b', 'c', 'd']
    swapExplodeOrder(input, 'a', 'd')
    swapExplodeOrder(input, 'b', 'c')
    swapExplodeOrder(input, 'a', 'a')
    swapExplodeOrder(input, 'a', 'zz')
    expect(input).toEqual(['a', 'b', 'c', 'd'])
  })
})

// ── reconcile: keep arrangement, drop closed, append new ────────────────────
describe('reconcile: keep arrangement, drop closed, append new', () => {
  test('stored order preserved; newly opened task appended', () => {
    expect(reconcileExplodeOrder(['c', 'a'], ['a', 'b', 'c'])).toEqual(['c', 'a', 'b'])
  })
  test('closed tasks dropped', () => {
    expect(reconcileExplodeOrder(['c', 'a'], ['a'])).toEqual(['a'])
  })
  test('no stored order → open order', () => {
    expect(reconcileExplodeOrder([], ['a', 'b'])).toEqual(['a', 'b'])
  })
})

// ── duplicates in a stored order must collapse ──────────────────────────────
// A duplicate id gets laid out twice while the renderer draws each task once, so
// the grid sizes itself for the larger count and one rect is orphaned as dead
// space — the exact defect this layout exists to remove.
describe('duplicates in a stored order must collapse', () => {
  test('duplicate id collapses to one, first position wins', () => {
    expect(reconcileExplodeOrder(['a', 'a', 'b'], ['a', 'b'])).toEqual(['a', 'b'])
  })
  test('first occurrence sets the position, later ones are dropped', () => {
    expect(reconcileExplodeOrder(['b', 'a', 'b'], ['a', 'b'])).toEqual(['b', 'a'])
  })
  test('dedupe still appends the tasks that were never in the stored order', () => {
    expect(reconcileExplodeOrder(['a', 'a'], ['a', 'b'])).toEqual(['a', 'b'])
  })

  // End to end: every allocated rect must belong to a distinct task, or the
  // renderer's id→rect map silently drops one and leaves a hole.
  const cells = (): ReturnType<typeof computeExplodeLayout>['cells'] => {
    const reconciled = reconcileExplodeOrder(['a', 'a', 'b'], ['a', 'b'])
    return computeExplodeLayout({ ...BASE, taskIds: reconciled, width: 1000, height: 600 }).cells
  }
  test('no two rects share a task id', () => {
    const c = cells()
    expect(new Set(c.map((x) => x.taskId)).size).toBe(c.length)
  })
  test('grid is sized for the real task count, not the padded one', () => {
    expect(cells()).toHaveLength(2)
  })
})
