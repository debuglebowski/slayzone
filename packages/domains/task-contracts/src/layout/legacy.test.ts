/**
 * Legacy adapters (docs/plans/panel-model.md §1.3–1.4): a layout derived from
 * `panel_visibility`/`panel_sizes` renders exactly what today's task page renders,
 * and projecting it back yields the same legacy columns.
 */
import { describe, expect, test } from 'vitest'
import type { PanelConfig, PanelSizes } from '../types.js'
import { DEFAULT_PANEL_CONFIG, PANEL_ORDER_IDS, orderIdToTaskId } from '../types.js'
import { mergePanelOrder } from '../panel-config.js'
import {
  DEFAULT_TASK_PANEL_VISIBILITY,
  applyLegacyWrite,
  deriveLayoutFromLegacy,
  projectToLegacy
} from './legacy.js'
import {
  closeInstance,
  columnEffectiveLayout,
  findTab,
  isColumnVisible,
  mergeInto,
  setTabHidden,
  splitAt
} from './ops.js'
import type { TaskLayout } from './types.js'

/** Today's resolvePanelVisibility (task/src/client/taskDetailCache.ts), verbatim semantics. */
function todayVisibility(
  task: { panel_visibility: Record<string, boolean> | null; is_temporary: boolean },
  secondaryWindow = false
): Record<string, boolean> {
  if (secondaryWindow)
    return {
      terminal: false,
      browser: false,
      diff: false,
      settings: false,
      editor: false,
      artifacts: false,
      processes: false
    }
  return {
    ...DEFAULT_TASK_PANEL_VISIBILITY,
    ...(task.panel_visibility ?? {}),
    ...(task.is_temporary ? { settings: false } : {})
  }
}

/** Today's visiblePanelOrder: config order (task ids) filtered by visibility. */
function todayVisibleOrder(config: PanelConfig, vis: Record<string, boolean>): string[] {
  return (mergePanelOrder(config).order ?? []).map(orderIdToTaskId).filter((id) => vis[id])
}

/** The layout's rendered column ids, in order. */
function visibleColumnIds(l: TaskLayout): string[] {
  return l.columns.filter(isColumnVisible).map((c) => c.id)
}

const TASK_IDS = PANEL_ORDER_IDS.map(orderIdToTaskId)

/** DEFAULT_PANEL_CONFIG with `patch`; `taskEnabled` merges into viewEnabled.task. */
function configWith(
  patch: Partial<PanelConfig> = {},
  taskEnabled: Record<string, boolean> = {}
): PanelConfig {
  const base = structuredClone(DEFAULT_PANEL_CONFIG)
  return {
    ...base,
    viewEnabled: { ...base.viewEnabled, task: { ...base.viewEnabled.task, ...taskEnabled } },
    ...patch
  }
}

/** Deterministic pseudo-random visibility combos (every builtin subset + web noise). */
function* visibilityCombos(): Generator<Record<string, boolean> | null> {
  yield null
  yield {}
  for (let mask = 0; mask < 1 << TASK_IDS.length; mask++) {
    const v: Record<string, boolean> = {}
    TASK_IDS.forEach((id, i) => {
      if (mask & (1 << i)) v[id] = true
      else if (mask % 3 === 0) v[id] = false
    })
    if (mask % 5 === 0) v['web:figma'] = true
    if (mask % 7 === 0) v['web:gone'] = true
    if (mask % 11 === 0) v.tests = true
    yield v
  }
}

