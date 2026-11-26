import { describe, expect, test } from 'vitest'
import type { LayoutColumn, PanelInstance, PanelKind, TaskLayout } from '@slayzone/task-contracts'
import {
  applyDrop,
  dropPreview,
  sourceSlotId,
  stripIndexAt,
  targetKey,
  zoneAt,
  zoneOf,
  type DragItem
} from './layoutDnd'

const KIND_OF: Record<string, PanelKind> = {
  terminal: 'agent',
  browser: 'browser',
  editor: 'editor',
  diff: 'git',
  settings: 'settings'
}

/** Columns as `[[slotTabs, ...], ...]`; slot ids are `s-<first tab>`. */
function layout(spec: string[][][]): TaskLayout {
  const instances: Record<string, PanelInstance> = {}
  const columns: LayoutColumn[] = spec.map((slots) => ({
    id: `c-${slots[0][0]}`,
    size: { unit: 'fr', value: 1 },
    slots: slots.map((tabs) => {
      for (const t of tabs) instances[t] = { id: t, kind: KIND_OF[t], settings: {} }
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

function shape(l: TaskLayout | null): string[][][] | null {
  return l && l.columns.map((c) => c.slots.map((s) => s.tabs.map((t) => t.instanceId)))
}

const tab = (instanceId: string): DragItem => ({ type: 'tab', instanceId })
const group = (slotId: string): DragItem => ({ type: 'group', slotId })

describe('zone math', () => {
  test('edges: 20% left/right make columns, 30% top/bottom make slots, middle merges', () => {
    expect(zoneOf(0.1, 0.5)).toBe('left')
    expect(zoneOf(0.9, 0.5)).toBe('right')
    expect(zoneOf(0.5, 0.1)).toBe('before')
    expect(zoneOf(0.5, 0.9)).toBe('after')
    expect(zoneOf(0.5, 0.5)).toBe('merge')
    // Sides win over top/bottom in the corners.
    expect(zoneOf(0.1, 0.1)).toBe('left')
    expect(zoneOf(0.95, 0.95)).toBe('right')
    // Boundaries belong to the middle.
    expect(zoneOf(0.2, 0.5)).toBe('merge')
    expect(zoneOf(0.5, 0.3)).toBe('merge')
    expect(zoneOf(0.5, 0.7)).toBe('merge')
  })

  test('zoneAt measures against the rect; a zero-size rect merges', () => {
    const r = { left: 100, top: 50, width: 400, height: 200 }
    expect(zoneAt(r, 110, 150)).toBe('left')
    expect(zoneAt(r, 490, 150)).toBe('right')
    expect(zoneAt(r, 300, 60)).toBe('before')
    expect(zoneAt(r, 300, 240)).toBe('after')
    expect(zoneAt(r, 300, 150)).toBe('merge')
    expect(zoneAt({ left: 0, top: 0, width: 0, height: 0 }, 5, 5)).toBe('merge')
  })

  test('stripIndexAt inserts before the first tab whose midpoint is right of x', () => {
    const tabs = [
      { left: 0, width: 100 },
      { left: 100, width: 100 },
      { left: 200, width: 100 }
    ]
    expect(stripIndexAt(10, tabs)).toBe(0)
    expect(stripIndexAt(60, tabs)).toBe(1)
    expect(stripIndexAt(149, tabs)).toBe(1)
    expect(stripIndexAt(151, tabs)).toBe(2)
    expect(stripIndexAt(290, tabs)).toBe(3)
    expect(stripIndexAt(5, [])).toBe(0)
  })

  test('targetKey identifies a target', () => {
    expect(targetKey(null)).toBe('')
    expect(targetKey({ type: 'zone', slotId: 'a', zone: 'left' })).toBe('zone|a|left')
    expect(targetKey({ type: 'strip', slotId: 'a', index: 2 })).toBe('strip|a|2')
  })
})

describe('drag → op', () => {
  const l = layout([[['terminal']], [['browser', 'editor']], [['settings']]])

  test('sourceSlotId: a tab’s group, or the dragged group', () => {
    expect(sourceSlotId(l, tab('editor'))).toBe('s-browser')
    expect(sourceSlotId(l, group('s-settings'))).toBe('s-settings')
    expect(sourceSlotId(l, tab('nope'))).toBeNull()
  })

  test('a tab dropped on a group’s middle merges at its end', () => {
    const after = applyDrop(l, tab('editor'), { type: 'zone', slotId: 's-terminal', zone: 'merge' })
    expect(shape(after)).toEqual([[['terminal', 'editor']], [['browser']], [['settings']]])
    expect(after?.columns[0].slots[0].activeInstanceId).toBe('editor')
  })

  test('the four edges split: left/right a column, before/after a slot', () => {
    const at = (zone: 'left' | 'right' | 'before' | 'after') =>
      shape(applyDrop(l, tab('editor'), { type: 'zone', slotId: 's-settings', zone }))
    expect(at('left')).toEqual([[['terminal']], [['browser']], [['editor']], [['settings']]])
    expect(at('right')).toEqual([[['terminal']], [['browser']], [['settings']], [['editor']]])
    expect(at('before')).toEqual([[['terminal']], [['browser']], [['editor'], ['settings']]])
    expect(at('after')).toEqual([[['terminal']], [['browser']], [['settings'], ['editor']]])
  })

  test('a strip drop merges at the index; within the same strip it reorders', () => {
    expect(
      shape(applyDrop(l, tab('terminal'), { type: 'strip', slotId: 's-browser', index: 1 }))
    ).toEqual([[['browser', 'terminal', 'editor']], [['settings']]])
    expect(
      shape(applyDrop(l, tab('browser'), { type: 'strip', slotId: 's-browser', index: 2 }))
    ).toEqual([[['terminal']], [['editor', 'browser']], [['settings']]])
    expect(
      shape(applyDrop(l, tab('editor'), { type: 'strip', slotId: 's-browser', index: 0 }))
    ).toEqual([[['terminal']], [['editor', 'browser']], [['settings']]])
  })

  test('drops that change nothing return null', () => {
    // Onto its own place in its strip.
    expect(
      applyDrop(l, tab('browser'), { type: 'strip', slotId: 's-browser', index: 0 })
    ).toBeNull()
    expect(
      applyDrop(l, tab('browser'), { type: 'strip', slotId: 's-browser', index: 1 })
    ).toBeNull()
    // Onto its own group's middle.
    expect(
      applyDrop(l, tab('editor'), { type: 'zone', slotId: 's-browser', zone: 'merge' })
    ).toBeNull()
    // A lone tab onto its own group's edge.
    expect(
      applyDrop(l, tab('terminal'), { type: 'zone', slotId: 's-terminal', zone: 'right' })
    ).toBeNull()
    // A group onto itself.
    expect(
      applyDrop(l, group('s-browser'), { type: 'zone', slotId: 's-browser', zone: 'left' })
    ).toBeNull()
    expect(
      applyDrop(l, group('s-browser'), { type: 'strip', slotId: 's-browser', index: 0 })
    ).toBeNull()
    // Unknown target.
    expect(applyDrop(l, tab('editor'), { type: 'zone', slotId: 'nope', zone: 'merge' })).toBeNull()
  })

  test('a tab of a multi-tab group may split off its own group', () => {
    expect(
      shape(applyDrop(l, tab('editor'), { type: 'zone', slotId: 's-browser', zone: 'after' }))
    ).toEqual([[['terminal']], [['browser'], ['editor']], [['settings']]])
  })

  test('a dragged group merges whole or splits as a group', () => {
    expect(
      shape(applyDrop(l, group('s-browser'), { type: 'zone', slotId: 's-terminal', zone: 'merge' }))
    ).toEqual([[['terminal', 'browser', 'editor']], [['settings']]])
    expect(
      shape(applyDrop(l, group('s-browser'), { type: 'strip', slotId: 's-terminal', index: 0 }))
    ).toEqual([[['browser', 'editor', 'terminal']], [['settings']]])
    expect(
      shape(applyDrop(l, group('s-browser'), { type: 'zone', slotId: 's-settings', zone: 'after' }))
    ).toEqual([[['terminal']], [['settings'], ['browser', 'editor']]])
  })

  test('dropPreview mirrors the drop, and shows nothing for a no-op', () => {
    expect(dropPreview(l, tab('editor'), null)).toBeNull()
    expect(
      dropPreview(l, tab('editor'), { type: 'zone', slotId: 's-browser', zone: 'merge' })
    ).toBeNull()
    expect(
      dropPreview(l, tab('editor'), { type: 'zone', slotId: 's-terminal', zone: 'merge' })
    ).toEqual({ type: 'merge', slotId: 's-terminal' })
    expect(
      dropPreview(l, tab('editor'), { type: 'zone', slotId: 's-terminal', zone: 'before' })
    ).toEqual({ type: 'split', slotId: 's-terminal', zone: 'before' })
    expect(
      dropPreview(l, tab('terminal'), { type: 'strip', slotId: 's-browser', index: 2 })
    ).toEqual({ type: 'mark', slotId: 's-browser', index: 2 })
  })
})
