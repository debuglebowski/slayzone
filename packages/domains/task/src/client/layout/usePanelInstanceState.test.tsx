// @vitest-environment jsdom
// Pins the state of non-primary panel instances (docs/plans/panel-model.md step 7):
// seeded from tasks.panel_instance_state, patched per instance, written whole and
// debounced to the task it was made in, dropped with a closed instance; a hub
// without the column keeps it for the session only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { Task, UpdateTaskInput } from '@slayzone/task-contracts'
import { INSTANCE_STATE_SAVE_DEBOUNCE_MS, usePanelInstanceState } from './usePanelInstanceState'

const task = (patch: Partial<Task> = {}): Task =>
  ({ id: 't1', panel_instance_state: null, ...patch }) as Task

let updateTask: ReturnType<typeof vi.fn<(input: UpdateTaskInput) => Promise<unknown>>>

beforeEach(() => {
  vi.useFakeTimers()
  updateTask = vi.fn(async () => null)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const setup = (t: Task | null) =>
  renderHook(({ t }) => usePanelInstanceState(t, updateTask), { initialProps: { t } })

describe('usePanelInstanceState', () => {
  it('reads the stored entry of an instance', () => {
    const { result } = setup(task({ panel_instance_state: { 'git:a': { gitTab: 'changes' } } }))
    expect(result.current.get('git:a')).toEqual({ gitTab: 'changes' })
    expect(result.current.get('git:b')).toEqual({})
  })

  it('patches several instances in one tick and writes the whole map once, debounced', () => {
    const { result } = setup(task())
    act(() => {
      result.current.patch('git:a', { gitTab: 'changes' })
      result.current.patch('editor:b', { editorOpenFiles: { files: ['x'] } })
    })
    expect(result.current.get('git:a')).toEqual({ gitTab: 'changes' })
    expect(updateTask).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(INSTANCE_STATE_SAVE_DEBOUNCE_MS))
    expect(updateTask).toHaveBeenCalledTimes(1)
    expect(updateTask).toHaveBeenCalledWith({
      id: 't1',
      panelInstanceState: {
        'git:a': { gitTab: 'changes' },
        'editor:b': { editorOpenFiles: { files: ['x'] } }
      }
    })
  })

  it('drop removes a closed instance’s entry', () => {
    const { result } = setup(task({ panel_instance_state: { 'git:a': { gitTab: 'changes' } } }))
    act(() => result.current.drop('git:a'))
    expect(result.current.get('git:a')).toEqual({})
    act(() => vi.advanceTimersByTime(INSTANCE_STATE_SAVE_DEBOUNCE_MS))
    expect(updateTask).toHaveBeenCalledWith({ id: 't1', panelInstanceState: {} })
  })

  it('a task switch sends the pending write to its own task, then reads the new one', () => {
    const { result, rerender } = setup(task())
    act(() => result.current.patch('git:a', { gitTab: 'changes' }))
    rerender({ t: task({ id: 't2', panel_instance_state: { 'git:z': { gitTab: 'general' } } }) })
    expect(updateTask).toHaveBeenCalledWith({
      id: 't1',
      panelInstanceState: { 'git:a': { gitTab: 'changes' } }
    })
    expect(result.current.get('git:z')).toEqual({ gitTab: 'general' })
    expect(result.current.get('git:a')).toEqual({})
  })

  it('a hub without the column keeps the state in memory only', () => {
    const { result } = setup(task({ panel_instance_state: undefined }))
    act(() => result.current.patch('git:a', { gitTab: 'changes' }))
    expect(result.current.get('git:a')).toEqual({ gitTab: 'changes' })
    act(() => vi.advanceTimersByTime(INSTANCE_STATE_SAVE_DEBOUNCE_MS * 2))
    expect(updateTask).not.toHaveBeenCalled()
  })
})
