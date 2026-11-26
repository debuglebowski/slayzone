/**
 * Lens model: migrate / apply / dirty / save / reset, on the pure functions and on the
 * tab store that wires them to the live `tree*` fields.
 */
import { beforeEach, describe, expect, test } from 'vitest'
import { _setTrpcClientSingleton } from '@slayzone/transport/client'
import {
  builtinLens,
  defaultLenses,
  isLensDirty,
  isLensEdited,
  liveSpec,
  migrateLenses,
  parseLiveLensFields,
  resetLens,
  specEqual,
  specToLive,
  type Lens
} from './lenses.js'
import { DEFAULT_TREE_DISPLAY, parseTreeDisplay } from './tree-display.js'
import { useTabStore } from './useTabStore.js'

// `_loadState` arms the debounced view-state write; give it somewhere to go.
_setTrpcClientSingleton({ settings: { set: { mutate: async () => {} } } } as never)

const store = useTabStore
const lensById = (id: string): Lens => {
  const lens = store.getState().lenses.find((l) => l.id === id)
  if (!lens) throw new Error(`no lens ${id}`)
  return lens
}
const dirty = () => {
  const s = store.getState()
  return isLensDirty(s.lenses, s.activeLensId, s)
}

beforeEach(() => store.setState(store.getInitialState()))

describe('built-in lenses', () => {
  test('ship Today, Agent status, Task status, Recent and Accordion, in that order', () => {
    expect(defaultLenses().map((l) => l.name)).toEqual([
      'Today',
      'Agent status',
      'Task status',
      'Recent',
      'Accordion'
    ])
  })

  test("Today is the sidebar's pre-lens default", () => {
    const today = builtinLens('today')
    expect(today.spec).toMatchObject({ group: 'project', look: 'cards', projects: 'active' })
    expect(today.spec.display).toEqual(DEFAULT_TREE_DISPLAY)
  })

  test('the cross-project ones group by agent / status / recency across all projects', () => {
    expect(builtinLens('agent-status').spec).toMatchObject({ group: 'agent', projects: 'all' })
    expect(builtinLens('task-status').spec).toMatchObject({ group: 'status', projects: 'all' })
    expect(builtinLens('recent').spec).toMatchObject({ group: 'recent', projects: 'all' })
    expect(builtinLens('accordion').spec).toMatchObject({ group: 'project', look: 'accordion' })
  })
})

describe('spec equality', () => {
  test('filters compare as sets', () => {
    const a = builtinLens('today').spec
    const b = { ...a, display: { ...a.display, treePriorityFilter: [5, 4, 3, 2, 1] } }
    expect(specEqual(a, b)).toBe(true)
  })

  test('look only matters when grouping by project', () => {
    const a = builtinLens('agent-status').spec
    expect(specEqual(a, { ...a, look: 'dense' })).toBe(true)
    const t = builtinLens('today').spec
    expect(specEqual(t, { ...t, look: 'dense' })).toBe(false)
  })

  test('live fields round-trip', () => {
    const spec = builtinLens('recent').spec
    expect(specEqual(liveSpec(specToLive(spec)), spec)).toBe(true)
  })
})

