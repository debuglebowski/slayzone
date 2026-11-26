/**
 * Pure layout ops (docs/plans/panel-model.md §1.1): every op returns a new object,
 * never mutates its input, bumps `rev`, and keeps the tree normalized.
 */
import { describe, expect, test } from 'vitest'
import type { LayoutColumn, PanelInstance, PanelKind, TaskLayout } from './types.js'
import { MAX_LAYOUT_COLUMNS } from './types.js'
import {
  addInstance,
  closeInstance,
  closeTab,
  hideTab,
  columnEffectiveLayout,
  findTab,
  isColumnVisible,
  isPrimaryInstance,
  legacyIdOf,
  mergeInto,
  moveColumn,
  moveSlot,
  moveTab,
  newInstanceId,
  normalizeLayout,
  pruneLayout,
  renameInstance,
  renameSlot,
  reorderTab,
  resizeColumns,
  resizeSlots,
  setActiveTab,
  setSlotHidden,
  setTabHidden,
  splitAt
} from './ops.js'

const KIND_OF: Record<string, PanelKind> = {
  terminal: 'agent',
  browser: 'browser',
  editor: 'editor',
  artifacts: 'artifacts',
  diff: 'git',
  settings: 'settings',
  processes: 'processes'
}

function inst(id: string): PanelInstance {
  const kind = KIND_OF[id] ?? (id.startsWith('web:') ? 'web' : (id.split(':')[0] as PanelKind))
  return { id, kind, settings: id.startsWith('web:') ? { panelId: id } : {} }
}

/** Columns given as `[[slotTabs, ...], ...]`; slot/column ids derive from the first tab. */
function layout(spec: string[][][]): TaskLayout {
  const instances: Record<string, PanelInstance> = {}
  const columns: LayoutColumn[] = spec.map((slots) => ({
    id: `c-${slots[0][0]}`,
    size: { unit: 'fr', value: 1 },
    slots: slots.map((tabs) => {
      for (const t of tabs) instances[t] = inst(t)
      return {
        id: `s-${tabs[0]}`,
        weight: 1,
        activeInstanceId: tabs[0],
        tabs: tabs.map((instanceId) => ({ instanceId }))
      }
    })
  }))
  return { v: 1, rev: 0, layoutId: 'classic', columns, instances }
}

/** Compact shape: tab ids per slot per column. */
function shape(l: TaskLayout): string[][][] {
  return l.columns.map((c) => c.slots.map((s) => s.tabs.map((t) => t.instanceId)))
}

let seq = 0
const ctx = { newId: () => (++seq).toString(16).padStart(8, '0') }

function frozen<T>(v: T): T {
  return structuredClone(v)
}

describe('identity', () => {
  test('primary instances keep their legacy id', () => {
    expect(isPrimaryInstance(inst('terminal'))).toBe(true)
    expect(legacyIdOf(inst('diff'))).toBe('diff')
    expect(legacyIdOf(inst('web:figma'))).toBe('web:figma')
    expect(legacyIdOf({ id: 'agent:abcd1234', kind: 'agent', settings: {} })).toBeNull()
    expect(
      legacyIdOf({ id: 'web:abcd1234', kind: 'web', settings: { panelId: 'web:figma' } })
    ).toBeNull()
    // A legacy id on the wrong kind is not a primary.
    expect(legacyIdOf({ id: 'terminal', kind: 'terminal', settings: {} })).toBeNull()
  })

  test('newInstanceId: first of a kind gets the legacy id, later ones <kind>:<uuid8>', () => {
    const empty = layout([])
    expect(newInstanceId(empty, 'agent')).toBe('terminal')
    expect(newInstanceId(empty, 'git')).toBe('diff')
    expect(newInstanceId(empty, 'web', { panelId: 'web:figma' })).toBe('web:figma')
    const l = layout([[['terminal', 'diff', 'web:figma']]])
    expect(newInstanceId(l, 'agent')).toMatch(/^agent:[0-9a-f]{8}$/)
    expect(newInstanceId(l, 'git')).toMatch(/^git:[0-9a-f]{8}$/)
    expect(newInstanceId(l, 'web', { panelId: 'web:figma' })).toMatch(/^web:[0-9a-f]{8}$/)
    // Kinds without a legacy id never take a bare name (`terminal` belongs to agent).
    expect(newInstanceId(empty, 'terminal')).toMatch(/^terminal:[0-9a-f]{8}$/)
    expect(newInstanceId(empty, 'description')).toMatch(/^description:[0-9a-f]{8}$/)
  })
})

