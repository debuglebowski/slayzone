// @vitest-environment jsdom
// Pins useExplodeMode: explode mode turns itself off below two task tabs (and stays off
// when tabs come back); the focused cell is seeded on entry (kept while still open, else
// the active task tab from the tab store, else the first task), follows focusin inside the
// grid, and is cleared whenever explode mode is off.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'

type Tab = { type: 'home' } | { type: 'task'; taskId: string }
const store: { tabs: Tab[]; activeTabIndex: number } = { tabs: [], activeTabIndex: 0 }
vi.mock('@slayzone/settings', () => ({ useTabStore: { getState: () => store } }))

const { useExplodeMode } = await import('./useExplodeMode')

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

let grid: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  store.tabs = [
    { type: 'home' },
    { type: 'task', taskId: 'a' },
    { type: 'task', taskId: 'b' },
    { type: 'task', taskId: 'c' }
  ]
  store.activeTabIndex = 2 // 'b'
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
})
