/**
 * Layout changes from outside the task view (docs/plans/panel-model.md step 13):
 * the layout a task shows, live state, request settings, placement, show, replace.
 */
import { describe, expect, test } from 'vitest'
import { DEFAULT_PANEL_CONFIG } from '../types.js'
import { appendParkedTabs, PARKED_SLOT_ID } from './definitions.js'
import { deriveLayoutFromLegacy } from './legacy.js'
import { addInstance, findTab, hideTab, isInstanceVisible, setSlotHidden } from './ops.js'
import {
  agentMayChangeLayout,
  checkPanelSettings,
  currentTaskLayout,
  instanceHasLiveState,
  removedInstances,
  replaceTaskLayout,
  resolvePlacement,
  showInstance
} from './remote.js'
import { defaultTaskLayoutsSetting } from './settings.js'
import type { LayoutColumn, TaskLayout } from './types.js'

const ids = (() => {
  let n = 0
  return () => `id${String(++n).padStart(6, '0')}`
})()
const classic = (): TaskLayout => deriveLayoutFromLegacy({}, DEFAULT_PANEL_CONFIG)
const noLive = { browserTabs: null, editorOpenFiles: null, instanceState: null }

test('agent_may_change_layout: only "0" forbids', () => {
  expect(agentMayChangeLayout(undefined)).toBe(true)
  expect(agentMayChangeLayout('1')).toBe(true)
  expect(agentMayChangeLayout('0')).toBe(false)
})

describe('currentTaskLayout', () => {
  test('no stored layout: Classic from the legacy columns', () => {
    const layout = currentTaskLayout(
      { panel_visibility: { browser: true } },
      DEFAULT_PANEL_CONFIG,
      defaultTaskLayoutsSetting()
    )
    expect(isInstanceVisible(layout, 'browser')).toBe(true)
  })

  test('a stored layout wins over the legacy columns', () => {
    const stored = setSlotHidden(classic(), 'terminal', true)
    const layout = currentTaskLayout(
      { panel_layout: stored, panel_visibility: { terminal: true } },
      DEFAULT_PANEL_CONFIG,
      defaultTaskLayoutsSetting()
    )
    expect(isInstanceVisible(layout, 'terminal')).toBe(false)
    expect(layout.rev).toBe(stored.rev)
  })
})

describe('instanceHasLiveState', () => {
  test('the primary agent always; other agent panels with terminal groups', () => {
    expect(instanceHasLiveState({ id: 'terminal', kind: 'agent', settings: {} }, noLive)).toBe(true)
    expect(instanceHasLiveState({ id: 'agent:1', kind: 'agent', settings: {} }, noLive)).toBe(false)
    expect(
      instanceHasLiveState(
        { id: 'agent:1', kind: 'agent', settings: { terminalGroupIds: ['g'] } },
        noLive
      )
    ).toBe(true)
  })

  test('a browser with a page open; an editor with files', () => {
    const browserTabs = {
      tabs: [{ id: 't', url: 'https://x.test', title: 'x' }],
      activeTabId: 't'
    }
    expect(
      instanceHasLiveState(
        { id: 'browser', kind: 'browser', settings: {} },
        {
          ...noLive,
          browserTabs
        }
      )
    ).toBe(true)
    expect(
      instanceHasLiveState(
        { id: 'editor:1', kind: 'editor', settings: {} },
        {
          ...noLive,
          instanceState: {
            'editor:1': { editorOpenFiles: { files: ['a.ts'], activeFile: 'a.ts' } }
          }
        }
      )
    ).toBe(true)
    expect(instanceHasLiveState({ id: 'diff', kind: 'git', settings: {} }, noLive)).toBe(false)
  })
})