describe('moveTab / mergeInto / reorderTab', () => {
  test('mergeInto moves a tab into another slot at an index, activates it, prunes the source', () => {
    const before = layout([[['terminal']], [['browser', 'editor']]])
    const snap = frozen(before)
    const after = mergeInto(before, 'terminal', 's-browser', 1)
    expect(before).toEqual(snap)
    expect(shape(after)).toEqual([[['browser', 'terminal', 'editor']]])
    expect(after.columns[0].slots[0].activeInstanceId).toBe('terminal')
    expect(after.rev).toBe(1)
  })

  test('mergeInto defaults to the end; same slot = reorder', () => {
    const l = layout([[['terminal', 'browser', 'editor']]])
    expect(shape(mergeInto(l, 'terminal', 's-terminal'))).toEqual([
      [['browser', 'editor', 'terminal']]
    ])
  })

  test('moving the active tab out picks a neighbour as active', () => {
    const l = layout([[['terminal', 'browser']], [['editor']]])
    const after = mergeInto(l, 'terminal', 's-editor')
    expect(after.columns[0].slots[0].activeInstanceId).toBe('browser')
  })

  test('moveTab dispatches merge and split targets', () => {
    const l = layout([[['terminal', 'browser']]])
    expect(shape(moveTab(l, 'browser', { type: 'merge', slotId: 's-terminal', index: 0 }))).toEqual(
      [[['browser', 'terminal']]]
    )
    expect(
      shape(moveTab(l, 'browser', { type: 'split', slotId: 's-terminal', zone: 'left' }))
    ).toEqual([[['browser']], [['terminal']]])
  })

  test('reorderTab moves within its slot, clamping the index', () => {
    const l = layout([[['terminal', 'browser', 'editor']]])
    expect(shape(reorderTab(l, 'editor', 0))).toEqual([[['editor', 'terminal', 'browser']]])
    expect(shape(reorderTab(l, 'terminal', 99))).toEqual([[['browser', 'editor', 'terminal']]])
    expect(reorderTab(l, 'terminal', 99).rev).toBe(1)
  })

  test('unknown ids leave the layout unchanged but still return a new object', () => {
    const l = layout([[['terminal']]])
    const after = mergeInto(l, 'nope', 's-terminal')
    expect(shape(after)).toEqual(shape(l))
    expect(after).not.toBe(l)
  })
})

