import { describe, it, expect } from 'vitest'
import {
  resolveLayout,
  resolvePanels,
  planPanelStrip,
  effectiveLayout,
  applyBoundaryResize,
  normalizeOverrides
} from './usePanelSizes'
import type { ResolvedLayout } from './usePanelSizes'
import type { PanelLayout, PanelConfig } from '../shared/types'

const L = (p: Partial<PanelLayout> & { unit: PanelLayout['unit']; value: number }): PanelLayout => ({
  ...p
})

describe('resolveLayout', () => {
  it('splits fr panels equally over the leftover (minus handles)', () => {
    const r = resolveLayout(
      [
        { key: 'a', layout: L({ unit: 'fr', value: 1 }) },
        { key: 'b', layout: L({ unit: 'fr', value: 1 }) }
      ],
      1016
    )
    // 1016 - 1 handle*16 = 1000, split 500/500
    expect(r.widths.a).toBeCloseTo(500)
    expect(r.widths.b).toBeCloseTo(500)
    expect(r.gapPx).toBe(0)
    expect(r.overflow).toBe(false)
  })

  it('px panels are static; fr fills the rest', () => {
    const r = resolveLayout(
      [
        { key: 'a', layout: L({ unit: 'px', value: 300 }) },
        { key: 'b', layout: L({ unit: 'fr', value: 1 }) }
      ],
      1016
    )
    expect(r.widths.a).toBe(300)
    expect(r.widths.b).toBeCloseTo(1016 - 300 - 16)
  })

  it('pct is percent of the whole container', () => {
    const r = resolveLayout([{ key: 'a', layout: L({ unit: 'pct', value: 50 }) }], 1000)
    expect(r.widths.a).toBe(500)
  })

  it('weights respecting min via lock-and-redistribute', () => {
    const r = resolveLayout(
      [
        { key: 'a', layout: L({ unit: 'fr', value: 1, min: 800 }) },
        { key: 'b', layout: L({ unit: 'fr', value: 1 }) }
      ],
      1016
    )
    // equal share would be 500 each, but a's min=800 locks it; b gets the remainder
    expect(r.widths.a).toBe(800)
    expect(r.widths.b).toBeCloseTo(200)
  })

  it('respects max via lock-and-redistribute', () => {
    const r = resolveLayout(
      [
        { key: 'a', layout: L({ unit: 'fr', value: 1, max: 300 }) },
        { key: 'b', layout: L({ unit: 'fr', value: 1 }) }
      ],
      1016
    )
    expect(r.widths.a).toBe(300)
    expect(r.widths.b).toBeCloseTo(700)
  })

  it('right-anchored panels produce a gap', () => {
    const r = resolveLayout(
      [
        { key: 'a', layout: L({ unit: 'px', value: 200, align: 'left' }) },
        { key: 'b', layout: L({ unit: 'px', value: 300, align: 'right' }) }
      ],
      1000
    )
    expect(r.leftKeys).toEqual(['a'])
    expect(r.rightKeys).toEqual(['b'])
    expect(r.gapPx).toBe(484) // 1000 - 200 - 300 - 16 (boundary handle)
    expect(r.overflow).toBe(false)
  })

  it('overflows when statics exceed the container', () => {
    const r = resolveLayout(
      [
        { key: 'a', layout: L({ unit: 'px', value: 600 }) },
        { key: 'b', layout: L({ unit: 'px', value: 600 }) }
      ],
      1000
    )
    expect(r.overflow).toBe(true)
    expect(r.gapPx).toBe(0)
  })

  it('single panel: no handles, no gap', () => {
    const r = resolveLayout([{ key: 'a', layout: L({ unit: 'fr', value: 1 }) }], 800)
    expect(r.widths.a).toBe(800)
    expect(r.gapPx).toBe(0)
  })
})

describe('resolvePanels + effectiveLayout', () => {
  it('uses hardcoded fallback when no config/override', () => {
    expect(effectiveLayout('terminal', null, {})).toMatchObject({ unit: 'fr', value: 1, min: 200 })
    expect(effectiveLayout('settings', null, {})).toMatchObject({ unit: 'px', value: 440 })
  })

  it('maps task id diff → order id git for the global layout', () => {
    const cfg = { layout: { git: { unit: 'px', value: 333 } } } as unknown as PanelConfig
    expect(effectiveLayout('diff', cfg, {})).toMatchObject({ unit: 'px', value: 333 })
  })

  it('override changes size only; min stays from the default', () => {
    const eff = effectiveLayout('terminal', null, { terminal: { unit: 'px', value: 700 } })
    expect(eff).toMatchObject({ unit: 'px', value: 700, min: 200 })
  })

  it('resolvePanels integrates fallback (fr terminal + px settings)', () => {
    const r = resolvePanels(['terminal', 'settings'], null, {}, 1016)
    expect(r.widths.settings).toBe(440)
    expect(r.widths.terminal).toBeCloseTo(1016 - 440 - 16)
  })
})

