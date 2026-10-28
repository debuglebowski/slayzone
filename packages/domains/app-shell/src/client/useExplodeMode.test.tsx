// @vitest-environment jsdom
// Pins useExplodeMode: explode mode turns itself off below two task tabs (and stays off
// when tabs come back); the focused cell is seeded on entry (kept while still open, else
// the active task tab from the tab store, else the first task), follows focusin inside the
// grid, and is cleared whenever explode mode is off. The arrangement (order + tray) is
// reconciled against the open tabs, a minimized cell never holds focus, and the
// arrangement actions keep one identity across renders (memoized panes receive them).
import { useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'

type Tab = { type: 'home' } | { type: 'task'; taskId: string }
type Store = {
  tabs: Tab[]
  activeTabIndex: number
  explodeOrder: string[]
  explodeMinimized: string[]
  setExplodeArrangement: (a: { order?: string[]; minimized?: string[] }) => void
}
// Minimal reactive stand-in for the zustand tab store: selector hook + getState.
const listeners = new Set<() => void>()
let store: Store
const setExplodeArrangement: Store['setExplodeArrangement'] = ({ order, minimized }) => {
  store = {
    ...store,
    explodeOrder: order ?? store.explodeOrder,
    explodeMinimized: minimized ?? store.explodeMinimized
  }
  for (const l of listeners) l()
}
vi.mock('@slayzone/tabs-state', () => ({
  useTabStore: Object.assign(
    <T,>(sel: (s: Store) => T): T =>
      useSyncExternalStore(
        (cb) => {
          listeners.add(cb)
          return () => listeners.delete(cb)
        },
        () => sel(store)
      ),
    { getState: () => store }
  )
}))

const { useExplodeMode } = await import('./useExplodeMode')

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

let grid: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  store = {
    tabs: [
      { type: 'home' },
      { type: 'task', taskId: 'a' },
      { type: 'task', taskId: 'b' },
      { type: 'task', taskId: 'c' }
    ],
    activeTabIndex: 2, // 'b'
    explodeOrder: [],
    explodeMinimized: [],
    setExplodeArrangement
  }
  grid = document.createElement('div')
  for (const id of ['a', 'b', 'c']) {
    const cell = document.createElement('div')
    cell.setAttribute('data-explode-task-id', id)
    const inner = document.createElement('button')
    inner.setAttribute('data-testid', `inner-${id}`)
    cell.appendChild(inner)
    grid.appendChild(cell)
  }
  document.body.appendChild(grid)
})
afterEach(() => {
  cleanup()
  grid.remove()
  vi.unstubAllGlobals()
})

function setup(initial: string[]) {
  const hook = renderHook((p: { ids: string[] }) => useExplodeMode(p.ids), {
    initialProps: { ids: initial }
  })
  hook.result.current.explodeGridRef.current = grid
  return hook
}
const focusCell = (id: string): void => {
  const el = grid.querySelector(`[data-testid="inner-${id}"]`) as HTMLElement
  act(() => {
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
  })
}