describe('splitAt', () => {
  test('left/right create a column beside the target column', () => {
    const l = layout([[['terminal', 'browser']], [['editor']]])
    expect(shape(splitAt(l, 'browser', 's-editor', 'right', ctx))).toEqual([
      [['terminal']],
      [['editor']],
      [['browser']]
    ])
    expect(shape(splitAt(l, 'browser', 's-editor', 'left', ctx))).toEqual([
      [['terminal']],
      [['browser']],
      [['editor']]
    ])
  })

  test('before/after stack a slot in the target column, halving its weight', () => {
    const l = layout([[['terminal', 'browser']], [['editor']]])
    const after = splitAt(l, 'browser', 's-editor', 'before', ctx)
    expect(shape(after)).toEqual([[['terminal']], [['browser'], ['editor']]])
    expect(after.columns[1].slots.map((s) => s.weight)).toEqual([0.5, 0.5])
    expect(shape(splitAt(l, 'browser', 's-editor', 'after', ctx))).toEqual([
      [['terminal']],
      [['editor'], ['browser']]
    ])
  })

  test('splitting a lone tab off its own slot edge keeps a valid tree', () => {
    const l = layout([[['terminal']], [['editor']]])
    expect(shape(splitAt(l, 'terminal', 's-terminal', 'right', ctx))).toEqual([
      [['terminal']],
      [['editor']]
    ])
    expect(shape(splitAt(l, 'terminal', 's-editor', 'right', ctx))).toEqual([
      [['editor']],
      [['terminal']]
    ])
  })

  test('new column gets the moved kind default size', () => {
    const l = layout([[['terminal', 'settings']]])
    const after = splitAt(l, 'settings', 's-terminal', 'right', ctx)
    expect(after.columns[1].size).toMatchObject({ unit: 'px', value: 440 })
  })

  test(`left/right beyond ${MAX_LAYOUT_COLUMNS} columns fall back to before/after`, () => {
    const rest = ['browser', 'editor', 'artifacts', 'diff', 'settings', 'processes', 'web:a']
    const withExtra = layout([[['terminal', 'web:x']], ...rest.map((id) => [[id]])])
    expect(withExtra.columns).toHaveLength(8)
    const right = splitAt(withExtra, 'web:x', 's-editor', 'right', ctx)
    expect(right.columns).toHaveLength(8)
    expect(shape(right)[2]).toEqual([['editor'], ['web:x']])
    const left = splitAt(withExtra, 'web:x', 's-editor', 'left', ctx)
    expect(shape(left)[2]).toEqual([['web:x'], ['editor']])
  })

  test('a split that frees its own column may still go sideways at the limit', () => {
    const ids = [
      'terminal',
      'browser',
      'editor',
      'artifacts',
      'diff',
      'settings',
      'processes',
      'web:a'
    ]
    const l = layout(ids.map((id) => [[id]]))
    const after = splitAt(l, 'web:a', 's-terminal', 'left', ctx)
    expect(after.columns).toHaveLength(8)
    expect(shape(after)[0]).toEqual([['web:a']])
  })
})

describe('hide / show keeps position', () => {
  test('setSlotHidden keeps the slot in place; showing clears the column override', () => {
    const l0 = layout([[['terminal']], [['browser']], [['editor']]])
    const l = resizeColumns(l0, { 'c-browser': { unit: 'px', value: 321 } })
    const hidden = setSlotHidden(l, 's-browser', true)
    expect(shape(hidden)).toEqual(shape(l))
    expect(hidden.columns[1].slots[0].hidden).toBe(true)
    expect(isColumnVisible(hidden.columns[1])).toBe(false)
    expect(hidden.columns[1].sizeOverride).toEqual({ unit: 'px', value: 321 })
    const shown = setSlotHidden(hidden, 's-browser', false)
    expect(shown.columns[1].slots[0].hidden).toBeUndefined()
    expect(shown.columns[1].sizeOverride).toBeUndefined()
    expect(shown.rev).toBe(l.rev + 2)
  })

  test('showing an already visible slot keeps its override', () => {
    const l = resizeColumns(layout([[['terminal']]]), { 'c-terminal': { unit: 'fr', value: 2 } })
    expect(setSlotHidden(l, 's-terminal', false).columns[0].sizeOverride).toEqual({
      unit: 'fr',
      value: 2
    })
  })

  test('setTabHidden keeps the tab in place and moves the active tab to a visible one', () => {
    const l = layout([[['terminal', 'browser', 'editor']]])
    const hidden = setTabHidden(l, 'terminal', true)
    expect(shape(hidden)).toEqual(shape(l))
    expect(hidden.columns[0].slots[0].tabs[0].hidden).toBe(true)
    expect(hidden.columns[0].slots[0].activeInstanceId).toBe('browser')
    const shown = setTabHidden(hidden, 'terminal', false)
    expect(shown.columns[0].slots[0].tabs[0].hidden).toBeUndefined()
    expect(shown.columns[0].slots[0].activeInstanceId).toBe('terminal')
  })

  test('a slot whose tabs are all hidden makes no column visible', () => {
    const l = setTabHidden(layout([[['terminal']]]), 'terminal', true)
    expect(isColumnVisible(l.columns[0])).toBe(false)
    expect(shape(l)).toEqual([[['terminal']]])
  })

  test('setActiveTab activates a tab and unhides it', () => {
    const l = setTabHidden(layout([[['terminal', 'browser']]]), 'browser', true)
    const after = setActiveTab(l, 'browser')
    expect(after.columns[0].slots[0].activeInstanceId).toBe('browser')
    expect(after.columns[0].slots[0].tabs[1].hidden).toBeUndefined()
  })
})

