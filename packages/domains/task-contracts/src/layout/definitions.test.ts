/**
 * Layout definitions (docs/plans/panel-model.md step 10): switching a task between
 * definitions without losing live state (matching by kind, parking leftovers),
 * dirty detection, and the task_layouts setting's resolution and mutators.
 */
import { describe, expect, test } from 'vitest'
import type { PanelConfig } from '../types.js'
import { DEFAULT_PANEL_CONFIG } from '../types.js'
import {
  classicFromPanelConfig,
  layoutFromDefinition,
  type LayoutCapabilities
} from './builtins.js'
import {
  addUserLayout,
  definitionTreeOf,
  deleteLayouts,
  duplicateLayouts,
  isLayoutDirty,
  layoutAtShortcut,
  newTaskLayout,
  PARKED_SLOT_ID,
  renameLayout,
  reorderLayouts,
  resetBuiltinLayouts,
  resolveLayoutDefinitions,
  saveLayoutTree,
  setDefaultLayout,
  setLayoutsEnabled,
  shortcutPositionOf,
  switchLayout
} from './definitions.js'
import { deriveLayoutFromLegacy } from './legacy.js'
import {
  addInstance,
  findTab,
  parkedInstances,
  renameSlot,
  resizeColumns,
  resizeSlots,
  setSlotHidden,
  unparkInstance
} from './ops.js'
import { defaultTaskLayoutsSetting, parseTaskLayout, parseTaskLayoutsSetting } from './settings.js'
import type { LayoutDefinition, PanelInstance, TaskLayout } from './types.js'

const config: PanelConfig = structuredClone(DEFAULT_PANEL_CONFIG)
const caps: LayoutCapabilities = {
  kinds: [
    'agent',
    'terminal',
    'browser',
    'web',
    'editor',
    'artifacts',
    'git',
    'processes',
    'settings'
  ],
  multiInstance: true
}

function def(id: string, columns: [string, PanelInstance['kind']][][][]): LayoutDefinition {
  const instances: Record<string, PanelInstance> = {}
  return {
    id,
    name: id,
    builtin: false,
    enabled: true,
    columns: columns.map((slots, c) => ({
      id: `${id}c${c}`,
      size: { unit: 'fr', value: 1 },
      slots: slots.map((tabs, s) => {
        for (const [iid, kind] of tabs) instances[iid] = { id: iid, kind, settings: {} }
        return {
          id: `${id}c${c}s${s}`,
          weight: 1,
          activeInstanceId: tabs[0][0],
          tabs: tabs.map(([instanceId]) => ({ instanceId }))
        }
      })
    })),
    instances
  }
}

const ids = (l: TaskLayout) => Object.keys(l.instances).sort()
const noLive = { hasLiveState: () => false }
const allLive = { hasLiveState: () => true }

