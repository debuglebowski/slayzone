// The layout strip resolves a Classic layout exactly like the legacy strip
// (`resolvePanels` over the visible panel ids), keeps a stable DOM order, and
// reduces a compact cell to the primary agent.
import { describe, expect, it } from 'vitest'
import type { PanelConfig, PanelSizes } from '@slayzone/task-contracts'
import {
  DEFAULT_PANEL_CONFIG,
  deriveLayoutFromLegacy,
  mergeInto,
  orderIdToTaskId,
  renameSlot,
  setSlotHidden,
  setTabHidden
} from '@slayzone/task-contracts'
import { planPanelStrip, resolvePanels } from '../usePanelSizes'
import { compactColumns, domOrderedColumns, isInTabStrip, resolveLayoutStrip } from './strip'

const config = (patch: Partial<PanelConfig> = {}): PanelConfig => ({
  ...structuredClone(DEFAULT_PANEL_CONFIG),
  ...patch
})

/** The legacy page: visible ids in config order → resolvePanels. */
function legacyStrip(
  cfg: PanelConfig,
  visibility: Record<string, boolean>,
  sizes: PanelSizes,
  width: number
) {
  const ids = (cfg.order ?? []).map(orderIdToTaskId).filter((id) => visibility[id])
  const resolved = resolvePanels(ids, cfg, sizes, width)
  return { resolved, plan: planPanelStrip(resolved) }
}

const CASES: {
  name: string
  cfg: PanelConfig
  vis: Record<string, boolean>
  sizes: PanelSizes
}[] = [
  { name: 'default', cfg: config(), vis: { terminal: true, settings: true }, sizes: {} },
  {
    name: 'everything',
    cfg: config(),
    vis: {
      terminal: true,
      browser: true,
      editor: true,
      artifacts: true,
      diff: true,
      settings: true,
      processes: true
    },
    sizes: {}
  },
  {
    name: 'overrides',
    cfg: config(),
    vis: { terminal: true, editor: true, settings: true },
    sizes: {
      terminal: { unit: 'fr', value: 2 },
      settings: { unit: 'pct', value: 30 },
      browser: { unit: 'px', value: 999 }
    }
  },
  {
    name: 'right-anchored',
    cfg: config({
      layout: {
        terminal: { unit: 'px', value: 300, align: 'left' },
        settings: { unit: 'px', value: 320, align: 'right' }
      }
    }),
    vis: { terminal: true, diff: true, settings: true },
    sizes: {}
  },
  {
    name: 'reordered',
    cfg: config({ order: ['settings', 'git', 'terminal', 'browser', 'editor'] }),
    vis: { terminal: true, browser: true, settings: true },
    sizes: {}
  }
]

describe('resolveLayoutStrip', () => {
  for (const c of CASES)
    for (const width of [1520, 988, 400])
      it(`matches the legacy strip: ${c.name} @ ${width}px`, () => {
        const layout = deriveLayoutFromLegacy(
          { panel_visibility: { ...c.vis }, panel_sizes: c.sizes },
          c.cfg
        )
        // deriveLayoutFromLegacy fills defaults (terminal/settings on) under the stored map.
        const vis = Object.fromEntries(layout.columns.map((col) => [col.id, !col.slots[0].hidden]))
        const strip = resolveLayoutStrip(layout, width)
        const legacy = legacyStrip(c.cfg, vis, c.sizes, width)
        expect(strip.resolved).toEqual(legacy.resolved)
        expect(strip.plan).toEqual(legacy.plan)
      })
})

describe('domOrderedColumns', () => {
  it('keeps the legacy fixed DOM order whatever the visual order', () => {
    const cfg = config({
      order: [
        'processes',
        'settings',
        'git',
        'web:b',
        'web:a',
        'artifacts',
        'editor',
        'browser',
        'terminal'
      ],
      webPanels: [
        { id: 'web:a', name: 'A', baseUrl: 'https://a.test' },
        { id: 'web:b', name: 'B', baseUrl: 'https://b.test' }
      ]
    })
    const all = Object.fromEntries(
      [
        'terminal',
        'browser',
        'editor',
        'artifacts',
        'diff',
        'settings',
        'processes',
        'web:a',
        'web:b'
      ].map((id) => [id, true])
    )
    const layout = deriveLayoutFromLegacy({ panel_visibility: all }, cfg)
    const ids = domOrderedColumns(layout, layout.columns, ['web:a', 'web:b']).map((c) => c.id)
    expect(ids.slice(0, 4)).toEqual(['terminal', 'browser', 'editor', 'artifacts'])
    expect(ids.slice(4, 6)).toEqual(['web:a', 'web:b'])
    expect(ids.slice(6)).toEqual(['diff', 'settings', 'processes'])
  })
})

describe('compactColumns', () => {
  it('is the agent column, shown even when hidden', () => {
    const layout = setSlotHidden(
      deriveLayoutFromLegacy({ panel_visibility: null }, config()),
      'terminal',
      true
    )
    const [col] = compactColumns(layout) ?? []
    expect(col.id).toBe('terminal')
    expect(col.slots).toHaveLength(1)
    expect(col.slots[0].hidden).toBeUndefined()
    expect(col.slots[0].tabs).toEqual([{ instanceId: 'terminal' }])
  })

  it('is null without a primary agent', () => {
    const layout = deriveLayoutFromLegacy({ panel_visibility: null }, config())
    expect(compactColumns({ ...layout, columns: [], instances: {} })).toBeNull()
  })
})

describe('isInTabStrip', () => {
  it('is true for shown tabs of a group with several shown tabs or a name', () => {
    const classic = deriveLayoutFromLegacy(
      { panel_visibility: { terminal: true, browser: true, settings: true } },
      config()
    )
    expect(isInTabStrip(classic, 'terminal')).toBe(false)
    const merged = mergeInto(classic, 'browser', 'terminal')
    expect(isInTabStrip(merged, 'terminal')).toBe(true)
    expect(isInTabStrip(merged, 'browser')).toBe(true)
    const oneShown = setTabHidden(merged, 'browser', true)
    expect(isInTabStrip(oneShown, 'terminal')).toBe(false)
    expect(isInTabStrip(oneShown, 'browser')).toBe(false)
    expect(isInTabStrip(renameSlot(oneShown, 'terminal', 'Work'), 'terminal')).toBe(true)
    expect(isInTabStrip(setSlotHidden(merged, 'terminal', true), 'terminal')).toBe(false)
    expect(isInTabStrip(merged, 'nope')).toBe(false)
  })
})