describe('useExplodeMode', () => {
  it('seeds the focused cell from the active task tab on entry and clears it on exit', () => {
    const { result } = setup(['a', 'b', 'c'])
    expect(result.current.focusedExplodeTaskId).toBe(null)
    act(() => result.current.setExplodeMode(true))
    expect(result.current.explodeMode).toBe(true)
    expect(result.current.focusedExplodeTaskId).toBe('b')
    act(() => result.current.setExplodeMode(false))
    expect(result.current.focusedExplodeTaskId).toBe(null)
  })

  it('falls back to the first task when the active tab is not a task', () => {
    store.activeTabIndex = 0 // home
    const { result } = setup(['a', 'b', 'c'])
    act(() => result.current.setExplodeMode(true))
    expect(result.current.focusedExplodeTaskId).toBe('a')
  })

  it('focusin moves the focused cell; re-entry seeds afresh instead of restoring it', () => {
    const { result } = setup(['a', 'b', 'c'])
    act(() => result.current.setExplodeMode(true))
    focusCell('c')
    expect(result.current.focusedExplodeTaskId).toBe('c')
    act(() => result.current.setExplodeMode(false))
    expect(result.current.focusedExplodeTaskId).toBe(null)
    // Outside explode mode the grid listener is gone.
    focusCell('a')
    expect(result.current.focusedExplodeTaskId).toBe(null)
    act(() => result.current.setExplodeMode(true))
    expect(result.current.focusedExplodeTaskId).toBe('b')
  })

  it('keeps a still-open focused cell and replaces a closed one as tabs change', () => {
    const { result, rerender } = setup(['a', 'b', 'c'])
    act(() => result.current.setExplodeMode(true))
    focusCell('c')
    rerender({ ids: ['a', 'b', 'c', 'd'] })
    expect(result.current.focusedExplodeTaskId).toBe('c')
    rerender({ ids: ['a', 'b', 'd'] })
    expect(result.current.focusedExplodeTaskId).toBe('b')
  })

  it('turns off below two task tabs, clears the focused cell, and stays off', () => {
    const { result, rerender } = setup(['a', 'b'])
    act(() => result.current.setExplodeMode(true))
    expect(result.current.focusedExplodeTaskId).toBe('b')
    rerender({ ids: ['a'] })
    expect(result.current.explodeMode).toBe(false)
    expect(result.current.focusedExplodeTaskId).toBe(null)
    rerender({ ids: ['a', 'b', 'c'] })
    expect(result.current.explodeMode).toBe(false)
    expect(result.current.focusedExplodeTaskId).toBe(null)
  })

  it('lays out open tasks in the stored order, appending new ones and dropping closed ones', () => {
    store.explodeOrder = ['c', 'gone', 'a']
    const { result } = setup(['a', 'b', 'c'])
    expect(result.current.explodeVisibleTaskIds).toEqual(['c', 'a', 'b'])
  })

  it('minimize parks a task in the tray, restore puts it back; focus skips it', () => {
    const { result } = setup(['a', 'b', 'c'])
    act(() => result.current.setExplodeMode(true))
    expect(result.current.focusedExplodeTaskId).toBe('b')
    act(() => result.current.minimizeExplodeTask('b'))
    expect(result.current.explodeVisibleTaskIds).toEqual(['a', 'c'])
    expect(result.current.explodeMinimizedTaskIds).toEqual(['b'])
    // The focused cell left the grid → focus moves to a visible one.
    expect(result.current.focusedExplodeTaskId).toBe('a')
    act(() => result.current.restoreExplodeTask('b'))
    expect(result.current.explodeVisibleTaskIds).toEqual(['a', 'b', 'c'])
    act(() => {
      result.current.minimizeExplodeTask('a')
      result.current.minimizeExplodeTask('c')
    })
    expect(result.current.explodeMinimizedTaskIds).toEqual(['a', 'c'])
    act(() => result.current.restoreAllExplodeTasks())
    expect(result.current.explodeMinimizedTaskIds).toEqual([])
  })

  it('seeding skips a minimized active tab', () => {
    store.explodeMinimized = ['b']
    const { result } = setup(['a', 'b', 'c'])
    act(() => result.current.setExplodeMode(true))
    expect(result.current.focusedExplodeTaskId).toBe('a')
  })

  it('closing a minimized task drops it from the tray', () => {
    store.explodeMinimized = ['c']
    const { result, rerender } = setup(['a', 'b', 'c'])
    expect(result.current.explodeMinimizedTaskIds).toEqual(['c'])
    rerender({ ids: ['a', 'b'] })
    expect(store.explodeMinimized).toEqual([])
    rerender({ ids: ['a', 'b', 'c'] })
    expect(result.current.explodeVisibleTaskIds).toEqual(['a', 'b', 'c'])
  })

  it('swap exchanges exactly two cells and persists the reconciled order', () => {
    store.explodeOrder = ['a', 'b'] // predates 'c'
    const { result } = setup(['a', 'b', 'c'])
    act(() => result.current.swapExplodeTasks('a', 'c'))
    expect(store.explodeOrder).toEqual(['c', 'b', 'a'])
    expect(result.current.explodeVisibleTaskIds).toEqual(['c', 'b', 'a'])
  })

  it('minimize/restore keep one identity across renders (handed to memoized panes)', () => {
    const { result, rerender } = setup(['a', 'b', 'c'])
    const { minimizeExplodeTask, restoreExplodeTask, restoreAllExplodeTasks } = result.current
    act(() => result.current.minimizeExplodeTask('a'))
    rerender({ ids: ['a', 'b', 'c', 'd'] })
    expect(result.current.minimizeExplodeTask).toBe(minimizeExplodeTask)
    expect(result.current.restoreExplodeTask).toBe(restoreExplodeTask)
    expect(result.current.restoreAllExplodeTasks).toBe(restoreAllExplodeTasks)
  })

  it('setExplodeMode keeps one identity across renders and accepts an updater', () => {
    const { result, rerender } = setup(['a', 'b', 'c'])
    const { setExplodeMode } = result.current
    act(() => result.current.setExplodeMode((prev) => !prev))
    expect(result.current.explodeMode).toBe(true)
    rerender({ ids: ['a', 'b', 'c', 'd'] })
    expect(result.current.setExplodeMode).toBe(setExplodeMode)
    act(() => result.current.setExplodeMode((prev) => !prev))
    expect(result.current.explodeMode).toBe(false)
  })

  // Every render the shell would draw, as [open task count, explodeMode, focused cell].
  function setupRecorded(initial: string[]) {
    const seen: Array<[number, boolean, string | null]> = []
    const hook = renderHook(
      (p: { ids: string[] }) => {
        const r = useExplodeMode(p.ids)
        seen.push([p.ids.length, r.explodeMode, r.focusedExplodeTaskId])
        return r
      },
      { initialProps: { ids: initial } }
    )
    hook.result.current.explodeGridRef.current = grid
    return { ...hook, seen }
  }

  it('closing down to one task never draws the grid with one task', () => {
    const { result, rerender, seen } = setupRecorded(['a', 'b'])
    act(() => result.current.setExplodeMode(true))
    seen.length = 0
    rerender({ ids: ['a'] })
    expect(result.current.explodeMode).toBe(false)
    expect(seen.filter(([n, on]) => on && n < 2)).toEqual([])
  })

  it('entering explode mode draws the focused cell from the first frame', () => {
    const { result, seen } = setupRecorded(['a', 'b', 'c'])
    seen.length = 0
    act(() => result.current.setExplodeMode(true))
    expect(seen.filter(([, on, focused]) => on && focused === null)).toEqual([])
    expect(result.current.focusedExplodeTaskId).toBe('b')
  })

  // Behaviour change (approved): the replacement for a closed focused cell is the tab
  // that was active when explode mode was entered, not the active tab at close time.
  it('a closed focused cell is replaced by the tab active on entry', () => {
    const { result, rerender } = setup(['a', 'b', 'c'])
    act(() => result.current.setExplodeMode(true))
    focusCell('c')
    store = { ...store, activeTabIndex: 1 } // 'a', switched while in explode mode
    rerender({ ids: ['a', 'b'] })
    expect(result.current.focusedExplodeTaskId).toBe('b')
  })
})
