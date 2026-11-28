// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { QueryClient } from '@tanstack/react-query'
import { createTrpcTest } from '@slayzone/transport/testing'
import type { Task } from '@slayzone/task-contracts'
import { useBoardTasks } from './useBoardTasks'

// Every open task tab mounts a board-tasks reader (palette commands); only the active
// one is enabled. The board is the app's biggest query (thousands of rows, MBs), patched
// on every `tasks-changed` event — so a reader that deep-compares it on each patch costs
// O(board) per reader per event.

type Board = { tasks: Task[]; projects: []; tags: []; taskTags: []; blockedTaskIds: [] }

const row = (i: number): Task => ({ id: `t${i}`, title: `Task ${i}`, status: 'inbox' }) as Task
const board = (tasks: Task[]): Board => ({
  tasks,
  projects: [],
  tags: [],
  taskTags: [],
  blockedTaskIds: []
})

function boardQuery(queryClient: QueryClient) {
  const q = queryClient
    .getQueryCache()
    .getAll()
    .find((x) => JSON.stringify(x.queryKey).includes('"loadBoardData"'))
  if (!q) throw new Error('board query not in cache')
  return q
}

function setup() {
  const t = createTrpcTest({
    procedures: { 'task.loadBoardData': () => board([row(1), row(2), row(3)]) }
  })
  return t
}

afterEach(cleanup)

it('disabled readers do not observe the board', async () => {
  const { wrapper, queryClient } = setup()
  const active = renderHook(() => useBoardTasks({ enabled: true }), { wrapper })
  for (let i = 0; i < 5; i++) renderHook(() => useBoardTasks({ enabled: false }), { wrapper })
  await waitFor(() => expect(active.result.current).toHaveLength(3))
  expect(boardQuery(queryClient).getObserversCount()).toBe(1)
})

it('returns the board rows themselves across row patches', async () => {
  const { wrapper, queryClient } = setup()
  const { result } = renderHook(() => useBoardTasks({ enabled: true }), { wrapper })
  await waitFor(() => expect(result.current).toHaveLength(3))
  const key = boardQuery(queryClient).queryKey

  // Two successive single-row patches, as `tasks-changed` row patches apply them.
  for (const title of ['renamed', 'renamed again']) {
    act(() => {
      queryClient.setQueryData<Board>(key, (prev) =>
        board(prev!.tasks.map((t) => (t.id === 't2' ? { ...t, title } : t)))
      )
    })
    await waitFor(() => expect(result.current?.[1]?.title).toBe(title))
    expect(result.current).toBe(queryClient.getQueryData<Board>(key)!.tasks)
  }
})

it('a disabled reader that becomes enabled reads the current board', async () => {
  const { wrapper } = setup()
  const { result, rerender } = renderHook(
    ({ enabled }: { enabled: boolean }) => useBoardTasks({ enabled }),
    { wrapper, initialProps: { enabled: false } }
  )
  expect(result.current).toBeUndefined()
  rerender({ enabled: true })
  await waitFor(() => expect(result.current?.map((t) => t.id)).toEqual(['t1', 't2', 't3']))
})

it("a reader mounting later never refetches the default hub's board (pushes keep it fresh)", async () => {
  let loads = 0
  const t = createTrpcTest({
    procedures: {
      'task.loadBoardData': () => {
        loads++
        return board([row(1)])
      }
    }
  })
  const first = renderHook(() => useBoardTasks({ enabled: true }), { wrapper: t.wrapper })
  await waitFor(() => expect(first.result.current).toHaveLength(1))
  // Long past any staleTime: a stale query would refetch for the next observer.
  boardQuery(t.queryClient).setState({ dataUpdatedAt: Date.now() - 10 * 60_000 })
  const later = renderHook(() => useBoardTasks({ enabled: true }), { wrapper: t.wrapper })
  await waitFor(() => expect(later.result.current).toHaveLength(1))
  await new Promise((r) => setTimeout(r, 50))
  expect(loads).toBe(1)
})

it('a board sent as columns reaches readers as rows', async () => {
  const t = createTrpcTest({
    procedures: {
      'task.loadBoardData': () => ({
        ...board([]),
        taskColumns: { keys: ['id', 'title', 'status'], values: [['c1', 'Col', 'todo']] }
      })
    }
  })
  const { result } = renderHook(() => useBoardTasks({ enabled: true }), { wrapper: t.wrapper })
  await waitFor(() => expect(result.current).toEqual([{ id: 'c1', title: 'Col', status: 'todo' }]))
})