describe('deriveLayoutFromLegacy', () => {
  test('a fresh task = Classic with terminal + settings visible, ids = legacy ids', () => {
    const l = deriveLayoutFromLegacy(
      { panel_visibility: null, panel_sizes: null, is_temporary: false },
      DEFAULT_PANEL_CONFIG
    )
    expect(l.v).toBe(1)
    expect(l.layoutId).toBe('classic')
    expect(l.columns.map((c) => c.id)).toEqual([
      'terminal',
      'browser',
      'editor',
      'artifacts',
      'diff',
      'settings',
      'processes'
    ])
    expect(visibleColumnIds(l)).toEqual(['terminal', 'settings'])
    expect(l.instances.terminal.kind).toBe('agent')
    expect(l.instances.diff.kind).toBe('git')
    for (const c of l.columns) expect(c.slots[0].tabs).toEqual([{ instanceId: c.id }])
  })

  test('sizes and align come from fallback ◀ panel_config.layout, overrides from panel_sizes', () => {
    const config = configWith({
      layout: {
        git: { unit: 'px', value: 300, min: 120 as never, align: 'right' },
        settings: { unit: 'pct', value: 30 }
      }
    })
    const l = deriveLayoutFromLegacy(
      {
        panel_visibility: { diff: true },
        panel_sizes: {
          diff: { unit: 'px', value: 410 },
          terminal: { kind: 'flex', weight: 2 }
        } as never,
        is_temporary: false
      },
      config
    )
    const diff = l.columns.find((c) => c.id === 'diff')!
    expect(diff.size).toEqual({
      unit: 'px',
      value: 300,
      min: { unit: 'px', value: 120 },
      align: 'right'
    })
    expect(diff.sizeOverride).toEqual({ unit: 'px', value: 410 })
    expect(columnEffectiveLayout(diff)).toMatchObject({ unit: 'px', value: 410, align: 'right' })
    const settings = l.columns.find((c) => c.id === 'settings')!
    expect(settings.size).toEqual({
      unit: 'pct',
      value: 30,
      min: { unit: 'px', value: 200 },
      align: 'left'
    })
    // Legacy {kind:'flex'} overrides are converted like normalizeOverrides does.
    expect(l.columns[0].sizeOverride).toEqual({ unit: 'fr', value: 2 })
  })

  test('temporary tasks force settings off; secondary windows start all hidden', () => {
    const task = {
      panel_visibility: { settings: true, browser: true },
      panel_sizes: null,
      is_temporary: true
    }
    expect(visibleColumnIds(deriveLayoutFromLegacy(task, DEFAULT_PANEL_CONFIG))).toEqual([
      'terminal',
      'browser'
    ])
    const secondary = deriveLayoutFromLegacy(task, DEFAULT_PANEL_CONFIG, { secondaryWindow: true })
    expect(visibleColumnIds(secondary)).toEqual([])
    expect(secondary.columns.length).toBeGreaterThan(0)
  })

  test('follows panel_config.order (git ↔ diff) and enabled web panels', () => {
    const config = configWith(
      { order: ['web:figma', 'git', 'terminal'] },
      { 'web:figma': true, editor: false }
    )
    const l = deriveLayoutFromLegacy(
      {
        panel_visibility: { 'web:figma': true, diff: true },
        panel_sizes: null,
        is_temporary: false
      },
      config
    )
    // mergePanelOrder appends missing ids; disabled+hidden panels get no column.
    expect(l.columns.map((c) => c.id).slice(0, 3)).toEqual(['web:figma', 'diff', 'terminal'])
    expect(l.columns.some((c) => c.id === 'editor')).toBe(false)
    expect(l.columns.some((c) => c.id === 'web:notion')).toBe(false)
    expect(l.instances['web:figma']).toEqual({
      id: 'web:figma',
      kind: 'web',
      settings: { panelId: 'web:figma' }
    })
    expect(visibleColumnIds(l)).toEqual(['web:figma', 'diff', 'terminal', 'settings'])
  })

  test('a disabled panel left visible still takes its place (today it stays in the strip)', () => {
    const config = configWith({}, { browser: false })
    const l = deriveLayoutFromLegacy(
      { panel_visibility: { browser: true }, panel_sizes: null, is_temporary: false },
      config
    )
    expect(visibleColumnIds(l)).toEqual(['terminal', 'browser', 'settings'])
  })

  test('tolerates a config without order or viewEnabled', () => {
    const l = deriveLayoutFromLegacy(
      { panel_visibility: { editor: true }, panel_sizes: 'garbage' as never, is_temporary: false },
      { webPanels: [] } as unknown as PanelConfig
    )
    expect(visibleColumnIds(l)).toEqual(['terminal', 'editor', 'settings'])
  })

  test('renders exactly what today renders, for every visibility combo', () => {
    const configs = [
      DEFAULT_PANEL_CONFIG,
      configWith({}, { 'web:figma': true, processes: false }),
      configWith({ order: [...(DEFAULT_PANEL_CONFIG.order ?? [])].reverse() })
    ]
    for (const config of configs)
      for (const panel_visibility of visibilityCombos())
        for (const is_temporary of [false, true])
          for (const secondaryWindow of [false, true]) {
            const task = { panel_visibility, panel_sizes: null, is_temporary }
            const l = deriveLayoutFromLegacy(task, config, { secondaryWindow })
            const vis = todayVisibility(task, secondaryWindow)
            expect(visibleColumnIds(l)).toEqual(todayVisibleOrder(config, vis))
          }
  })
})