describe('switchLayout', () => {
  const classic = deriveLayoutFromLegacy({ panel_visibility: null, panel_sizes: null }, config)

  test('matches by kind in order and keeps ids (primary to primary first)', () => {
    let task: TaskLayout = layoutFromDefinition(def('a', [[[['terminal', 'agent']]]]))
    task = addInstance(
      task,
      'agent',
      { type: 'column' },
      {
        id: 'agent:live0001',
        settings: { terminalGroupIds: ['g1'] }
      }
    ).layout
    const target = def('two', [[[['agent:00000002', 'agent']]], [[['terminal', 'agent']]]])
    const { layout, parked, dropped, added } = switchLayout(task, target, noLive)
    expect(ids(layout)).toEqual(['agent:live0001', 'terminal'])
    // the primary keeps its place in the definition (exact id first)
    expect(layout.columns[1].slots[0].tabs[0].instanceId).toBe('terminal')
    expect(layout.columns[0].slots[0].tabs[0].instanceId).toBe('agent:live0001')
    // live settings travel with the instance
    expect(layout.instances['agent:live0001'].settings.terminalGroupIds).toEqual(['g1'])
    expect(layout.layoutId).toBe('two')
    expect(layout.rev).toBe(task.rev + 1)
    expect(parked).toEqual([])
    expect(dropped).toEqual([])
    expect(added).toEqual([])
  })

  test('leftovers with live state are parked as hidden tabs, the rest dropped', () => {
    let task = classic
    task = addInstance(
      task,
      'terminal',
      { type: 'column' },
      {
        id: 'terminal:live0001',
        settings: { terminalGroupIds: ['g1'] }
      }
    ).layout
    const focus = def('focus', [[[['terminal', 'agent']]]])
    const live = (i: PanelInstance) => i.id === 'terminal:live0001' || i.id === 'browser'
    const { layout, parked, dropped } = switchLayout(task, focus, { hasLiveState: live })
    expect(parked).toEqual(['browser', 'terminal:live0001'])
    expect(dropped.map((d) => d.id).sort()).toEqual(
      ['artifacts', 'diff', 'editor', 'processes', 'settings'].sort()
    )
    const slot = layout.columns.at(-1)?.slots.find((s) => s.id === PARKED_SLOT_ID)
    expect(slot?.hidden).toBe(true)
    expect(slot?.tabs.every((t) => t.hidden && t.parked)).toBe(true)
    expect(parkedInstances(layout).map((i) => i.id)).toEqual(['browser', 'terminal:live0001'])
    // a parked instance keeps its live settings
    expect(layout.instances['terminal:live0001'].settings.terminalGroupIds).toEqual(['g1'])
  })

  test('switching back unparks matched instances into place', () => {
    const task = addInstance(
      classic,
      'terminal',
      { type: 'column' },
      {
        id: 'terminal:live0001',
        settings: { terminalGroupIds: ['g1'] }
      }
    ).layout
    const focus = def('focus', [[[['terminal', 'agent']]]])
    const parked = switchLayout(task, focus, allLive).layout
    const debug = def('debug', [[[['terminal', 'agent']], [['terminal:00000001', 'terminal']]]])
    const back = switchLayout(parked, debug, allLive)
    expect(back.layout.columns[0].slots[1].tabs[0]).toEqual({ instanceId: 'terminal:live0001' })
    expect(back.layout.instances['terminal:live0001'].settings.terminalGroupIds).toEqual(['g1'])
    expect(back.added).toEqual([])
  })

  test('unmatched definition instances are added with free ids', () => {
    const task = layoutFromDefinition(def('f', [[[['terminal', 'agent']]]]))
    let n = 0
    const target = def('t', [[[['terminal', 'agent']]], [[['terminal', 'agent']]]])
    // two instances with the same id cannot exist; give the second a fresh id
    target.columns[1].slots[0].tabs[0].instanceId = 'agent:00000002'
    target.instances['agent:00000002'] = { id: 'agent:00000002', kind: 'agent', settings: {} }
    const res = switchLayout(task, target, { ...noLive, newId: () => `id${++n}` })
    expect(res.added).toEqual(['agent:00000002'])
  })

  test('a Classic column keeps its legacy id when its instance maps', () => {
    const task = layoutFromDefinition(def('f', [[[['terminal', 'agent']]]]))
    const res = switchLayout(task, classicFromPanelConfig(config), noLive)
    expect(res.layout.columns.map((c) => c.id)).toContain('terminal')
    expect(findTab(res.layout, 'browser')).not.toBeNull()
  })

  test('unparkInstance moves a parked tab into a new shown column', () => {
    const task = addInstance(
      classic,
      'browser',
      { type: 'column' },
      { id: 'browser:b0000001' }
    ).layout
    const parked = switchLayout(task, def('focus', [[[['terminal', 'agent']]]]), allLive).layout
    const out = unparkInstance(parked, 'browser:b0000001')
    const loc = findTab(out, 'browser:b0000001')
    expect(loc).not.toBeNull()
    const slot = out.columns[loc?.columnIndex ?? 0].slots[loc?.slotIndex ?? 0]
    expect(slot.hidden).toBeUndefined()
    expect(slot.tabs[0]).toEqual({ instanceId: 'browser:b0000001' })
  })
})

