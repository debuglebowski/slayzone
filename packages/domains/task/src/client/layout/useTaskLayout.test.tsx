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
})
