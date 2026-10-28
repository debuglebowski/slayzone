// @vitest-environment jsdom
// Pins the prop-driven state resets of useKanbanSelection / useKanbanKeyboard:
// selection reset on resetKey change, pruning on column change, focus clear when
// the focused card disappears, and picker close on focus change.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { Task } from '@slayzone/task-contracts'
import type { Column } from './kanban'

// Latest registration per key string, so a test can "press" a hotkey the way
// react-hotkeys-hook would: only while its `enabled` option is true.
const hotkeys = new Map<string, { cb: (e: KeyboardEvent) => void; enabled: boolean }>()
vi.mock('@slayzone/ui', () => ({
  useGuardedHotkeys: (
    keys: string,
    cb: (e: KeyboardEvent) => void,
    options?: { enabled?: boolean }
  ) => {
    hotkeys.set(keys, { cb, enabled: options?.enabled ?? true })
  }
}))

const { useKanbanSelection } = await import('./useKanbanSelection')
const { useKanbanKeyboard } = await import('./useKanbanKeyboard')

function press(keys: string): void {
  const entry = hotkeys.get(keys)
  if (!entry) throw new Error(`no hotkey registered for ${keys}`)
  if (!entry.enabled) return
  act(() => entry.cb(new KeyboardEvent('keydown')))
}

const task = (id: string): Task => ({ id, title: id }) as Task
const col = (id: string, ids: string[]): Column => ({ id, title: id, tasks: ids.map(task) })

afterEach(() => {
  cleanup()
  hotkeys.clear()
})

describe('useKanbanSelection', () => {
  it('resets selection + anchor when resetKey changes, not on a plain re-render', () => {
    const columns = [col('a', ['t1', 't2', 't3'])]
    const { result, rerender } = renderHook(
      ({ resetKey }: { resetKey: string }) => useKanbanSelection({ columns, resetKey }),
      { initialProps: { resetKey: 'p1' } }
    )
    act(() => result.current.toggle('t1'))
    act(() => result.current.toggle('t2'))
    expect([...result.current.selectedIds]).toEqual(['t1', 't2'])
    expect(result.current.anchorId).toBe('t2')

    rerender({ resetKey: 'p1' })
    expect(result.current.size).toBe(2)

    rerender({ resetKey: 'p2' })
    expect(result.current.size).toBe(0)
    expect(result.current.anchorId).toBeNull()
  })

  it('prunes ids (and the anchor) that leave the visible columns', () => {
    const { result, rerender } = renderHook(
      ({ columns }: { columns: Column[] }) => useKanbanSelection({ columns, resetKey: 'p1' }),
      { initialProps: { columns: [col('a', ['t1', 't2', 't3'])] } }
    )
    act(() => result.current.selectAll(['t1', 't2', 't3']))
    expect(result.current.anchorId).toBe('t3')

    rerender({ columns: [col('a', ['t1', 't2'])] })
    expect([...result.current.selectedIds]).toEqual(['t1', 't2'])
    expect(result.current.anchorId).toBeNull()

    // Nothing pruned → the Set keeps its identity.
    const before = result.current.selectedIds
    rerender({ columns: [col('a', ['t1', 't2', 't4'])] })
    expect(result.current.selectedIds).toBe(before)
  })

  // KanbanBoard rebuilds `columns` on every render (the compiled board does not
  // memoize groupTasksBy), so the hook must settle when only the identity churns.
  it('tolerates a fresh columns array on every render', () => {
    let ids = ['t1', 't2', 't3']
    const { result, rerender } = renderHook(() =>
      useKanbanSelection({ columns: [col('a', ids)], resetKey: 'p1' })
    )
    act(() => result.current.toggle('t1'))
    act(() => result.current.toggle('t3'))
    rerender()
    rerender()
    expect([...result.current.selectedIds]).toEqual(['t1', 't3'])
    expect(result.current.anchorId).toBe('t3')

    ids = ['t1', 't2']
    rerender()
    expect([...result.current.selectedIds]).toEqual(['t1'])
    expect(result.current.anchorId).toBeNull()
  })

  it('keeps the anchor when it is still visible', () => {
    const { result, rerender } = renderHook(
      ({ columns }: { columns: Column[] }) => useKanbanSelection({ columns, resetKey: 'p1' }),
      { initialProps: { columns: [col('a', ['t1', 't2'])] } }
    )
    act(() => result.current.toggle('t1'))
    rerender({ columns: [col('a', ['t1'])] })
    expect(result.current.anchorId).toBe('t1')
    expect([...result.current.selectedIds]).toEqual(['t1'])
  })
})

describe('useKanbanKeyboard', () => {
  it('clears focus (and closes the picker) when the focused card disappears', () => {
    const onUpdateTask = vi.fn()
    const { result, rerender } = renderHook(
      ({ columns }: { columns: Column[] }) =>
        useKanbanKeyboard({ columns, isActive: true, onUpdateTask }),
      { initialProps: { columns: [col('a', ['t1', 't2'])] } }
    )
    press('j, ArrowDown') // no focus yet → focus the first card
    expect(result.current.focusedTaskId).toBe('t1')

    press('s')
    expect(result.current.pickerState).toEqual({ type: 'status', taskId: 't1' })

    rerender({ columns: [col('a', ['t2'])] })
    expect(result.current.focusedTaskId).toBeNull()
    expect(result.current.pickerState).toBeNull()
  })

  it('tolerates a fresh columns array on every render', () => {
    let ids = ['t1', 't2']
    const onUpdateTask = vi.fn()
    const { result, rerender } = renderHook(() =>
      useKanbanKeyboard({ columns: [col('a', ids)], isActive: true, onUpdateTask })
    )
    press('j, ArrowDown')
    press('s')
    rerender()
    rerender()
    expect(result.current.focusedTaskId).toBe('t1')
    expect(result.current.pickerState).toEqual({ type: 'status', taskId: 't1' })
    ids = ['t2']
    rerender()
    expect(result.current.focusedTaskId).toBeNull()
    expect(result.current.pickerState).toBeNull()
  })

  it('keeps focus while the focused card is still on the board', () => {
    const { result, rerender } = renderHook(
      ({ columns }: { columns: Column[] }) => useKanbanKeyboard({ columns, isActive: true }),
      { initialProps: { columns: [col('a', ['t1', 't2'])] } }
    )
    press('j, ArrowDown')
    press('j, ArrowDown')
    expect(result.current.focusedTaskId).toBe('t2')
    rerender({ columns: [col('a', ['t2']), col('b', ['t3'])] })
    expect(result.current.focusedTaskId).toBe('t2')
  })

  it('keeps the picker open across re-renders that do not move focus', () => {
    const onUpdateTask = vi.fn()
    const { result, rerender } = renderHook(
      ({ columns }: { columns: Column[] }) =>
        useKanbanKeyboard({ columns, isActive: true, onUpdateTask }),
      { initialProps: { columns: [col('a', ['t1', 't2'])] } }
    )
    press('j, ArrowDown')
    press('p')
    expect(result.current.pickerState).toEqual({ type: 'priority', taskId: 't1' })

    rerender({ columns: [col('a', ['t1', 't2', 't3'])] })
    expect(result.current.focusedTaskId).toBe('t1')
    expect(result.current.pickerState).toEqual({ type: 'priority', taskId: 't1' })

    press('escape')
    expect(result.current.pickerState).toBeNull()
    expect(result.current.focusedTaskId).toBe('t1')
  })
})