describe('migration', () => {
  test("no saved lenses: the user's current tree settings become Today, active", () => {
    const legacy = parseLiveLensFields({
      treeStatusFilter: ['todo', 'review'],
      treeShowTags: true,
      treeGroupBy: 'priority',
      treeShowAllProjects: true
    })
    const { lenses, activeLensId } = migrateLenses({}, legacy)
    expect(activeLensId).toBe('today')
    const today = lenses.find((l) => l.id === 'today')!
    expect(today.spec.display.treeStatusFilter).toEqual(['todo', 'review'])
    expect(today.spec.display.treeShowTags).toBe(true)
    expect(today.spec.display.treeGroupBy).toBe('priority')
    expect(today.spec.projects).toBe('all')
    expect(lenses).toHaveLength(5)
  })

  test('legacy keys from older releases are read', () => {
    const d = parseTreeDisplay({ treeSubtaskMode: 'all', treeHideInactive: true })
    expect(d.treeShowSubtasks).toBe(true)
    expect(d.treeShowAllSubtasks).toBe(true)
    expect(d.treeShowOnlyActive).toBe(true)
    expect(parseTreeDisplay({ treeSubtaskMode: 'hide' }).treeShowSubtasks).toBe(false)
  })

  test('saved lenses: malformed and duplicate entries dropped, missing built-ins appended', () => {
    const mine = { ...builtinLens('today'), id: 'lens-1', name: 'Mine', builtin: null }
    const { lenses, activeLensId } = migrateLenses(
      { lenses: [mine, mine, { id: 3 }, null, builtinLens('recent')], activeLensId: 'lens-1' },
      parseLiveLensFields({})
    )
    expect(lenses.map((l) => l.id)).toEqual([
      'lens-1',
      'recent',
      'today',
      'agent-status',
      'task-status',
      'accordion'
    ])
    expect(activeLensId).toBe('lens-1')
  })

  test('an unknown active id falls back to the first visible lens', () => {
    const lenses = defaultLenses().map((l, i) => ({ ...l, hidden: i === 0 }))
    expect(
      migrateLenses({ lenses, activeLensId: 'gone' }, parseLiveLensFields({})).activeLensId
    ).toBe('agent-status')
  })

  test('the store migrates on load and leaves the live settings untouched', () => {
    store.getState()._loadState({
      tabs: [],
      activeTabIndex: 0,
      selectedProjectId: '',
      treeStatusFilter: ['todo'],
      treeShowTags: true
    })
    const s = store.getState()
    expect(s.activeLensId).toBe('today')
    expect(s.treeStatusFilter).toEqual(['todo'])
    expect(s.treeShowTags).toBe(true)
    expect(lensById('today').spec.display.treeStatusFilter).toEqual(['todo'])
    expect(dirty()).toBe(false)
  })

  test('saved lenses and live state survive a reload as they were, dirty included', () => {
    store.getState()._loadState({ tabs: [], activeTabIndex: 0, selectedProjectId: '' })
    store.getState().applyLens('task-status')
    store.getState().setTreeShowTags(true)
    const saved = JSON.parse(JSON.stringify(store.getState()))
    store.setState(store.getInitialState())
    store.getState()._loadState(saved)
    expect(store.getState().activeLensId).toBe('task-status')
    expect(store.getState().treeLensGroup).toBe('status')
    expect(store.getState().treeShowTags).toBe(true)
    expect(dirty()).toBe(true)
  })
})