describe('closeInstance', () => {
  test('removes the tab and instance and prunes empty slots/columns', () => {
    const l = layout([[['terminal']], [['browser'], ['editor', 'diff']]])
    const a = closeInstance(l, 'browser')
    expect(shape(a)).toEqual([[['terminal']], [['editor', 'diff']]])
    expect(a.instances.browser).toBeUndefined()
    const b = closeInstance(a, 'terminal')
    expect(shape(b)).toEqual([[['editor', 'diff']]])
    const c = closeInstance(b, 'editor')
    expect(c.columns[0].slots[0].activeInstanceId).toBe('diff')
  })
})

describe('renameSlot / resize', () => {
  test('renameSlot sets and clears (blank = unnamed)', () => {
    const l = layout([[['terminal']]])
    const named = renameSlot(l, 's-terminal', '  Agents  ')
    expect(named.columns[0].slots[0].name).toBe('Agents')
    expect(renameSlot(named, 's-terminal', '   ').columns[0].slots[0].name).toBeUndefined()
    expect(renameSlot(named, 's-terminal', undefined).columns[0].slots[0].name).toBeUndefined()
  })

  test('resizeColumns sets and clears size overrides; the effective layout mirrors effectiveLayout', () => {
    const l = layout([[['terminal']], [['browser']]])
    l.columns[0].size = { unit: 'fr', value: 1, min: { unit: 'px', value: 200 }, align: 'left' }
    const a = resizeColumns(l, {
      'c-terminal': { unit: 'px', value: 500 },
      'c-browser': { unit: 'fr', value: 2 }
    })
    expect(a.columns[0].sizeOverride).toEqual({ unit: 'px', value: 500 })
    expect(columnEffectiveLayout(a.columns[0])).toEqual({
      unit: 'px',
      value: 500,
      min: { unit: 'px', value: 200 },
      align: 'left'
    })
    const b = resizeColumns(a, { 'c-terminal': null })
    expect(b.columns[0].sizeOverride).toBeUndefined()
    expect(columnEffectiveLayout(b.columns[0])).toEqual(l.columns[0].size)
  })

  test('resizeColumns ignores invalid sizes', () => {
    const l = layout([[['terminal']]])
    const a = resizeColumns(l, { 'c-terminal': { unit: 'px', value: Number.NaN } })
    expect(a.columns[0].sizeOverride).toBeUndefined()
  })

  test('resizeSlots sets positive finite weights only', () => {
    const l = layout([[['terminal'], ['browser'], ['editor']]])
    const a = resizeSlots(l, 'c-terminal', {
      's-terminal': 3,
      's-browser': -1,
      's-editor': Number.POSITIVE_INFINITY
    })
    expect(a.columns[0].slots.map((s) => s.weight)).toEqual([3, 1, 1])
  })
})

