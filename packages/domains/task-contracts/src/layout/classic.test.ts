/**
 * Classic follows panel_config (docs/plans/panel-model.md §1.3): a Classic-shaped
 * layout re-reads order, enabled panels and default sizes from the config and
 * keeps only its own hidden flags and size overrides.
 */
import { describe, expect, test } from 'vitest'
import type { PanelConfig } from '../types.js'
import { DEFAULT_PANEL_CONFIG } from '../types.js'
import { isClassicShaped, reconcileClassicLayout } from './builtins.js'
import { deriveLayoutFromLegacy, projectToLegacy } from './legacy.js'
import { addInstance, isColumnVisible, renameSlot, resizeColumns, setSlotHidden } from './ops.js'

const config = (patch: Partial<PanelConfig> = {}): PanelConfig => ({
  ...structuredClone(DEFAULT_PANEL_CONFIG),
  ...patch
})

const visibleIds = (layout: { columns: { id: string; slots: { hidden?: boolean }[] }[] }) =>
  layout.columns.filter((c) => !c.slots[0].hidden).map((c) => c.id)

describe('isClassicShaped', () => {
  test('a derived layout is Classic-shaped, also after hide/show/resize', () => {
    let layout = deriveLayoutFromLegacy({ panel_visibility: null }, config())
    expect(isClassicShaped(layout)).toBe(true)
    layout = setSlotHidden(layout, 'browser', false)
    layout = resizeColumns(layout, { settings: { unit: 'px', value: 500 } })
    expect(isClassicShaped(layout)).toBe(true)
  })

  test('a named group, a second tab or another layout id is not', () => {
    const base = deriveLayoutFromLegacy({ panel_visibility: null }, config())
    expect(isClassicShaped(renameSlot(base, 'settings', 'Info'))).toBe(false)
    expect(
      isClassicShaped(
        addInstance(base, 'browser', { type: 'tab', slotId: 'settings' }, { newId: () => 'a1' })
          .layout
      )
    ).toBe(false)
    expect(isClassicShaped({ ...base, layoutId: 'focus' })).toBe(false)
  })
})

describe('reconcileClassicLayout', () => {
  test('follows a reordered panel_config, keeping visibility and overrides', () => {
    let layout = deriveLayoutFromLegacy(
      { panel_visibility: { terminal: true, browser: true, settings: true } },
      config()
    )
    layout = resizeColumns(layout, { settings: { unit: 'px', value: 600 } })
    const order = ['settings', ...(config().order ?? []).filter((id) => id !== 'settings')]
    const next = reconcileClassicLayout(layout, config({ order }))
    expect(next.columns[0].id).toBe('settings')
    expect(visibleIds(next)).toEqual(['settings', 'terminal', 'browser'])
    expect(next.columns[0].sizeOverride).toEqual({ unit: 'px', value: 600 })
    expect(next.rev).toBe(layout.rev)
    expect(projectToLegacy(next)).toEqual(projectToLegacy(layout))
  })

  test('takes default sizes from the config', () => {
    const layout = deriveLayoutFromLegacy({ panel_visibility: null }, config())
    const next = reconcileClassicLayout(
      layout,
      config({ layout: { settings: { unit: 'px', value: 320, align: 'right' } } })
    )
    expect(next.columns.find((c) => c.id === 'settings')?.size).toMatchObject({
      unit: 'px',
      value: 320,
      align: 'right'
    })
  })

  test('a disabled panel drops out while hidden and stays while shown', () => {
    const layout = deriveLayoutFromLegacy(
      { panel_visibility: { terminal: true, editor: true, browser: false } },
      config()
    )
    const disabled = config({
      viewEnabled: {
        ...config().viewEnabled,
        task: { ...config().viewEnabled?.task, editor: false, browser: false }
      }
    })
    const next = reconcileClassicLayout(layout, disabled)
    const ids = next.columns.map((c) => c.id)
    expect(ids).toContain('editor')
    expect(ids).not.toContain('browser')
    expect(next.columns.filter(isColumnVisible).map((c) => c.id)).toEqual(
      layout.columns.filter(isColumnVisible).map((c) => c.id)
    )
  })

  test('returns any non-Classic layout untouched', () => {
    const base = deriveLayoutFromLegacy({ panel_visibility: null }, config())
    const named = renameSlot(base, 'settings', 'Info')
    expect(reconcileClassicLayout(named, config())).toBe(named)
  })
})
