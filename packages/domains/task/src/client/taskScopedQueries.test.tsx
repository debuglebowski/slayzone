// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query'
import {
  __resetTaskScopedQueriesForTest,
  refreshTaskScopedQueries,
  taskIdOfScopedQuery,
  useTaskScopedQueriesFreshOnReveal
} from './taskScopedQueries'

// tRPC v11 query keys: [path segments, { input, type }].
const key = (path: string, input: Record<string, unknown>) => [
  path.split('.'),
  { input, type: 'query' }
]

function Pane({ taskId, visible }: { taskId: string; visible: boolean }) {
  useTaskScopedQueriesFreshOnReveal(taskId, visible)
  return null
}

/** A query with one live observer (as a mounted hook would hold), counting fetches. */
function observe(qc: QueryClient, queryKey: unknown[]) {
  const fn = vi.fn(async () => ['row'])
  const obs = new QueryObserver(qc, { queryKey, queryFn: fn })
  const unsub = obs.subscribe(() => undefined)
  return { fn, unsub }
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 0)))

describe('taskScopedQueries', () => {
  afterEach(() => __resetTaskScopedQueriesForTest())

  it('identifies per-task queries by tRPC path + task input field', () => {
    expect(taskIdOfScopedQuery(key('tags.getForTask', { taskId: 't1' }))).toBe('t1')
    expect(taskIdOfScopedQuery(key('task.getSubTasks', { parentId: 'p1' }))).toBe('p1')
    expect(taskIdOfScopedQuery(key('artifacts.getByTask', { taskId: 't2' }))).toBe('t2')
    expect(taskIdOfScopedQuery(key('artifacts.foldersGetByTask', { taskId: 't3' }))).toBe('t3')
    expect(taskIdOfScopedQuery(key('task.get', { id: 't1' }))).toBeNull()
    expect(taskIdOfScopedQuery(key('settings.get', { key: 'x' }))).toBeNull()
  })

  it('refetches only the named tasks', async () => {
    const qc = new QueryClient()
    const a = observe(qc, key('tags.getForTask', { taskId: 'a' }))
    const b = observe(qc, key('tags.getForTask', { taskId: 'b' }))
    await settle()
    a.fn.mockClear()
    b.fn.mockClear()
    await refreshTaskScopedQueries(qc, ['a'])
    expect(a.fn).toHaveBeenCalledTimes(1)
    expect(b.fn).not.toHaveBeenCalled()
    a.unsub()
    b.unsub()
  })

  it('defers a hidden tab until it is revealed, then refetches it once', async () => {
    const qc = new QueryClient()
    const sub = observe(qc, key('task.getSubTasks', { parentId: 'h' }))
    const vis = observe(qc, key('artifacts.getByTask', { taskId: 'v' }))
    const ui = render(
      <QueryClientProvider client={qc}>
        <Pane taskId="h" visible={false} />
        <Pane taskId="v" visible={true} />
      </QueryClientProvider>
    )
    await settle()
    sub.fn.mockClear()
    vis.fn.mockClear()

    await act(() => refreshTaskScopedQueries(qc, null))
    expect(vis.fn).toHaveBeenCalledTimes(1) // on screen → now
    expect(sub.fn).not.toHaveBeenCalled() // hidden → deferred
    expect(qc.getQueryState(key('task.getSubTasks', { parentId: 'h' }))?.isInvalidated).toBe(true)

    ui.rerender(
      <QueryClientProvider client={qc}>
        <Pane taskId="h" visible={true} />
        <Pane taskId="v" visible={true} />
      </QueryClientProvider>
    )
    await settle()
    expect(sub.fn).toHaveBeenCalledTimes(1) // revealed → fresh

    // Revealing again with nothing stale costs nothing.
    ui.rerender(
      <QueryClientProvider client={qc}>
        <Pane taskId="h" visible={false} />
        <Pane taskId="v" visible={true} />
      </QueryClientProvider>
    )
    ui.rerender(
      <QueryClientProvider client={qc}>
        <Pane taskId="h" visible={true} />
        <Pane taskId="v" visible={true} />
      </QueryClientProvider>
    )
    await settle()
    expect(sub.fn).toHaveBeenCalledTimes(1)
    sub.unsub()
    vis.unsub()
    ui.unmount()
  })
})
