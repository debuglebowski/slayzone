import { describe, expect, it } from 'vitest'
import { applySplitResize, resetSplitFractions } from './resize'

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)

describe('applySplitResize', () => {
  it('moves the boundary, preserving the neighbor pair sum and leaving others untouched', () => {
    // 3 children, equal thirds of 300px content. Drag divider 0 by +30px.
    const out = applySplitResize([1 / 3, 1 / 3, 1 / 3], [10, 10, 10], 0, 30, 300)
    expect(out[0] * 300).toBeCloseTo(130)
    expect(out[1] * 300).toBeCloseTo(70)
    expect(out[2] * 300).toBeCloseTo(100) // untouched
    expect(sum(out)).toBeCloseTo(1)
  })

  it('clamps at the left min', () => {
    // left at 100, drag -90 but left min is 40 → left pinned to 40, right gets 160
    const out = applySplitResize([0.5, 0.5], [40, 10], 0, -90, 200)
    expect(out[0] * 200).toBeCloseTo(40)
    expect(out[1] * 200).toBeCloseTo(160)
  })

  it('clamps at the right min', () => {
    const out = applySplitResize([0.5, 0.5], [10, 40], 0, 90, 200)
    expect(out[0] * 200).toBeCloseTo(160)
    expect(out[1] * 200).toBeCloseTo(40)
  })

  it('is a no-op for an out-of-range divider index', () => {
    expect(applySplitResize([0.5, 0.5], [10, 10], 5, 50, 200)).toEqual([0.5, 0.5])
  })
})

describe('resetSplitFractions', () => {
  it('returns equal fractions', () => {
    expect(resetSplitFractions(4)).toEqual([0.25, 0.25, 0.25, 0.25])
    expect(resetSplitFractions(0)).toEqual([])
  })
})
