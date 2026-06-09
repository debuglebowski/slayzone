// Pure geometry — resolve a layout tree into rectangles. No React, no DOM.
//
// Each split distributes its rect along its axis by `fractions`, clamped so no
// subtree shrinks below the space its descendants need (`subtreeMin`), using a
// lock-and-redistribute pass adapted (per-split) from the electron app's
// usePanelSizes.resolveLayout. Cross-axis, children fill the full extent.
import type { Axis, LayoutNode, Rect, SplitDirection } from './types'
import { DIVIDER_PX } from './types'

export interface DividerRect {
  splitId: string
  /** Boundary between child `index` and `index + 1`. */
  index: number
  direction: SplitDirection
  rect: Rect
}

export interface ResolvedLayout {
  /** nodeId → rect (both splits and panes). */
  rects: Map<string, Rect>
  /** Hit/render rects for every divider across all splits. */
  dividers: DividerRect[]
}

/** The axis a split distributes along: row → width, col → height. */
export function axisOf(direction: SplitDirection): Axis {
  return direction === 'row' ? 'w' : 'h'
}

/** Clamp negatives/non-finite to 0 and scale to sum 1; equal split if degenerate. */
export function normalizeFractions(fractions: number[], count?: number): number[] {
  const n = count ?? fractions.length
  if (n <= 0) return []
  const safe = Array.from({ length: n }, (_, i) => {
    const v = fractions[i]
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
  })
  const sum = safe.reduce((a, b) => a + b, 0)
  if (sum <= 0) return new Array<number>(n).fill(1 / n)
  return safe.map((v) => v / sum)
}

/** Minimum px a subtree needs along `axis` (sum along its own axis, max across). */
export function subtreeMin(node: LayoutNode, axis: Axis): number {
  if (node.kind === 'pane') return axis === 'w' ? node.min.w : node.min.h
  const childMins = node.children.map((c) => subtreeMin(c, axis))
  const along = axisOf(node.direction) === axis
  if (along) {
    return childMins.reduce((a, b) => a + b, 0) + DIVIDER_PX * Math.max(0, node.children.length - 1)
  }
  return childMins.length ? Math.max(...childMins) : 0
}

/**
 * Distribute `avail` px among children by `fractions`, never below `mins`.
 * Lock any child whose proportional share is below its min, then redistribute
 * the remaining pool among the rest; repeat until stable. If the mins don't
 * fit, mins win (children overflow the container — the caller clips).
 */
export function allocate(avail: number, fractions: number[], mins: number[]): number[] {
  const n = fractions.length
  if (n === 0) return []
  const fr = normalizeFractions(fractions, n)
  const out = new Array<number>(n).fill(0)
  const locked = new Array<boolean>(n).fill(false)
  for (let iter = 0; iter <= n; iter += 1) {
    let lockedSum = 0
    let weightSum = 0
    const unlocked: number[] = []
    for (let i = 0; i < n; i += 1) {
      if (locked[i]) lockedSum += out[i]
      else {
        unlocked.push(i)
        weightSum += fr[i]
      }
    }
    if (unlocked.length === 0) break
    const pool = avail - lockedSum
    let changed = false
    for (const i of unlocked) {
      const share = weightSum > 0 ? pool * (fr[i] / weightSum) : pool / unlocked.length
      if (share < mins[i]) {
        out[i] = mins[i]
        locked[i] = true
        changed = true
      } else {
        out[i] = share
      }
    }
    if (!changed) break
  }
  return out
}

/** Resolve a tree (or null) into a flat map of node rects + divider rects. */
export function resolveTree(root: LayoutNode | null, rootRect: Rect): ResolvedLayout {
  const rects = new Map<string, Rect>()
  const dividers: DividerRect[] = []
  if (!root) return { rects, dividers }

  const walk = (node: LayoutNode, rect: Rect): void => {
    rects.set(node.id, rect)
    if (node.kind === 'pane') return

    const axis = axisOf(node.direction)
    const count = node.children.length
    const dividerCount = Math.max(0, count - 1)
    const total = axis === 'w' ? rect.w : rect.h
    const avail = Math.max(0, total - DIVIDER_PX * dividerCount)
    const mins = node.children.map((c) => subtreeMin(c, axis))
    const sizes = allocate(avail, node.fractions, mins)

    let cursor = axis === 'w' ? rect.x : rect.y
    node.children.forEach((child, i) => {
      const childRect: Rect =
        axis === 'w'
          ? { x: cursor, y: rect.y, w: sizes[i], h: rect.h }
          : { x: rect.x, y: cursor, w: rect.w, h: sizes[i] }
      walk(child, childRect)
      cursor += sizes[i]
      if (i < count - 1) {
        const divRect: Rect =
          axis === 'w'
            ? { x: cursor, y: rect.y, w: DIVIDER_PX, h: rect.h }
            : { x: rect.x, y: cursor, w: rect.w, h: DIVIDER_PX }
        dividers.push({ splitId: node.id, index: i, direction: node.direction, rect: divRect })
        cursor += DIVIDER_PX
      }
    })
  }

  walk(root, rootRect)
  return { rects, dividers }
}
