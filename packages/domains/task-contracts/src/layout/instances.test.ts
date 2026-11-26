/**
 * Multiple instances of a kind (docs/plans/panel-model.md step 7): target
 * resolution, terminal group claims, panel_instance_state and browser_tabs.byPanel.
 */
import { describe, expect, test } from 'vitest'
import type { BrowserTab, BrowserTabsState } from '../browser-tabs.js'
import {
  browserInstanceOfTab,
  browserTabsForInstance,
  claimedTerminalGroupIds,
  instancesOfKind,
  isSecondaryInstance,
  patchInstanceState,
  removeBrowserInstanceTabs,
  resolveTargetInstance,
  setBrowserTabsForInstance,
  terminalInstanceOfGroup,
  withoutInstanceState
} from './instances.js'
import { addInstance, closeTab, updateInstanceSettings } from './ops.js'
import type { PanelInstance, TaskLayout } from './types.js'

function layout(instances: PanelInstance[], columns: string[][][]): TaskLayout {
  return {
    v: 1,
    rev: 0,
    layoutId: 'classic',
    instances: Object.fromEntries(instances.map((i) => [i.id, i])),
    columns: columns.map((slots, c) => ({
      id: `c${c}`,
      size: { unit: 'fr', value: 1 },
      slots: slots.map((tabs, s) => ({
        id: `c${c}s${s}`,
        weight: 1,
        activeInstanceId: tabs[0],
        tabs: tabs.map((instanceId) => ({ instanceId }))
      }))
    }))
  }
}

const git = (id: string): PanelInstance => ({ id, kind: 'git', settings: {} })
const agent = (id: string, groups?: string[]): PanelInstance => ({
  id,
  kind: 'agent',
  settings: groups ? { terminalGroupIds: groups } : {}
})

describe('instances of a kind', () => {
  const tree = layout(
    [git('diff'), git('git:aaaa1111'), agent('terminal')],
    [[['terminal']], [['git:aaaa1111'], ['diff']]]
  )

  test('instancesOfKind lists them in layout order', () => {
    expect(instancesOfKind(tree, 'git').map((i) => i.id)).toEqual(['git:aaaa1111', 'diff'])
  })

  test('the focused instance of the kind is the target, else the primary', () => {
    expect(resolveTargetInstance(tree, 'git', 'git:aaaa1111')).toBe('git:aaaa1111')
    expect(resolveTargetInstance(tree, 'git', null)).toBe('diff')
    // Focus on another kind, or on an instance no longer in the layout, falls back.
    expect(resolveTargetInstance(tree, 'git', 'terminal')).toBe('diff')
    expect(resolveTargetInstance(tree, 'git', 'git:gone0000')).toBe('diff')
  })

  test('the primary is the target even when the layout lacks it (showing adds it)', () => {
    expect(resolveTargetInstance(tree, 'browser', null)).toBe('browser')
  })

  test('a kind without a primary id targets its first instance', () => {
    const t = layout(
      [{ id: 'terminal:bbbb2222', kind: 'terminal', settings: {} }],
      [[['terminal:bbbb2222']]]
    )
    expect(resolveTargetInstance(t, 'terminal', null)).toBe('terminal:bbbb2222')
    expect(resolveTargetInstance(layout([], []), 'terminal', null)).toBeNull()
  })

  test('isSecondaryInstance', () => {
    expect(isSecondaryInstance(tree, 'diff')).toBe(false)
    expect(isSecondaryInstance(tree, 'git:aaaa1111')).toBe(true)
    expect(isSecondaryInstance(tree, 'nope')).toBe(false)
  })

  test('a new instance of a kind whose primary exists gets <kind>:<uuid8>; closing it removes it', () => {
    const { layout: added, instanceId } = addInstance(
      tree,
      'git',
      { type: 'tab', slotId: 'c1s1' },
      { newId: () => 'cccc3333' }
    )
    expect(instanceId).toBe('git:cccc3333')
    expect(added.columns[1].slots[1].tabs.map((t) => t.instanceId)).toEqual([
      'diff',
      'git:cccc3333'
    ])
    const closed = closeTab(added, instanceId)
    expect(closed.instances[instanceId]).toBeUndefined()
    // Closing the primary only hides it.
    const hidden = closeTab(added, 'diff')
    expect(hidden.instances.diff).toBeDefined()
  })
})

