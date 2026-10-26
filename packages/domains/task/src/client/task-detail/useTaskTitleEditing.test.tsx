// @vitest-environment jsdom
// Pins useTaskTitleEditing's external-title sync: follow the task's title while not
// editing, never clobber an in-progress edit, re-sync when editing ends.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { Task } from '@slayzone/task/shared'

const mutateAsync = vi.fn()
vi.mock('@slayzone/transport/client', () => ({
  useTRPC: () => ({ task: { update: { mutationOptions: () => ({}) } } })
}))
vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutateAsync })
}))

const { useTaskTitleEditing } = await import('./useTaskTitleEditing')

const task = (title: string, id = 't1'): Task => ({ id, title }) as Task

afterEach(() => {
  cleanup()
  mutateAsync.mockReset()
})

function setup(initial: Task | null) {
  const onTaskUpdated = vi.fn()
  const hook = renderHook(({ t }: { t: Task | null }) => useTaskTitleEditing(t, onTaskUpdated), {
    initialProps: { t: initial }
  })
  return { ...hook, onTaskUpdated }
}

describe('useTaskTitleEditing', () => {
  it('starts from the task title and follows external renames while not editing', () => {
    const { result, rerender } = setup(task('One'))
    expect(result.current.titleValue).toBe('One')
    rerender({ t: task('Two') })
    expect(result.current.titleValue).toBe('Two')
  })

  it('does not clobber an in-progress edit; re-syncs to the latest title when editing ends', () => {
    const { result, rerender } = setup(task('One'))
    act(() => result.current.setEditingTitle(true))
    act(() => result.current.setTitleValue('Draft'))

    rerender({ t: task('Renamed elsewhere') })
    expect(result.current.titleValue).toBe('Draft')

    act(() => result.current.setEditingTitle(false))
    expect(result.current.titleValue).toBe('Renamed elsewhere')
  })

  it('a local edit outside edit mode sticks until the title or editing flag changes', () => {
    const { result, rerender } = setup(task('One'))
    act(() => result.current.setTitleValue('Local'))
    rerender({ t: task('One') }) // same title, new object
    expect(result.current.titleValue).toBe('Local')
    rerender({ t: task('One', 't2') }) // another task, same title → no sync
    expect(result.current.titleValue).toBe('Local')
    rerender({ t: task('Changed', 't2') })
    expect(result.current.titleValue).toBe('Changed')
  })

  it('keeps the last value when the task goes away', () => {
    const { result, rerender } = setup(task('One'))
    rerender({ t: null })
    expect(result.current.titleValue).toBe('One')
  })

  it('save: persists the edited title, hands the update up, leaves edit mode', async () => {
    const { result, rerender, onTaskUpdated } = setup(task('One'))
    mutateAsync.mockResolvedValue(task('Draft'))
    act(() => result.current.setEditingTitle(true))
    act(() => result.current.setTitleValue('Draft'))
    await act(() => result.current.handleTitleSave())
    expect(mutateAsync).toHaveBeenCalledWith({ id: 't1', title: 'Draft' })
    expect(onTaskUpdated).toHaveBeenCalledWith(task('Draft'))
    expect(result.current.editingTitle).toBe(false)
    // Parent has not pushed the new task yet → sync shows the stale prop title.
    expect(result.current.titleValue).toBe('One')
    rerender({ t: task('Draft') })
    expect(result.current.titleValue).toBe('Draft')
  })
})