describe('projectToLegacy', () => {
  test('derive ∘ project round-trips visibility and sizes', () => {
    const config = configWith({}, { 'web:figma': true, artifacts: false })
    const sizes: PanelSizes = {
      terminal: { unit: 'fr', value: 1.5 },
      settings: { unit: 'px', value: 512 },
      diff: { unit: 'pct', value: 25 }
    }
    let n = 0
    for (const panel_visibility of visibilityCombos())
      for (const is_temporary of [false, true]) {
        const task = { panel_visibility, panel_sizes: sizes, is_temporary }
        const l = deriveLayoutFromLegacy(task, config)
        const out = projectToLegacy(l)
        const vis = todayVisibility(task)
        const ordered = (mergePanelOrder(config).order ?? []).map(orderIdToTaskId)
        // Every builtin is reported exactly; web ids in the order read the same.
        for (const id of TASK_IDS) expect(out.panelVisibility[id]).toBe(vis[id])
        for (const id of ordered) expect(out.panelVisibility[id] ?? false).toBe(vis[id] ?? false)
        expect(out.panelSizes).toEqual(sizes)
        n++
      }
    expect(n).toBeGreaterThan(200)
  })

  test('keys the layout does not own are kept from the base, owned ones are overwritten', () => {
    const l = deriveLayoutFromLegacy(
      { panel_visibility: null, panel_sizes: null, is_temporary: false },
      DEFAULT_PANEL_CONFIG
    )
    const out = projectToLegacy(l, {
      panelVisibility: { tests: true, terminal: false, 'web:gone': true },
      panelSizes: { 'web:gone': { unit: 'px', value: 9 }, terminal: { unit: 'px', value: 1 } }
    })
    expect(out.panelVisibility).toMatchObject({ tests: true, terminal: true, 'web:gone': true })
    expect(out.panelSizes).toEqual({ 'web:gone': { unit: 'px', value: 9 } })
  })

  test('a primary sharing its column with another visible tab exposes no size', () => {
    const base = deriveLayoutFromLegacy(
      {
        panel_visibility: { browser: true },
        panel_sizes: { terminal: { unit: 'px', value: 700 } },
        is_temporary: false
      },
      DEFAULT_PANEL_CONFIG
    )
    const merged = splitAt(base, 'browser', 'terminal', 'after')
    expect(projectToLegacy(merged).panelSizes.terminal).toBeUndefined()
    expect(projectToLegacy(merged).panelVisibility.browser).toBe(true)
  })

  test('a hidden tab reads as hidden even when its slot is visible', () => {
    const base = deriveLayoutFromLegacy(
      { panel_visibility: null, panel_sizes: null, is_temporary: false },
      DEFAULT_PANEL_CONFIG
    )
    expect(projectToLegacy(setTabHidden(base, 'settings', true)).panelVisibility.settings).toBe(
      false
    )
  })
})

describe('applyLegacyWrite', () => {
  const fresh = () =>
    deriveLayoutFromLegacy(
      { panel_visibility: null, panel_sizes: null, is_temporary: false },
      DEFAULT_PANEL_CONFIG
    )

  test('visibility toggles slots in place and bumps rev once', () => {
    const l = fresh()
    const after = applyLegacyWrite(l, {
      panelVisibility: { ...DEFAULT_TASK_PANEL_VISIBILITY, browser: true, settings: false }
    })
    expect(visibleColumnIds(after)).toEqual(['terminal', 'browser'])
    expect(after.columns.map((c) => c.id)).toEqual(l.columns.map((c) => c.id))
    expect(after.rev).toBe(l.rev + 1)
  })

  test('a no-op write returns the same layout (nothing to persist)', () => {
    const l = fresh()
    expect(applyLegacyWrite(l, { panelVisibility: { terminal: true, tests: true } })).toBe(l)
    expect(applyLegacyWrite(l, {})).toBe(l)
  })

  test('sizes replace the overrides of owned columns', () => {
    const l = applyLegacyWrite(fresh(), {
      panelSizes: { terminal: { unit: 'px', value: 600 }, nope: { unit: 'px', value: 1 } }
    })
    expect(l.columns[0].sizeOverride).toEqual({ unit: 'px', value: 600 })
    const cleared = applyLegacyWrite(l, { panelSizes: {} })
    expect(cleared.columns[0].sizeOverride).toBeUndefined()
  })

  test('showing a panel the layout lacks adds it as a new column; unknown ids are ignored', () => {
    const l = closeInstance(fresh(), 'editor')
    const after = applyLegacyWrite(l, {
      panelVisibility: { editor: true, 'web:figma': true, tests: true }
    })
    expect(after.columns.slice(-2).map((c) => c.id)).toEqual(['editor', 'web:figma'])
    expect(after.instances['web:figma']).toEqual({
      id: 'web:figma',
      kind: 'web',
      settings: { panelId: 'web:figma' }
    })
    expect(projectToLegacy(after).panelVisibility).toMatchObject({
      editor: true,
      'web:figma': true
    })
    expect(after.instances.tests).toBeUndefined()
  })

  test('hiding a primary that shares its slot hides only its tab', () => {
    const tabbed = mergeInto(fresh(), 'browser', 'terminal', 1)
    expect(findTab(tabbed, 'browser')).toEqual({ columnIndex: 0, slotIndex: 0, tabIndex: 1 })
    const after = applyLegacyWrite(tabbed, { panelVisibility: { terminal: false } })
    const slot = after.columns[0].slots[0]
    expect(slot.hidden).toBeUndefined()
    expect(slot.tabs[0]).toEqual({ instanceId: 'terminal', hidden: true })
    expect(slot.activeInstanceId).toBe('browser')
    expect(projectToLegacy(after).panelVisibility).toMatchObject({ terminal: false, browser: true })
  })

  test('applyLegacyWrite ∘ project is a fixed point', () => {
    const l = fresh()
    const write = {
      panelVisibility: { ...DEFAULT_TASK_PANEL_VISIBILITY, diff: true, processes: true },
      panelSizes: { diff: { unit: 'fr', value: 2 } } as PanelSizes
    }
    const after = applyLegacyWrite(l, write)
    const out = projectToLegacy(after)
    expect(out.panelVisibility).toEqual(write.panelVisibility)
    expect(out.panelSizes).toEqual(write.panelSizes)
    expect(applyLegacyWrite(after, out)).toBe(after)
  })
})
