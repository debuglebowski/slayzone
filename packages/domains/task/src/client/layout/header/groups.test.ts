// Pins the title row's group toggles (docs/plans/panel-model.md step 9): one per tab
// group in layout order, named from contents unless renamed, hidden groups kept in
// place, and the layout's name.
import { describe, expect, it } from 'vitest'
import type { LayoutColumn, PanelInstance, PanelKind, TaskLayout } from '@slayzone/task-contracts'
import { columnMoveOf, groupNameOf, layoutGroups } from './groups'
import { availableBuiltinLayouts, currentLayoutName } from './LayoutMenu'

const KIND_OF: Record<string, PanelKind> = {
  terminal: 'agent',
  browser: 'browser',
  editor: 'editor',
  diff: 'git',
  settings: 'settings',
  processes: 'processes'
}

function inst(id: string): PanelInstance {
  const kind = KIND_OF[id] ?? (id.startsWith('web:') ? 'web' : (id.split(':')[0] as PanelKind))
  return { id, kind, settings: id.startsWith('web:') ? { panelId: id } : {} }
}

/** Columns as `[[slotTabs, ...], ...]`; column/slot ids are the first tab's (Classic-like). */
function layout(spec: string[][][]): TaskLayout {
  const instances: Record<string, PanelInstance> = {}
  const columns: LayoutColumn[] = spec.map((slots) => ({
    id: slots[0][0],
    size: { unit: 'fr', value: 1 },
    slots: slots.map((tabs) => {
      for (const t of tabs) instances[t] = inst(t)
      return {
        id: tabs[0],
        weight: 1,
        activeInstanceId: tabs[0],
        tabs: tabs.map((instanceId) => ({ instanceId }))
      }
    })
  }))
  return { v: 1, rev: 0, layoutId: 'classic', columns, instances }
}

const web = [{ id: 'web:docs', name: 'Docs' }]
const all = { webPanels: web, isTabListed: () => true }

describe('group names', () => {
  it('names a group from its tabs', () => {
    expect(groupNameOf(['Agent'])).toBe('Agent')
    expect(groupNameOf(['Browser', 'Editor'])).toBe('Browser + Editor')
    expect(groupNameOf(['Git', 'Git'])).toBe('Git ×2')
    expect(groupNameOf(['Agent', 'Browser', 'Git'])).toBe('Agent + 2 more')
    expect(groupNameOf(['Agent', 'Agent', 'Browser'])).toBe('Agent + Browser')
  })

  it('uses the group name, else the shown tabs, with instance and web panel names', () => {
    const l = layout([[['terminal']], [['browser', 'editor', 'web:docs']], [['diff']]])
    l.columns[1].slots[0].tabs[2].hidden = true
    l.instances.editor = { ...l.instances.editor, name: 'Scratch' }
    l.columns[2].slots[0].name = 'Review'
    const groups = layoutGroups(l, all)
    expect(groups.map((g) => g.name)).toEqual(['Agent', 'Browser + Scratch', 'Review'])
    expect(groups[2]).toMatchObject({ customName: 'Review', autoName: 'Git' })
    // Hidden tabs still belong to the group (Close closes them too).
    expect(groups[1].instanceIds).toEqual(['browser', 'editor', 'web:docs'])
  })
})

describe('group toggles', () => {
  it('one per group, left to right then top to bottom; hidden groups stay in place', () => {
    const l = layout([[['terminal'], ['browser']], [['diff']], [['settings']]])
    l.columns[1].slots[0].hidden = true
    const groups = layoutGroups(l, all)
    expect(groups.map((g) => [g.slotId, g.columnId, g.active])).toEqual([
      ['terminal', 'terminal', true],
      ['browser', 'terminal', true],
      ['diff', 'diff', false],
      ['settings', 'settings', true]
    ])
  })

  it('shows the active tab’s icon, else the first shown one', () => {
    const l = layout([[['browser', 'editor', 'diff']]])
    l.columns[0].slots[0].activeInstanceId = 'editor'
    expect(layoutGroups(l, all)[0].iconInstance.id).toBe('editor')
    l.columns[0].slots[0].tabs[1].hidden = true
    l.columns[0].slots[0].tabs[0].hidden = true
    expect(layoutGroups(l, all)[0].iconInstance.id).toBe('diff')
  })

  it('a group whose tabs are all hidden is inactive', () => {
    const l = layout([[['browser']]])
    l.columns[0].slots[0].tabs[0].hidden = true
    expect(layoutGroups(l, all)[0].active).toBe(false)
  })

  it('drops unlisted tabs and groups an excluded tab is in', () => {
    const l = layout([[['terminal', 'browser']], [['editor']], [['settings']]])
    const groups = layoutGroups(l, {
      webPanels: web,
      isTabListed: (i) => i.kind !== 'settings',
      // A secondary window never offers the agent.
      excludesGroup: (i) => i.kind === 'agent'
    })
    expect(groups.map((g) => g.slotId)).toEqual(['editor'])
  })

  it('a toggle dropped on another moves its column to that column’s place', () => {
    const l = layout([[['terminal'], ['browser']], [['diff']], [['settings']]])
    const groups = layoutGroups(l, all)
    expect(columnMoveOf(l, groups, 'browser', 'settings')).toEqual({
      columnId: 'terminal',
      toIndex: 2
    })
    expect(columnMoveOf(l, groups, 'settings', 'terminal')).toEqual({
      columnId: 'settings',
      toIndex: 0
    })
    expect(columnMoveOf(l, groups, 'browser', 'terminal')).toBeNull()
  })
})

describe('layout name', () => {
  it('Classic while Classic-shaped, else Custom', () => {
    const l = layout([[['terminal']], [['diff']]])
    expect(currentLayoutName(l)).toBe('Classic')
    l.columns[0].slots[0].name = 'Main'
    expect(currentLayoutName(l)).toBe('Custom')
    expect(currentLayoutName(layout([[['terminal', 'diff']]]))).toBe('Custom')
  })

  it('lists the built-ins the app can show', () => {
    const ids = (multiInstance: boolean) =>
      availableBuiltinLayouts({
        kinds: ['agent', 'browser', 'editor', 'git', 'terminal', 'processes'],
        multiInstance
      }).map((s) => s.id)
    expect(ids(false)).toEqual(['classic', 'focus', 'pair', 'review', 'debug'])
    expect(ids(true)).toContain('two-git')
  })
})