describe('applyBoundaryResize', () => {
  it('both fr → redistribute combined weight, sum preserved', () => {
    const u = applyBoundaryResize(
      L({ unit: 'fr', value: 1 }),
      L({ unit: 'fr', value: 1 }),
      'a',
      'b',
      600,
      400,
      1000
    )
    expect(u.a).toEqual({ unit: 'fr', value: expect.closeTo(1.2) })
    expect(u.b).toEqual({ unit: 'fr', value: expect.closeTo(0.8) })
  })

  it('both static (px) → write each px', () => {
    const u = applyBoundaryResize(
      L({ unit: 'px', value: 100 }),
      L({ unit: 'px', value: 100 }),
      'a',
      'b',
      600,
      400,
      1000
    )
    expect(u.a).toEqual({ unit: 'px', value: 600 })
    expect(u.b).toEqual({ unit: 'px', value: 400 })
  })

  it('mixed (fr + static) → write the static side only', () => {
    const u = applyBoundaryResize(
      L({ unit: 'fr', value: 1 }),
      L({ unit: 'px', value: 300 }),
      'a',
      'b',
      600,
      400,
      1000
    )
    expect(u.a).toBeUndefined()
    expect(u.b).toEqual({ unit: 'px', value: 400 })
  })

  it('pct side converts px → % of container', () => {
    const u = applyBoundaryResize(
      L({ unit: 'pct', value: 30 }),
      L({ unit: 'px', value: 300 }),
      'a',
      'b',
      250,
      750,
      1000
    )
    expect(u.a).toEqual({ unit: 'pct', value: expect.closeTo(25) })
    expect(u.b).toEqual({ unit: 'px', value: 750 })
  })
})

describe('planPanelStrip', () => {
  const R = (leftKeys: string[], rightKeys: string[], gapPx = 0): ResolvedLayout => ({
    widths: {},
    gapPx,
    overflow: false,
    leftKeys,
    rightKeys
  })

  it('both clusters: orders, spacer slot, boundary neighbor', () => {
    const p = planPanelStrip(R(['a', 'b'], ['c'], 99))
    expect(p.renderOrder).toEqual(['a', 'b', 'c'])
    expect(p.rightStart).toBe(2)
    expect(p.order).toEqual({ a: 0, b: 1, c: 3 }) // spacer reserves order 2
    expect(p.spacerOrder).toBe(2)
    expect(p.leftNeighbor).toEqual({ b: 'a', c: 'b' }) // c's handle spans the gap to last-left
    expect(p.gapPx).toBe(99)
  })

  it('all left: no spacer, no boundary', () => {
    const p = planPanelStrip(R(['a', 'b'], []))
    expect(p.spacerOrder).toBeNull()
    expect(p.leftNeighbor).toEqual({ b: 'a' })
    expect(p.order).toEqual({ a: 0, b: 1 })
  })

  it('all right: spacer at the left edge, first panel has no handle', () => {
    const p = planPanelStrip(R([], ['a', 'b']))
    expect(p.rightStart).toBe(0)
    expect(p.spacerOrder).toBe(0)
    expect(p.order).toEqual({ a: 1, b: 2 })
    expect(p.leftNeighbor).toEqual({ b: 'a' }) // a (first) has none
  })
})

describe('normalizeOverrides', () => {
  it('passes through the new shape and converts legacy kinds', () => {
    expect(
      normalizeOverrides({
        a: { unit: 'pct', value: 50 },
        b: { kind: 'fixed', px: 300 },
        c: { kind: 'flex', weight: 2 }
      })
    ).toEqual({
      a: { unit: 'pct', value: 50 },
      b: { unit: 'px', value: 300 },
      c: { unit: 'fr', value: 2 }
    })
  })

  it('returns {} for nullish/garbage', () => {
    expect(normalizeOverrides(null)).toEqual({})
    expect(normalizeOverrides('x')).toEqual({})
  })
})