describe('addInstance', () => {
  test('as a tab, a column and a split; ids follow the primary rule', () => {
    const l = layout([[['terminal']]])
    const a = addInstance(l, 'browser', { type: 'tab', slotId: 's-terminal', index: 0 }, ctx)
    expect(a.instanceId).toBe('browser')
    expect(shape(a.layout)).toEqual([[['browser', 'terminal']]])
    expect(a.layout.columns[0].slots[0].activeInstanceId).toBe('browser')
    expect(a.layout.instances.browser).toEqual({ id: 'browser', kind: 'browser', settings: {} })

    const b = addInstance(a.layout, 'agent', { type: 'column', index: 0 }, ctx)
    expect(b.instanceId).toMatch(/^agent:[0-9a-f]{8}$/)
    expect(shape(b.layout)[0]).toEqual([[b.instanceId]])
    expect(b.layout.columns[0].size).toMatchObject({ unit: 'fr', value: 1 })

    const c = addInstance(
      b.layout,
      'settings',
      { type: 'split', slotId: 's-terminal', zone: 'after' },
      ctx
    )
    expect(c.instanceId).toBe('settings')
    expect(shape(c.layout)[1]).toEqual([['browser', 'terminal'], ['settings']])
    expect(c.layout.rev).toBe(3)
  })

  test('validates settings per kind and keeps unknown keys', () => {
    const l = layout([])
    const a = addInstance(
      l,
      'web',
      { type: 'column' },
      { settings: { panelId: 'web:figma', extra: 1 }, name: 'Fig' }
    )
    expect(a.instanceId).toBe('web:figma')
    expect(a.layout.instances['web:figma']).toEqual({
      id: 'web:figma',
      kind: 'web',
      name: 'Fig',
      settings: { panelId: 'web:figma', extra: 1 }
    })
  })

  test('an explicit id wins when unused', () => {
    const a = addInstance(layout([]), 'git', { type: 'column' }, { id: 'git:cafe0001' })
    expect(a.instanceId).toBe('git:cafe0001')
  })

  test('a column beyond the limit becomes a slot in the last column', () => {
    const ids = [
      'terminal',
      'browser',
      'editor',
      'artifacts',
      'diff',
      'settings',
      'processes',
      'web:a'
    ]
    const l = layout(ids.map((id) => [[id]]))
    const a = addInstance(l, 'agent', { type: 'column', index: 0 }, ctx)
    expect(a.layout.columns).toHaveLength(8)
    expect(shape(a.layout)[7]).toEqual([['web:a'], [a.instanceId]])
  })

  test('an unknown slot target falls back to a new column', () => {
    const a = addInstance(layout([[['terminal']]]), 'editor', { type: 'tab', slotId: 'nope' }, ctx)
    expect(shape(a.layout)).toEqual([[['terminal']], [['editor']]])
  })
})