describe('store: apply / dirty / save / revert', () => {
  beforeEach(() => {
    store.getState()._loadState({ tabs: [], activeTabIndex: 0, selectedProjectId: '' })
  })

  test('applying a lens writes the live fields', () => {
    store.getState().applyLens('task-status')
    const s = store.getState()
    expect(s.activeLensId).toBe('task-status')
    expect(s.treeLensGroup).toBe('status')
    expect(s.treeShowAllProjects).toBe(true)
    expect(s.treeStatusFilter).toEqual(builtinLens('task-status').spec.display.treeStatusFilter)
    expect(dirty()).toBe(false)
  })

  test('applyLensAt counts visible lenses only', () => {
    store.getState().setLensHidden('agent-status', true)
    store.getState().applyLensAt(1)
    expect(store.getState().activeLensId).toBe('task-status')
    store.getState().applyLensAt(42)
    expect(store.getState().activeLensId).toBe('task-status')
  })

  test('a live edit makes the active lens dirty; revert puts it back', () => {
    store.getState().setTreeShowTags(true)
    expect(dirty()).toBe(true)
    store.getState().revertActiveLens()
    expect(store.getState().treeShowTags).toBe(false)
    expect(dirty()).toBe(false)
  })

  test('More › Show all projects counts as an edit', () => {
    store.getState().setTreeShowAllProjects(true)
    expect(dirty()).toBe(true)
  })

  test('save writes live back into the active lens', () => {
    store.getState().setTreeShowTags(true)
    store.getState().setTreeLensLook('dense')
    store.getState().saveActiveLens()
    expect(dirty()).toBe(false)
    expect(lensById('today').spec.display.treeShowTags).toBe(true)
    expect(lensById('today').spec.look).toBe('dense')
    expect(isLensEdited(lensById('today'))).toBe(true)
  })

  test('save with a name renames too', () => {
    store.getState().saveActiveLens('Morning')
    expect(lensById('today').name).toBe('Morning')
  })

  test('save as new: a user lens from live, active; the old lens keeps its settings', () => {
    store.getState().setTreeNeedsYou(true)
    const id = store.getState().saveLensAs('Focus')
    expect(store.getState().activeLensId).toBe(id)
    expect(lensById(id)).toMatchObject({ name: 'Focus', builtin: null })
    expect(lensById(id).spec.needsYou).toBe(true)
    expect(lensById('today').spec.needsYou).toBe(false)
    expect(dirty()).toBe(false)
  })

  test('switching lenses drops unsaved edits', () => {
    store.getState().setTreeShowTags(true)
    store.getState().applyLens('recent')
    store.getState().applyLens('today')
    expect(store.getState().treeShowTags).toBe(false)
  })
})

describe('store: manage', () => {
  beforeEach(() => {
    store.getState()._loadState({ tabs: [], activeTabIndex: 0, selectedProjectId: '' })
  })

  test('reset puts an edited built-in back and re-applies it when active', () => {
    store.getState().setTreeShowTags(true)
    store.getState().saveActiveLens('Renamed')
    store.getState().resetLensToDefault('today')
    expect(lensById('today').name).toBe('Today')
    expect(isLensEdited(lensById('today'))).toBe(false)
    expect(store.getState().treeShowTags).toBe(false)
    expect(resetLens(lensById('today'))).toEqual(lensById('today'))
  })

  test('duplicate inserts a user copy after the original and applies it', () => {
    const id = store.getState().duplicateLens('recent')
    const ids = store.getState().lenses.map((l) => l.id)
    expect(ids.indexOf(id)).toBe(ids.indexOf('recent') + 1)
    expect(lensById(id)).toMatchObject({ name: 'Recent copy', builtin: null })
    expect(store.getState().activeLensId).toBe(id)
    expect(store.getState().treeLensGroup).toBe('recent')
    expect(store.getState().duplicateLens('recent')).not.toBe(id)
    expect(store.getState().lenses.some((l) => l.name === 'Recent copy 2')).toBe(true)
  })

  test('only user lenses delete; deleting the active one switches to the first visible', () => {
    store.getState().deleteLens('today')
    expect(store.getState().lenses.some((l) => l.id === 'today')).toBe(true)
    const id = store.getState().createLens()
    expect(store.getState().activeLensId).toBe(id)
    store.getState().deleteLens(id)
    expect(store.getState().lenses.some((l) => l.id === id)).toBe(false)
    expect(store.getState().activeLensId).toBe('today')
  })

  test('rename ignores blank names', () => {
    store.getState().renameLens('recent', '  Latest  ')
    expect(lensById('recent').name).toBe('Latest')
    store.getState().renameLens('recent', '   ')
    expect(lensById('recent').name).toBe('Latest')
  })

  test('at least one lens stays visible', () => {
    for (const l of defaultLenses()) store.getState().setLensHidden(l.id, true)
    expect(store.getState().lenses.filter((l) => !l.hidden)).toHaveLength(1)
  })

  test('move reorders', () => {
    store.getState().moveLens('accordion', 0)
    expect(store.getState().lenses[0].id).toBe('accordion')
  })
})