describe('dirty detection', () => {
  const classicDef = classicFromPanelConfig(config)
  const task = layoutFromDefinition(classicDef)

  test('a freshly applied definition is clean', () => {
    expect(isLayoutDirty(task, classicDef)).toBe(false)
  })

  test('sizes (column overrides, slot weights) do not count', () => {
    const resized = resizeColumns(task, { terminal: { unit: 'px', value: 333 } })
    expect(isLayoutDirty(resized, classicDef)).toBe(false)
    const split = addInstance(task, 'terminal', {
      type: 'split',
      slotId: 'terminal',
      zone: 'after'
    }).layout
    const weighted = resizeSlots(split, 'terminal', { terminal: 3 })
    expect(isLayoutDirty(weighted, definitionTreeOf(split))).toBe(false)
  })

  test('structure, visibility and names count', () => {
    expect(isLayoutDirty(setSlotHidden(task, 'browser', false), classicDef)).toBe(true)
    expect(isLayoutDirty(renameSlot(task, 'terminal', 'Main'), classicDef)).toBe(true)
    expect(isLayoutDirty(addInstance(task, 'git', { type: 'column' }).layout, classicDef)).toBe(
      true
    )
  })

  test('live settings and parked tabs do not count', () => {
    const live = addInstance(
      task,
      'terminal',
      { type: 'column' },
      {
        settings: { terminalGroupIds: ['g1'] }
      }
    ).layout
    expect(isLayoutDirty(live, definitionTreeOf(live))).toBe(false)
  })

  test('no definition = changed', () => {
    expect(isLayoutDirty(task, null)).toBe(true)
  })
})

