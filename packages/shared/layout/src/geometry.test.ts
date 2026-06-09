import { describe, expect, it } from 'vitest'
import { allocate, normalizeFractions, resolveTree, subtreeMin } from './geometry'
import { DIVIDER_PX } from './types'
import type { PaneNode, SplitNode, Tile } from './types'

const tile = (id: string): Tile => ({ id, type: 'editor', title: id, renderKind: 'dom' })
const pane = (id: string, minW = 200, minH = 120): PaneNode => ({
  kind: 'pane',
  id,
  tiles: [tile(id + '-t')],
  activeTileId: id + '-t',
  min: { w: minW, h: minH }
})
const rowSplit = (children: (PaneNode | SplitNode)[], fractions?: number[]): SplitNode => ({
  kind: 'split',
  id: 'split',
  direction: 'row',
  children,
  fractions: fractions ?? children.map(() => 1 / children.length)
})

describe('normalizeFractions', () => {
  it('scales to sum 1', () => {
    expect(normalizeFractions([1, 3])).toEqual([0.25, 0.75])
  })
  it('equal-splits a degenerate input', () => {
    expect(normalizeFractions([0, 0], 2)).toEqual([0.5, 0.5])
    expect(normalizeFractions([], 3)).toEqual([1 / 3, 1 / 3, 1 / 3])
  })
})

describe('allocate', () => {
  it('splits proportionally when above mins', () => {
    expect(allocate(200, [0.5, 0.5], [10, 10])).toEqual([100, 100])
    expect(allocate(200, [0.75, 0.25], [10, 10])).toEqual([150, 50])
  })
  it('locks a below-min child and redistributes the surplus', () => {
    // 0.9/0.1 of 300 → [270, 30]; child1 min 50 → lock 50, child0 gets 250
    expect(allocate(300, [0.9, 0.1], [50, 50])).toEqual([250, 50])
  })
  it('mins win on overflow', () => {
    expect(allocate(300, [0.5, 0.5], [200, 200])).toEqual([200, 200])
  })
})

describe('subtreeMin', () => {
  it('sums along the split axis (incl. dividers), maxes across', () => {
    const s = rowSplit([pane('a', 200, 100), pane('b', 200, 150)])
    expect(subtreeMin(s, 'w')).toBe(200 + 200 + DIVIDER_PX)
    expect(subtreeMin(s, 'h')).toBe(150)
  })
})

describe('resolveTree', () => {
  it('a single pane fills the rect', () => {
    const p = pane('solo')
    const { rects } = resolveTree(p, { x: 0, y: 0, w: 100, h: 80 })
    expect(rects.get('solo')).toEqual({ x: 0, y: 0, w: 100, h: 80 })
  })

  it('lays out an equal row split with a divider between children', () => {
    const a = pane('a', 10)
    const b = pane('b', 10)
    const s = rowSplit([a, b])
    // avail = 206 - 6 = 200 → 100 each
    const { rects, dividers } = resolveTree(s, { x: 0, y: 0, w: 206, h: 50 })
    expect(rects.get('a')).toEqual({ x: 0, y: 0, w: 100, h: 50 })
    expect(rects.get('b')).toEqual({ x: 106, y: 0, w: 100, h: 50 })
    expect(dividers).toHaveLength(1)
    expect(dividers[0]).toMatchObject({ splitId: 'split', index: 0, direction: 'row' })
    expect(dividers[0].rect).toEqual({ x: 100, y: 0, w: DIVIDER_PX, h: 50 })
  })

  it('honors fractions', () => {
    const s = rowSplit([pane('a', 10), pane('b', 10)], [0.7, 0.3])
    const { rects } = resolveTree(s, { x: 0, y: 0, w: 106, h: 10 }) // avail 100
    expect(rects.get('a')?.w).toBeCloseTo(70)
    expect(rects.get('b')?.w).toBeCloseTo(30)
  })

  it('col split distributes along height', () => {
    const s: SplitNode = { ...rowSplit([pane('a', 10, 10), pane('b', 10, 10)]), direction: 'col' }
    const { rects, dividers } = resolveTree(s, { x: 0, y: 0, w: 40, h: 206 })
    expect(rects.get('a')).toEqual({ x: 0, y: 0, w: 40, h: 100 })
    expect(rects.get('b')).toEqual({ x: 0, y: 106, w: 40, h: 100 })
    expect(dividers[0].rect).toEqual({ x: 0, y: 100, w: 40, h: DIVIDER_PX })
  })

  it('null root resolves to empty', () => {
    const { rects, dividers } = resolveTree(null, { x: 0, y: 0, w: 10, h: 10 })
    expect(rects.size).toBe(0)
    expect(dividers).toHaveLength(0)
  })
})
