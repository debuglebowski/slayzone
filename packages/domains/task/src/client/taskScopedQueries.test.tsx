// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query'
import { createTrpcTest } from '@slayzone/transport/testing'
import {
  __resetTaskScopedQueriesForTest,
  refreshTaskScopedQueries,
  taskIdOfScopedQuery,
  useTaskScopedQueriesFreshOnReveal,
  useTaskScopedQueriesFreshOnTasksChanged
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

// A renderer without the app shell (a task's own window) gets no board refresh, so
// nothing refreshed its per-task queries: an artifact the CLI created never showed in
// that window's open Artifacts panel until Reload (e2e 146).
describe('useTaskScopedQueriesFreshOnTasksChanged', () => {
  afterEach(() => __resetTaskScopedQueriesForTest())

  function Listener() {
    useTaskScopedQueriesFreshOnTasksChanged()
    return null
  }

  it("refetches this renderer's per-task queries on every tasks-changed event", async () => {
    let emit: ((data: unknown) => void) | null = null
    const trpc = createTrpcTest({
      subscriptions: {
        'notify.onTasksChanged': (_input, e) => {
          emit = e
          return () => {
            emit = null
          }
        }
      }
    })
    const artifacts = observe(trpc.queryClient, key('artifacts.getByTask', { taskId: 't1' }))
    const other = observe(trpc.queryClient, key('task.get', { id: 't1' }))
    render(<Listener />, { wrapper: trpc.wrapper })
    await settle()
    expect(emit).not.toBeNull()
    artifacts.fn.mockClear()
    other.fn.mockClear()

    // Unknown scope (a CLI/REST write), then one that names an unrelated task: the
    // window cannot tell a child of its task from any other, so both refresh it.
    await act(async () => emit?.(undefined))
    await settle()
    expect(artifacts.fn).toHaveBeenCalledTimes(1)
    await act(async () => emit?.({ taskIds: ['someone-else'] }))
    await settle()
    expect(artifacts.fn).toHaveBeenCalledTimes(2)
    expect(other.fn, 'only per-task queries').not.toHaveBeenCalled()
    artifacts.unsub()
    other.unsub()
  })
})
