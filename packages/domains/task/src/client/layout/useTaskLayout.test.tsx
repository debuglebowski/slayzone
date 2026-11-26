// @vitest-environment jsdom
// Pins useTaskLayout (docs/plans/panel-model.md step 5): Classic derived from the
// legacy columns, panel toggles as group hide/show, the debounced layout write
// (primary window only; legacy fields for a hub without the column), merging a
// stored layout by rev, and the legacy visibility projection the page reads.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type {
  PanelConfig,
  PanelVisibility,
  Task,
  TaskLayout,
  UpdateTaskInput
} from '@slayzone/task-contracts'
import {
  DEFAULT_PANEL_CONFIG,
  DEFAULT_TASK_PANEL_VISIBILITY,
  deriveLayoutFromLegacy,
  isColumnVisible,
  setSlotHidden
} from '@slayzone/task-contracts'
import { LAYOUT_SAVE_DEBOUNCE_MS, useTaskLayout, type UseTaskLayoutOptions } from './useTaskLayout'

const config = (patch: Partial<PanelConfig> = {}): PanelConfig => ({
  ...structuredClone(DEFAULT_PANEL_CONFIG),
  ...patch
})

function makeTask(patch: Partial<Task> = {}): Task {
  return { id: 't1', panel_layout: null, ...patch } as Task
}

type Props = UseTaskLayoutOptions
let updateTask: ReturnType<typeof vi.fn<(input: UpdateTaskInput) => Promise<Task | null>>>
let onTaskUpdated: ReturnType<typeof vi.fn<(task: Task) => void>>

function setup(patch: Partial<Props> = {}) {
  const props: Props = {
    task: makeTask(),
    panelConfig: config(),
    initialVisibility: { ...DEFAULT_TASK_PANEL_VISIBILITY },
    initialSizes: {},
    isSecondaryWindow: false,
    updateTask,
    onTaskUpdated,
    ...patch
  }
  return renderHook((p: Props) => useTaskLayout(p), { initialProps: props })
}

const visibleColumns = (layout: TaskLayout) =>
  layout.columns.filter(isColumnVisible).map((c) => c.id)