describe('prune / normalize', () => {
  test('prune drops empty slots and columns but keeps hidden ones', () => {
    const l = layout([[['terminal']], [['browser']]])
    l.columns.push({ id: 'empty', size: { unit: 'fr', value: 1 }, slots: [] })
    l.columns[0].slots.push({ id: 'empty-slot', weight: 1, activeInstanceId: null, tabs: [] })
    l.columns[1].slots[0].hidden = true
    const p = pruneLayout(l)
    expect(shape(p)).toEqual([[['terminal']], [['browser']]])
    expect(p.columns[1].slots[0].hidden).toBe(true)
    expect(p.rev).toBe(1)
  })

  test('normalize repairs dangling refs, duplicates, active tab and weights', () => {
    const l = layout([[['terminal', 'browser']], [['editor']]])
    const broken = structuredClone(l) as TaskLayout
    broken.columns[0].slots[0].tabs.push({ instanceId: 'ghost' }, { instanceId: 'terminal' })
    broken.columns[1].slots[0].tabs.push({ instanceId: 'browser' })
    broken.columns[0].slots[0].activeInstanceId = 'ghost'
    broken.columns[1].slots[0].weight = -3
    broken.columns[1].id = broken.columns[0].id
    broken.instances.orphan = { id: 'orphan', kind: 'editor', settings: {} }
    const n = normalizeLayout(broken)
    expect(shape(n)).toEqual([[['terminal', 'browser']], [['editor']]])
    expect(n.columns[0].slots[0].activeInstanceId).toBe('terminal')
    expect(n.columns[1].slots[0].weight).toBe(1)
    expect(new Set(n.columns.map((c) => c.id)).size).toBe(2)
    expect(n.instances.orphan).toBeUndefined()
    expect(n.instances.ghost).toBeUndefined()
    expect(n.rev).toBe(1)
  })

  test('normalize prefers a visible active tab', () => {
    const l = layout([[['terminal', 'browser']]])
    l.columns[0].slots[0].tabs[0].hidden = true
    expect(normalizeLayout(l).columns[0].slots[0].activeInstanceId).toBe('browser')
  })

  test('normalize does not cap columns (Classic may exceed the drag limit)', () => {
    const ids = Array.from({ length: 11 }, (_, i) => `web:p${i}`)
    expect(normalizeLayout(layout(ids.map((id) => [[id]]))).columns).toHaveLength(11)
  })

  test('findTab locates a tab', () => {
    const l = layout([[['terminal']], [['browser'], ['editor', 'diff']]])
    expect(findTab(l, 'diff')).toEqual({ columnIndex: 1, slotIndex: 1, tabIndex: 1 })
    expect(findTab(l, 'nope')).toBeNull()
  })
})

describe('moveSlot', () => {
  test('merge appends the whole group at an index and shows its active tab', () => {
    const l = layout([[['terminal']], [['browser', 'editor']], [['diff']]])
    l.columns[1].slots[0].activeInstanceId = 'editor'
    l.columns[1].slots[0].tabs[0].hidden = true
    const snap = frozen(l)
    const after = moveSlot(l, 's-browser', { type: 'merge', slotId: 's-terminal', index: 0 })
    expect(l).toEqual(snap)
    expect(shape(after)).toEqual([[['browser', 'editor', 'terminal']], [['diff']]])
    expect(after.columns[0].slots[0].activeInstanceId).toBe('editor')
    // Hidden tabs travel with their group, still hidden.
    expect(after.columns[0].slots[0].tabs[0]).toEqual({ instanceId: 'browser', hidden: true })
    expect(after.rev).toBe(1)
  })

  test('split moves the group as a column or a stacked slot, keeping its id and name', () => {
    const l = layout([[['terminal'], ['browser', 'editor']], [['diff']]])
    l.columns[0].slots[1].name = 'Web'
    const right = moveSlot(l, 's-browser', { type: 'split', slotId: 's-diff', zone: 'right' }, ctx)
    expect(shape(right)).toEqual([[['terminal']], [['diff']], [['browser', 'editor']]])
    expect(right.columns[2].slots[0]).toMatchObject({ id: 's-browser', name: 'Web', weight: 1 })
    const below = moveSlot(l, 's-browser', { type: 'split', slotId: 's-diff', zone: 'after' }, ctx)
    expect(shape(below)).toEqual([[['terminal']], [['diff'], ['browser', 'editor']]])
    expect(below.columns[1].slots.map((s) => s.weight)).toEqual([0.5, 0.5])
  })

  test('a group that empties its column lends the column size to the new one', () => {
    const l = layout([[['terminal']], [['settings']]])
    l.columns[1].size = { unit: 'px', value: 440 }
    const after = moveSlot(l, 's-settings', { type: 'split', slotId: 's-terminal', zone: 'left' })
    expect(shape(after)).toEqual([[['settings']], [['terminal']]])
    expect(after.columns[0].size).toMatchObject({ unit: 'px', value: 440 })
  })

  test('targets in the group itself and unknown ids change nothing', () => {
    const l = layout([[['terminal', 'browser']], [['diff']]])
    expect(shape(moveSlot(l, 's-terminal', { type: 'merge', slotId: 's-terminal' }))).toEqual(
      shape(l)
    )
    expect(
      shape(moveSlot(l, 's-terminal', { type: 'split', slotId: 's-terminal', zone: 'left' }))
    ).toEqual(shape(l))
    expect(shape(moveSlot(l, 'nope', { type: 'merge', slotId: 's-diff' }))).toEqual(shape(l))
  })

  test(`side splits beyond ${MAX_LAYOUT_COLUMNS} columns stack instead`, () => {
    const ids = ['browser', 'editor', 'artifacts', 'diff', 'settings', 'processes', 'web:a']
    const l = layout([[['terminal'], ['web:x']], ...ids.map((id) => [[id]])])
    const after = moveSlot(l, 's-web:x', { type: 'split', slotId: 's-diff', zone: 'right' })
    expect(after.columns).toHaveLength(8)
    expect(shape(after)[4]).toEqual([['diff'], ['web:x']])
  })
})