describe('task_layouts setting', () => {
  const base = defaultTaskLayoutsSetting()
  const resolve = (s = base) => resolveLayoutDefinitions(s, config, caps)

  test('built-ins in order, unavailable ones left out', () => {
    const defs = resolve()
    expect(defs[0].id).toBe('classic')
    expect(defs.some((d) => d.id === 'split-settings')).toBe(false)
    expect(defs.some((d) => d.id === 'two-agents')).toBe(true)
  })

  test('overrides apply: name, enabled, tree (edited)', () => {
    const s = parseTaskLayoutsSetting({
      v: 1,
      defaultLayoutId: 'classic',
      builtinOverrides: {
        focus: { name: 'Zen', enabled: false },
        classic: definitionTreeOf(def('x', [[[['terminal', 'agent']]]]))
      },
      user: [],
      order: []
    })
    const defs = resolve(s)
    const focus = defs.find((d) => d.id === 'focus')
    expect(focus?.name).toBe('Zen')
    expect(focus?.enabled).toBe(false)
    expect(defs[0].edited).toBe(true)
    expect(defs[0].columns).toHaveLength(1)
  })

  test('save as, rename, reorder, shortcut positions', () => {
    const tree = definitionTreeOf(def('x', [[[['terminal', 'agent']]]]))
    const added = addUserLayout(base, resolve(), 'Mine', tree, { id: 'layout:u1' })
    let s = added.setting
    expect(resolve(s).at(-1)?.id).toBe('layout:u1')
    s = renameLayout(s, 'layout:u1', 'Ours')
    expect(resolve(s).at(-1)?.name).toBe('Ours')
    s = reorderLayouts(s, resolve(s), ['layout:u1', 'classic'])
    const defs = resolve(s)
    expect(defs.slice(0, 2).map((d) => d.id)).toEqual(['layout:u1', 'classic'])
    expect(layoutAtShortcut(defs, 1)?.id).toBe('layout:u1')
    expect(shortcutPositionOf(defs, 'classic')).toBe(2)
    expect(layoutAtShortcut(defs, 10)).toBeNull()
  })

  test('disabled layouts get no shortcut position; at least one stays enabled', () => {
    const defs = resolve()
    const s = setLayoutsEnabled(base, defs, ['classic'], false)
    expect(s).not.toBeNull()
    const after = resolve(s ?? base)
    expect(shortcutPositionOf(after, 'classic')).toBeNull()
    expect(layoutAtShortcut(after, 1)?.id).toBe('focus')
    expect(
      setLayoutsEnabled(
        base,
        defs,
        defs.map((d) => d.id),
        false
      )
    ).toBeNull()
  })

  test('delete removes user layouts only and resets a deleted default', () => {
    const tree = definitionTreeOf(def('x', [[[['terminal', 'agent']]]]))
    let s = addUserLayout(base, resolve(), 'Mine', tree, { id: 'layout:u1' }).setting
    s = setDefaultLayout(s, 'layout:u1')
    s = deleteLayouts(s, ['layout:u1', 'classic'])
    expect(s.user).toEqual([])
    expect(s.defaultLayoutId).toBe('classic')
    expect(resolve(s)[0].id).toBe('classic')
  })

  test('duplicate copies after the original; reset drops a built-in edit', () => {
    let n = 0
    const dup = duplicateLayouts(base, resolve(), ['focus'], () => `d${++n}`)
    const defs = resolve(dup.setting)
    const at = defs.findIndex((d) => d.id === 'focus')
    expect(defs[at + 1].name).toBe('Focus copy')
    expect(defs[at + 1].builtin).toBe(false)
    const edited = saveLayoutTree(base, 'focus', definitionTreeOf(def('x', [[[['diff', 'git']]]])))
    expect(resolve(edited).find((d) => d.id === 'focus')?.edited).toBe(true)
    const reset = resetBuiltinLayouts(edited, ['focus'])
    expect(resolve(reset).find((d) => d.id === 'focus')?.edited).toBe(false)
    expect(reset.builtinOverrides.focus).toBeUndefined()
  })

  test('save over a user layout strips live settings and size overrides', () => {
    const tree = definitionTreeOf(def('x', [[[['terminal', 'agent']]]]))
    let s = addUserLayout(base, resolve(), 'Mine', tree, { id: 'layout:u1' }).setting
    let task = layoutFromDefinition(def('x', [[[['terminal', 'agent']]]]))
    task = addInstance(
      task,
      'terminal',
      { type: 'column' },
      {
        id: 'terminal:t1',
        settings: { terminalGroupIds: ['g'] }
      }
    ).layout
    task = resizeColumns(task, { [task.columns[0].id]: { unit: 'px', value: 10 } })
    s = saveLayoutTree(s, 'layout:u1', task)
    const saved = s.user[0]
    expect(saved.instances['terminal:t1'].settings).toEqual({})
    expect(saved.columns.every((c) => c.sizeOverride === undefined)).toBe(true)
    // survives a parse round trip
    expect(parseTaskLayoutsSetting(JSON.stringify(s)).user[0].columns).toHaveLength(2)
  })

  test('new tasks: Classic as shipped derives (null); any other default applies', () => {
    expect(newTaskLayout(base, config, caps)).toBeNull()
    const focus = newTaskLayout(setDefaultLayout(base, 'focus'), config, caps)
    expect(focus?.layoutId).toBe('focus')
    expect(focus?.rev).toBe(0)
    expect(Object.keys(focus?.instances ?? {})).toEqual(['terminal'])
    expect(newTaskLayout(setDefaultLayout(base, 'nope'), config, caps)).toBeNull()
  })

  test('a parked tab survives parsing, and is always hidden', () => {
    const task = layoutFromDefinition(
      def('x', [
        [
          [
            ['terminal', 'agent'],
            ['diff', 'git']
          ]
        ]
      ])
    )
    task.columns[0].slots[0].tabs[1] = { instanceId: 'diff', parked: true }
    const parsed = parseTaskLayout(JSON.stringify(task))
    expect(parsed?.columns[0].slots[0].tabs[1]).toEqual({
      instanceId: 'diff',
      hidden: true,
      parked: true
    })
  })
})
