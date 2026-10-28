// @vitest-environment jsdom
// Pins the BrowserTaskSource contract: task-browser reads other tasks' URLs only
// through the task-registered source (never `task.*` itself), fetches only while
// the import dropdown is open, and re-registration of a different source throws.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { Task } from '@slayzone/task-contracts'
import { registerBrowserTaskSource, type BrowserTaskSource } from './BrowserTaskSource'
import { useBrowserImportUrls } from './useBrowserImportUrls'

const tab = (id: string, url: string, title: string) => ({ id, url, title })
const tasks = [
  { id: 't1', title: 'Self', browser_tabs: { tabs: [tab('a', 'https://self', 'S')] } },
  {
    id: 't2',
    title: 'Other',
    browser_tabs: { tabs: [tab('b', 'https://x', 'X'), tab('c', 'about:blank', 'B')] }
  },
  { id: 't3', title: 'No tabs', browser_tabs: null }
] as unknown as Task[]

const useImportTasks = vi.fn((_p: { projectId?: string; enabled: boolean }) => tasks)
const setLocked = vi.fn()
const source: BrowserTaskSource = { useImportTasks, useSetBrowserTabLocked: () => setLocked }
registerBrowserTaskSource(source)

afterEach(() => {
  cleanup()
  useImportTasks.mockClear()
})

describe('BrowserTaskSource', () => {
  it('re-registering the same source is a no-op; a different one throws', () => {
    expect(() => registerBrowserTaskSource(source)).not.toThrow()
    expect(() => registerBrowserTaskSource({ ...source })).toThrow(/already registered/)
  })

  it('useBrowserImportUrls: disabled until the dropdown opens, then lists other tasks URLs', () => {
    const { result } = renderHook(() => useBrowserImportUrls({ taskId: 't1', projectId: 'p1' }))
    expect(useImportTasks).toHaveBeenLastCalledWith({ projectId: 'p1', enabled: false })
    expect(result.current.otherTaskUrls).toEqual([])

    act(() => result.current.setImportDropdownOpen(true))
    expect(useImportTasks).toHaveBeenLastCalledWith({ projectId: 'p1', enabled: true })
    expect(result.current.otherTaskUrls).toEqual([
      { taskId: 't2', taskTitle: 'Other', url: 'https://x', tabTitle: 'X' }
    ])
  })

  it('stays disabled without a taskId', () => {
    const { result } = renderHook(() => useBrowserImportUrls({}))
    act(() => result.current.setImportDropdownOpen(true))
    expect(useImportTasks).toHaveBeenLastCalledWith({ projectId: undefined, enabled: false })
    expect(result.current.otherTaskUrls).toEqual([])
  })
})