describe('moveColumn', () => {
  test('moves a whole column (stacked groups, hidden state, size) to an index', () => {
    const l = layout([[['terminal'], ['web:x']], [['browser']], [['diff']]])
    l.columns[0].slots[1].hidden = true
    l.columns[0].sizeOverride = { unit: 'px', value: 500 }
    const snap = frozen(l)
    const after = moveColumn(l, 'c-terminal', 2)
    expect(l).toEqual(snap)
    expect(shape(after)).toEqual([[['browser']], [['diff']], [['terminal'], ['web:x']]])
    expect(after.columns[2].slots[1].hidden).toBe(true)
    expect(after.columns[2].sizeOverride).toEqual({ unit: 'px', value: 500 })
    expect(after.rev).toBe(1)
    expect(shape(moveColumn(l, 'c-diff', 0))).toEqual([
      [['diff']],
      [['terminal'], ['web:x']],
      [['browser']]
    ])
  })

  test('clamps the index; unknown columns change nothing', () => {
    const l = layout([[['terminal']], [['browser']]])
    expect(shape(moveColumn(l, 'c-terminal', 99))).toEqual([[['browser']], [['terminal']]])
    expect(shape(moveColumn(l, 'c-browser', -3))).toEqual([[['browser']], [['terminal']]])
    expect(shape(moveColumn(l, 'nope', 0))).toEqual(shape(l))
  })
})

describe('hideTab / closeTab / renameInstance', () => {
  test('hideTab hides a tab among shown ones, else its whole group', () => {
    const l = layout([[['terminal', 'browser']], [['diff']]])
    const one = hideTab(l, 'browser')
    expect(one.columns[0].slots[0].tabs[1].hidden).toBe(true)
    expect(one.columns[0].slots[0].hidden).toBeUndefined()
    const last = hideTab(one, 'terminal')
    expect(last.columns[0].slots[0].hidden).toBe(true)
    // The group keeps its tabs as they were: showing it again shows `terminal`.
    expect(last.columns[0].slots[0].tabs[0].hidden).toBeUndefined()
    expect(isColumnVisible(last.columns[0])).toBe(false)
  })

  test('closeTab hides a primary instance and removes any other', () => {
    const l = layout([[['terminal', 'agent:abcd1234']], [['diff']]])
    const hidden = closeTab(l, 'terminal')
    expect(hidden.instances.terminal).toBeDefined()
    expect(hidden.columns[0].slots[0].tabs[0].hidden).toBe(true)
    const closed = closeTab(l, 'agent:abcd1234')
    expect(closed.instances['agent:abcd1234']).toBeUndefined()
    expect(shape(closed)).toEqual([[['terminal']], [['diff']]])
  })

  test('renameInstance sets and clears the tab name', () => {
    const l = layout([[['terminal']]])
    const named = renameInstance(l, 'terminal', '  Claude  ')
    expect(named.instances.terminal.name).toBe('Claude')
    expect(renameInstance(named, 'terminal', ' ').instances.terminal.name).toBeUndefined()
  })
})