describe('terminal groups', () => {
  const tree = layout(
    [agent('terminal'), agent('agent:dddd4444', ['g1', 'g2'])],
    [[['terminal'], ['agent:dddd4444']]]
  )

  test('claims are every other instance’s terminalGroupIds', () => {
    expect(claimedTerminalGroupIds(tree, 'terminal')).toEqual(['g1', 'g2'])
    expect(claimedTerminalGroupIds(tree, 'agent:dddd4444')).toEqual([])
    expect(terminalInstanceOfGroup(tree, 'g2')).toBe('agent:dddd4444')
    expect(terminalInstanceOfGroup(tree, 'other')).toBeNull()
  })

  test('updateInstanceSettings merges, validates and bumps rev', () => {
    const next = updateInstanceSettings(tree, 'agent:dddd4444', {
      terminalGroupIds: ['g1', 'g2', 'g3']
    })
    expect(next.instances['agent:dddd4444'].settings.terminalGroupIds).toEqual(['g1', 'g2', 'g3'])
    expect(next.rev).toBe(tree.rev + 1)
    // An invalid value for a known key is dropped, not stored.
    const bad = updateInstanceSettings(tree, 'agent:dddd4444', { terminalGroupIds: 'g1' })
    expect(bad.instances['agent:dddd4444'].settings.terminalGroupIds).toBeUndefined()
    // Input untouched.
    expect(tree.instances['agent:dddd4444'].settings.terminalGroupIds).toEqual(['g1', 'g2'])
  })
})

describe('panel_instance_state', () => {
  test('patch merges per instance; undefined deletes; without drops the entry', () => {
    const a = patchInstanceState(null, 'editor:1', { editorOpenFiles: { files: ['a'] } })
    const b = patchInstanceState(a, 'git:2', { gitTab: 'changes' })
    const c = patchInstanceState(b, 'git:2', { gitTab: undefined, repoName: 'r' })
    expect(c).toEqual({ 'editor:1': { editorOpenFiles: { files: ['a'] } }, 'git:2': { repoName: 'r' } })
    expect(withoutInstanceState(c, 'git:2')).toEqual({
      'editor:1': { editorOpenFiles: { files: ['a'] } }
    })
    expect(a).toEqual({ 'editor:1': { editorOpenFiles: { files: ['a'] } } })
  })
})

describe('browser_tabs.byPanel', () => {
  const tab = (id: string): BrowserTab => ({ id, url: `https://${id}.test/`, title: id })
  const legacy: BrowserTabsState = { tabs: [tab('a'), tab('b')], activeTabId: 'b' }

  test('without byPanel the primary sees the stored state as it is', () => {
    expect(browserTabsForInstance(legacy, 'browser', true)).toEqual(legacy)
    expect(browserTabsForInstance(legacy, 'browser:x', false)).toEqual({
      tabs: [],
      activeTabId: null
    })
  })

  test('a secondary instance gets its own tabs in the same flat list', () => {
    const s = setBrowserTabsForInstance(legacy, 'browser:x', false, {
      tabs: [tab('c')],
      activeTabId: 'c'
    })
    expect(s.tabs.map((t) => t.id)).toEqual(['a', 'b', 'c'])
    expect(s.byPanel).toEqual({ 'browser:x': { tabIds: ['c'], activeTabId: 'c' } })
    expect(s.activeTabId).toBe('b')
    expect(browserTabsForInstance(s, 'browser', true)).toEqual(legacy)
    expect(browserTabsForInstance(s, 'browser:x', false)).toEqual({
      tabs: [tab('c')],
      activeTabId: 'c'
    })
    expect(browserInstanceOfTab(s, 'c')).toBe('browser:x')
    expect(browserInstanceOfTab(s, 'a')).toBeNull()
  })

  test('the primary editing its view keeps the other instance’s tabs', () => {
    const s = setBrowserTabsForInstance(legacy, 'browser:x', false, {
      tabs: [tab('c')],
      activeTabId: 'c'
    })
    const p = setBrowserTabsForInstance(s, 'browser', true, {
      tabs: [tab('a'), tab('d')],
      activeTabId: 'd'
    })
    expect(p.tabs.map((t) => t.id)).toEqual(['a', 'd', 'c'])
    expect(p.activeTabId).toBe('d')
    expect(p.byPanel?.['browser:x'].tabIds).toEqual(['c'])
  })

  test('a tab id one instance takes leaves the other’s list', () => {
    const s = setBrowserTabsForInstance(legacy, 'browser:x', false, {
      tabs: [tab('c'), tab('e')],
      activeTabId: 'e'
    })
    const p = setBrowserTabsForInstance(s, 'browser', true, {
      tabs: [tab('a'), tab('b'), tab('e')],
      activeTabId: 'e'
    })
    expect(p.byPanel?.['browser:x']).toEqual({ tabIds: ['c'], activeTabId: 'c' })
    expect(p.tabs.filter((t) => t.id === 'e')).toHaveLength(1)
  })

  test('removing an instance drops its tabs and entry', () => {
    const s = setBrowserTabsForInstance(legacy, 'browser:x', false, {
      tabs: [tab('c')],
      activeTabId: 'c'
    })
    expect(removeBrowserInstanceTabs(s, 'browser:x')).toEqual(legacy)
    expect(removeBrowserInstanceTabs(legacy, 'browser:x')).toBe(legacy)
  })
})