/** Let the debounced save fire and its promise settle. */
async function flushSave() {
  await act(async () => {
    vi.advanceTimersByTime(LAYOUT_SAVE_DEBOUNCE_MS)
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  updateTask = vi.fn(async (input: UpdateTaskInput) =>
    makeTask({ panel_layout: (input.panelLayout as TaskLayout | undefined) ?? null })
  )
  onTaskUpdated = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useTaskLayout', () => {
  it('derives Classic from the legacy visibility and sizes, without writing', async () => {
    const { result } = setup({
      initialVisibility: { ...DEFAULT_TASK_PANEL_VISIBILITY, browser: true },
      initialSizes: { settings: { unit: 'px', value: 500 } }
    })
    expect(result.current.layout.layoutId).toBe('classic')
    expect(visibleColumns(result.current.layout)).toEqual(['terminal', 'browser', 'settings'])
    expect(result.current.layout.columns.find((c) => c.id === 'settings')?.sizeOverride).toEqual({
      unit: 'px',
      value: 500
    })
    expect(result.current.panelVisibility).toMatchObject({
      terminal: true,
      browser: true,
      settings: true,
      editor: false
    })
    await flushSave()
    expect(updateTask).not.toHaveBeenCalled()
  })

  it('starts from the stored layout when the task has one', () => {
    const stored = setSlotHidden(
      deriveLayoutFromLegacy({ panel_visibility: { terminal: true, editor: true } }, config()),
      'settings',
      true
    )
    const { result } = setup({ task: makeTask({ panel_layout: stored }) })
    expect(visibleColumns(result.current.layout)).toEqual(['terminal', 'editor'])
    expect(result.current.layout.rev).toBe(stored.rev)
  })

  it('a toggle shows the group, resets its size and writes the layout once, debounced', async () => {
    const { result } = setup({ initialSizes: { browser: { unit: 'px', value: 300 } } })
    act(() => result.current.setPanelVisible('browser', true))
    act(() => result.current.setPanelVisible('editor', true))
    const browser = result.current.layout.columns.find((c) => c.id === 'browser')
    expect(browser?.sizeOverride).toBeUndefined()
    expect(result.current.panelVisibility.browser).toBe(true)
    expect(updateTask).not.toHaveBeenCalled()

    await flushSave()
    expect(updateTask).toHaveBeenCalledTimes(1)
    const input = updateTask.mock.calls[0][0]
    expect(input.id).toBe('t1')
    expect(visibleColumns(input.panelLayout as TaskLayout)).toEqual([
      'terminal',
      'browser',
      'editor',
      'settings'
    ])
    expect(input.panelVisibility).toMatchObject({ browser: true, editor: true })
    expect(onTaskUpdated).toHaveBeenCalledTimes(1)
  })

  it('hiding keeps the group in place (and its size)', () => {
    const { result } = setup({ initialSizes: { settings: { unit: 'px', value: 520 } } })
    act(() => result.current.setPanelVisible('settings', false))
    const settings = result.current.layout.columns.find((c) => c.id === 'settings')
    expect(settings?.slots[0].hidden).toBe(true)
    expect(settings?.sizeOverride).toEqual({ unit: 'px', value: 520 })
    expect(result.current.slotOf('settings')).toBe('settings')
  })

  it('an old hub (no panel_layout field) gets the legacy fields only', async () => {
    const task = makeTask()
    delete (task as Partial<Task>).panel_layout
    const { result } = setup({ task, initialSizes: { terminal: { unit: 'fr', value: 2 } } })
    act(() => result.current.setPanelVisible('diff', true))
    await flushSave()
    const input = updateTask.mock.calls[0][0]
    expect(input.panelLayout).toBeUndefined()
    expect(input.panelVisibility).toMatchObject({ terminal: true, diff: true, settings: true })
    expect(input.panelSizes).toEqual({ terminal: { unit: 'fr', value: 2 } })
  })

  it('a secondary window keeps its layout local and starts from its lifted visibility', async () => {
    const stored = deriveLayoutFromLegacy({ panel_visibility: { terminal: true } }, config())
    const onPanelVisibilityChange = vi.fn()
    const { result } = setup({
      task: makeTask({ panel_layout: stored }),
      isSecondaryWindow: true,
      initialVisibility: {
        ...DEFAULT_TASK_PANEL_VISIBILITY,
        terminal: false,
        settings: false,
        browser: true
      },
      onPanelVisibilityChange
    })
    expect(visibleColumns(result.current.layout)).toEqual(['browser'])
    act(() => result.current.setPanelVisible('editor', true))
    await flushSave()
    expect(updateTask).not.toHaveBeenCalled()
    const last = onPanelVisibilityChange.mock.calls.at(-1)?.[0] as PanelVisibility
    expect(last).toMatchObject({ browser: true, editor: true, terminal: false })
  })

  it('adopts a stored layout with a higher rev, ignores an equal or lower one', () => {
    const base = deriveLayoutFromLegacy({ panel_visibility: null }, config())
    const { result, rerender } = setup({ task: makeTask({ panel_layout: { ...base, rev: 3 } }) })
    const props = (layout: TaskLayout): Props => ({
      task: makeTask({ panel_layout: layout }),
      panelConfig: config(),
      initialVisibility: { ...DEFAULT_TASK_PANEL_VISIBILITY },
      initialSizes: {},
      isSecondaryWindow: false,
      updateTask,
      onTaskUpdated
    })
    const older = { ...setSlotHidden(base, 'terminal', true), rev: 3 }
    rerender(props(older))
    expect(result.current.panelVisibility.terminal).toBe(true)
    const newer = { ...setSlotHidden(base, 'terminal', true), rev: 4 }
    rerender(props(newer))
    expect(result.current.panelVisibility.terminal).toBe(false)
    expect(result.current.layout.rev).toBe(4)
  })

  it('keeps an id the layout cannot hold (tests) in the legacy visibility it writes', async () => {
    const { result } = setup()
    act(() => result.current.setPanelVisible('tests', true))
    expect(result.current.panelVisibility.tests).toBe(true)
    await flushSave()
    expect(updateTask.mock.calls[0][0].panelVisibility).toMatchObject({ tests: true })
  })

  it('local hides neither write nor bump the rev', async () => {
    const { result } = setup()
    const rev = result.current.layout.rev
    act(() => result.current.hidePanelsLocally(['terminal']))
    expect(result.current.panelVisibility.terminal).toBe(false)
    expect(result.current.layout.rev).toBe(rev)
    act(() =>
      result.current.replaceVisibilityLocally({ browser: true, settings: true, terminal: false })
    )
    expect(visibleColumns(result.current.layout)).toEqual(['browser', 'settings'])
    await flushSave()
    expect(updateTask).not.toHaveBeenCalled()
  })

  it('a drag resizes live and writes once on commit, as one rev', async () => {
    const onPanelVisibilityChange = vi.fn()
    const { result } = setup({ onPanelVisibilityChange })
    const calls = onPanelVisibilityChange.mock.calls.length
    const rev = result.current.layout.rev
    act(() => result.current.resizeColumns({ settings: { unit: 'px', value: 460 } }))
    act(() => result.current.resizeColumns({ settings: { unit: 'px', value: 480 } }))
    expect(result.current.layout.columns.find((c) => c.id === 'settings')?.sizeOverride).toEqual({
      unit: 'px',
      value: 480
    })
    // Visibility did not change: the same object, no lifted-state churn per frame.
    expect(onPanelVisibilityChange.mock.calls.length).toBe(calls)
    await flushSave()
    expect(updateTask).not.toHaveBeenCalled()
    act(() => result.current.commitSizes())
    await flushSave()
    expect(updateTask).toHaveBeenCalledTimes(1)
    expect((updateTask.mock.calls[0][0].panelLayout as TaskLayout).rev).toBe(rev + 1)

    act(() => result.current.resetAllSizes())
    expect(result.current.layout.columns.every((c) => !c.sizeOverride)).toBe(true)
  })

  it('Classic follows a reordered panel_config', () => {
    const { result, rerender } = setup()
    const order = ['settings', ...(config().order ?? []).filter((id) => id !== 'settings')]
    rerender({
      task: makeTask(),
      panelConfig: config({ order }),
      initialVisibility: { ...DEFAULT_TASK_PANEL_VISIBILITY },
      initialSizes: {},
      isSecondaryWindow: false,
      updateTask,
      onTaskUpdated
    })
    expect(visibleColumns(result.current.layout)).toEqual(['settings', 'terminal'])
  })

  it('writes a pending change on unmount', async () => {
    const { result, unmount } = setup()
    act(() => result.current.setPanelVisible('processes', true))
    unmount()
    expect(updateTask).toHaveBeenCalledTimes(1)
    expect(updateTask.mock.calls[0][0].panelVisibility).toMatchObject({ processes: true })
  })

  it('a drop moves the panel and persists; a no-op drop writes nothing', async () => {
    const { result } = setup({
      initialVisibility: { ...DEFAULT_TASK_PANEL_VISIBILITY, browser: true }
    })
    act(() =>
      result.current.dropPanel(
        { type: 'tab', instanceId: 'browser' },
        { type: 'zone', slotId: 'browser', zone: 'merge' }
      )
    )
    await flushSave()
    expect(updateTask).not.toHaveBeenCalled()

    act(() =>
      result.current.dropPanel(
        { type: 'tab', instanceId: 'browser' },
        { type: 'zone', slotId: 'terminal', zone: 'merge' }
      )
    )
    const shape = (l: TaskLayout) =>
      l.columns
        .filter(isColumnVisible)
        .map((c) => c.slots.map((s) => s.tabs.map((t) => t.instanceId)))
    expect(shape(result.current.layout)).toEqual([[['terminal', 'browser']], [['settings']]])
    // Both stay visible in the legacy projection: one shows, one is a click away.
    expect(result.current.panelVisibility).toMatchObject({ terminal: true, browser: true })
    await flushSave()
    expect(updateTask).toHaveBeenCalledTimes(1)
    expect(shape(updateTask.mock.calls[0][0].panelLayout as TaskLayout)).toEqual([
      [['terminal', 'browser']],
      [['settings']]
    ])
  })

  it('splitTab, hideTab, closeTab and renameTab edit the tab and persist', async () => {
    const { result } = setup({
      initialVisibility: { ...DEFAULT_TASK_PANEL_VISIBILITY, browser: true }
    })
    act(() =>
      result.current.dropPanel(
        { type: 'tab', instanceId: 'browser' },
        { type: 'zone', slotId: 'terminal', zone: 'merge' }
      )
    )
    act(() => result.current.splitTab('browser', 'after'))
    const col = result.current.layout.columns[0]
    expect(col.slots.map((s) => s.tabs.map((t) => t.instanceId))).toEqual([
      ['terminal'],
      ['browser']
    ])
    // A lone tab has nothing to split from.
    const rev = result.current.layout.rev
    act(() => result.current.splitTab('browser', 'right'))
    expect(result.current.layout.rev).toBe(rev)

    act(() => result.current.renameTab('browser', 'Docs'))
    expect(result.current.layout.instances.browser.name).toBe('Docs')

    act(() => result.current.closeTab('browser'))
    // A primary instance is hidden, not removed.
    expect(result.current.layout.instances.browser).toBeDefined()
    expect(result.current.panelVisibility.browser).toBe(false)
    act(() => result.current.setPanelVisible('browser', true))
    expect(result.current.panelVisibility.browser).toBe(true)
    act(() => result.current.hideTab('browser'))
    expect(result.current.panelVisibility.browser).toBe(false)
    await flushSave()
    expect(updateTask).toHaveBeenCalledTimes(1)
  })

  it('resizeSlots: live frames keep the rev, a persisted edit bumps and writes it', async () => {
    const { result } = setup({
      initialVisibility: { ...DEFAULT_TASK_PANEL_VISIBILITY, browser: true }
    })
    act(() =>
      result.current.dropPanel(
        { type: 'tab', instanceId: 'browser' },
        { type: 'zone', slotId: 'terminal', zone: 'after' }
      )
    )
    await flushSave()
    updateTask.mockClear()
    const col = result.current.layout.columns[0]
    const [a, b] = col.slots
    const rev = result.current.layout.rev
    act(() => result.current.resizeSlots(col.id, { [a.id]: 0.3, [b.id]: 0.7 }, false))
    expect(result.current.layout.rev).toBe(rev)
    expect(result.current.layout.columns[0].slots.map((s) => s.weight)).toEqual([0.3, 0.7])
    await flushSave()
    expect(updateTask).not.toHaveBeenCalled()
    act(() => result.current.commitSizes())
    await flushSave()
    expect(updateTask).toHaveBeenCalledTimes(1)
    expect(
      (updateTask.mock.calls[0][0].panelLayout as TaskLayout).columns[0].slots.map((s) => s.weight)
    ).toEqual([0.3, 0.7])
  })
})

describe('useTaskLayout — panel instances (step 7)', () => {
  it('adds another instance of a kind, returns its id at once and persists it', async () => {
    const { result } = setup({
      initialVisibility: { ...DEFAULT_TASK_PANEL_VISIBILITY, editor: true }
    })
    expect(result.current.supportsInstances).toBe(true)
    let id = ''
    act(() => {
      id = result.current.addInstance('editor', { type: 'column' })
    })
    expect(id).toMatch(/^editor:[0-9a-f]{8}$/)
    expect(result.current.layout.instances[id]?.kind).toBe('editor')
    // The primary keeps its legacy id; the projection is unchanged.
    expect(result.current.layout.instances.editor?.kind).toBe('editor')
    expect(result.current.panelVisibility.editor).toBe(true)
    await flushSave()
    expect(updateTask.mock.calls.at(-1)?.[0].panelLayout?.instances[id]).toBeTruthy()
  })

  it('updateInstanceSettings merges, and closing a non-primary instance removes it', async () => {
    const { result } = setup()
    let id = ''
    act(() => {
      id = result.current.addInstance('agent', { type: 'column' }, { terminalGroupIds: ['g1'] })
    })
    act(() => result.current.updateInstanceSettings(id, { terminalGroupIds: ['g1', 'g2'] }))
    expect(result.current.layout.instances[id].settings.terminalGroupIds).toEqual(['g1', 'g2'])
    act(() => result.current.closeTab(id))
    expect(result.current.layout.instances[id]).toBeUndefined()
    // The primary agent only hides.
    act(() => result.current.closeTab('terminal'))
    expect(result.current.layout.instances.terminal).toBeTruthy()
    expect(result.current.panelVisibility.terminal).toBe(false)
  })

  it('no instances on a hub without panel_layout, nor in a secondary window', () => {
    expect(
      setup({ task: makeTask({ panel_layout: undefined }) }).result.current.supportsInstances
    ).toBe(false)
    cleanup()
    expect(setup({ isSecondaryWindow: true }).result.current.supportsInstances).toBe(false)
  })

  it('applyDefinition switches without losing live instances; unpark brings one back', async () => {
    const { result } = setup()
    let term = ''
    act(() => {
      term = result.current.addInstance(
        'terminal',
        { type: 'column' },
        { terminalGroupIds: ['g1'] }
      )
    })
    const focus = {
      id: 'focus',
      name: 'Focus',
      builtin: true,
      enabled: true,
      columns: [
        {
          id: 'terminal',
          size: { unit: 'fr' as const, value: 1 },
          slots: [
            {
              id: 'terminal',
              weight: 1,
              activeInstanceId: 'terminal',
              tabs: [{ instanceId: 'terminal' }]
            }
          ]
        }
      ],
      instances: { terminal: { id: 'terminal', kind: 'agent' as const, settings: {} } }
    }
    let parked: string[] = []
    act(() => {
      parked = result.current.applyDefinition(focus, (i) => i.id === term).parked
    })
    expect(parked).toEqual([term])
    expect(result.current.layout.layoutId).toBe('focus')
    expect(visibleColumns(result.current.layout)).toEqual(['terminal'])
    expect(result.current.layout.instances[term].settings.terminalGroupIds).toEqual(['g1'])
    expect(result.current.layout.instances.browser).toBeUndefined()
    await flushSave()
    expect(updateTask.mock.calls.at(-1)?.[0].panelLayout?.layoutId).toBe('focus')

    act(() => result.current.unpark(term))
    expect(visibleColumns(result.current.layout)).toHaveLength(2)
    act(() => result.current.setLayoutId('mine'))
    expect(result.current.layout.layoutId).toBe('mine')
  })

  it('a customized Classic stops following panel_config', () => {
    const custom = setSlotHidden(deriveLayoutFromLegacy({}, config()), 'browser', false)
    // Reverse the config order: a following Classic re-sorts, a customized one keeps its own.
    const reversed = config({ order: [...(config().order ?? [])].reverse() })
    const following = setup({ task: makeTask({ panel_layout: custom }), panelConfig: reversed })
    const followIds = following.result.current.layout.columns.map((c) => c.id)
    cleanup()
    const fixed = setup({
      task: makeTask({ panel_layout: custom }),
      panelConfig: reversed,
      followPanelConfig: false
    })
    expect(fixed.result.current.layout.columns.map((c) => c.id)).toEqual(
      custom.columns.map((c) => c.id)
    )
    expect(followIds).not.toEqual(custom.columns.map((c) => c.id))
  })
})