describe('checkPanelSettings', () => {
  test('strict per kind; live keys refused; web page URLs normalized', () => {
    expect(checkPanelSettings('artifact', { artifactId: 3 })).toMatchObject({ ok: false })
    expect(checkPanelSettings('terminal', { terminalGroupIds: [] })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/managed by SlayZone/)
    })
    expect(checkPanelSettings('web', { url: 'localhost:3000' })).toEqual({
      ok: true,
      settings: { url: 'http://localhost:3000/' }
    })
    expect(checkPanelSettings('web', { panelId: 'figma' })).toMatchObject({ ok: false })
    expect(checkPanelSettings('agent', { provider: 'codex', extra: 1 })).toEqual({
      ok: true,
      settings: { provider: 'codex', extra: 1 }
    })
  })

  test('null values (a patch deleting keys) pass through', () => {
    expect(checkPanelSettings('agent', { provider: null })).toEqual({
      ok: true,
      settings: { provider: null }
    })
  })
})

describe('resolvePlacement', () => {
  test('a slot id stays; a panel id becomes its group; unknown is null', () => {
    const layout = classic()
    expect(resolvePlacement(layout, { type: 'column' })).toEqual({ type: 'column' })
    expect(resolvePlacement(layout, { type: 'tab', slotId: 'browser' })).toEqual({
      type: 'tab',
      slotId: 'browser'
    })
    const { layout: withTab, instanceId } = addInstance(
      layout,
      'web',
      { type: 'tab', slotId: 'terminal' },
      { newId: ids }
    )
    expect(resolvePlacement(withTab, { type: 'split', slotId: instanceId, zone: 'right' })).toEqual(
      { type: 'split', slotId: 'terminal', zone: 'right' }
    )
    expect(resolvePlacement(withTab, { type: 'tab', slotId: 'nope' })).toBeNull()
  })
})

describe('showInstance', () => {
  test('shows a hidden group and makes the tab active', () => {
    const hidden = hideTab(classic(), 'terminal')
    expect(isInstanceVisible(hidden, 'terminal')).toBe(false)
    const shown = showInstance(hidden, 'terminal')
    expect(isInstanceVisible(shown, 'terminal')).toBe(true)
    expect(shown.rev).toBeGreaterThan(hidden.rev)
  })

  test('a parked instance comes back as a column', () => {
    const layout = classic()
    const columns: LayoutColumn[] = layout.columns.filter((c) => c.id !== 'diff')
    appendParkedTabs(columns, ['diff'])
    const parked = { ...layout, columns }
    const shown = showInstance(parked, 'diff')
    expect(isInstanceVisible(shown, 'diff')).toBe(true)
    const loc = findTab(shown, 'diff')
    expect(shown.columns[loc!.columnIndex].slots[loc!.slotIndex].id).not.toBe(PARKED_SLOT_ID)
  })
})

describe('replaceTaskLayout', () => {
  test('keeps terminal groups of kept instances, parks live leftovers, drops the rest', () => {
    const current: TaskLayout = {
      ...classic(),
      instances: {
        ...classic().instances,
        terminal: { id: 'terminal', kind: 'agent', settings: { terminalGroupIds: ['g1'] } }
      }
    }
    const next: TaskLayout = {
      v: 1,
      rev: 0,
      layoutId: 'mine',
      columns: [
        {
          id: 'c',
          size: { unit: 'fr', value: 1 },
          slots: [
            {
              id: 's',
              weight: 1,
              activeInstanceId: 'terminal',
              tabs: [{ instanceId: 'terminal' }]
            }
          ]
        }
      ],
      instances: { terminal: { id: 'terminal', kind: 'agent', settings: {} } }
    }
    const out = replaceTaskLayout(current, next, (inst) => inst.kind === 'browser')
    expect(out.layout.instances.terminal.settings.terminalGroupIds).toEqual(['g1'])
    expect(out.layout.rev).toBe(current.rev + 1)
    expect(out.parked).toEqual(['browser'])
    expect(out.dropped.map((i) => i.id)).toContain('settings')
    expect(removedInstances(current, out.layout).map((i) => i.id)).not.toContain('browser')
  })
})

test('appendParkedTabs joins an existing parked group', () => {
  const columns: LayoutColumn[] = []
  appendParkedTabs(columns, ['a'])
  appendParkedTabs(columns, ['b'])
  const slots = columns.flatMap((c) => c.slots)
  expect(slots).toHaveLength(1)
  expect(slots[0].tabs.map((t) => t.instanceId)).toEqual(['a', 'b'])
})
