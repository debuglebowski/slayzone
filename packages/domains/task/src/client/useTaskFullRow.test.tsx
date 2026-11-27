// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { createTrpcTest } from '@slayzone/transport/testing'
import type { Task } from '@slayzone/task-contracts'
import { mergeTaskRows, useTaskFullRow } from './useTaskFullRow'
import { refreshTaskScopedQueries } from './taskScopedQueries'

afterEach(cleanup)

const full = (extra: Partial<Task> = {}): Task =>
  ({
    id: 't1',
    title: 'Full',
    status: 'todo',
    description: 'body',
    panel_sizes: null,
    ...extra
  }) as Task

it('the board row wins for the fields it carries; the full row fills the rest', () => {
  const board = { id: 't1', title: 'Renamed', status: 'done' } as Task
  expect(mergeTaskRows(board, full())).toMatchObject({
    title: 'Renamed',
    status: 'done',
    description: 'body'
  })
  expect(mergeTaskRows(null, full())).toMatchObject({ title: 'Full' })
  expect(mergeTaskRows(board, undefined)).toBe(board)
  expect(mergeTaskRows(null, undefined)).toBeNull()
})

it('page-only fields come from the full row even when the board row carries them (it may be stale)', () => {
  const board = full({ title: 'Board', description: 'stale' })
  expect(mergeTaskRows(board, full({ title: 'older', description: 'fresh' }))).toMatchObject({
    title: 'Board',
    description: 'fresh'
  })
})

it('reads the task row from task.get, seeded and refreshed by tasks-changed', async () => {
  let description = 'v1'
  const t = createTrpcTest({
    procedures: { 'task.get': () => full({ description }) }
  })
  const { result } = renderHook(() => useTaskFullRow('t1', full({ description: 'seed' })), {
    wrapper: t.wrapper
  })
  expect(result.current?.description).toBe('seed')
  description = 'v2'
  await act(() => refreshTaskScopedQueries(t.queryClient, ['t1']))
  await waitFor(() => expect(result.current?.description).toBe('v2'))
})
