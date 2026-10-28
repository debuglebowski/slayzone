// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Task } from '@slayzone/task-contracts'

const task = (id: string, title: string, status = 'todo'): Task =>
  ({ id, title, status, project_id: 'p1', priority: 3 }) as unknown as Task

const ALL_TASKS = [
  task('t1', 'Self'),
  task('t2', 'Candidate A'),
  task('t3', 'Already blocking'),
  task('t4', 'Finished', 'done')
]

const getAllOptions = vi.fn((_input: unknown, opts?: { enabled?: boolean }) => ({
  queryKey: ['task.getAll'],
  queryFn: async () => ALL_TASKS,
  ...opts
}))
const getBlockersOptions = vi.fn((input: { taskId: string }, opts?: { enabled?: boolean }) => ({
  queryKey: ['task.getBlockers', input.taskId],
  queryFn: async () => [ALL_TASKS[2]],
  ...opts
}))

vi.mock('@slayzone/transport/client', () => ({
  useTRPC: () => ({
    task: {
      getAll: { queryOptions: getAllOptions },
      getBlockers: { queryOptions: getBlockersOptions },
      addBlocker: { mutationOptions: () => ({ mutationFn: async () => undefined }) }
    }
  })
}))

import { BlockerDialog } from './BlockerDialog'

function renderDialog(taskId: string | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // Cached task list present, as on a live board: closed dialogs must not
  // subscribe to it (every list update would re-filter in each of them).
  client.setQueryData(['task.getAll'], ALL_TASKS)
  const ui = (id: string | null) => (
    <QueryClientProvider client={client}>
      <BlockerDialog taskId={id} onClose={() => {}} />
    </QueryClientProvider>
  )
  const r = render(ui(taskId))
  return { client, rerender: (id: string | null) => r.rerender(ui(id)) }
}

afterEach(cleanup)
beforeEach(() => vi.clearAllMocks())

describe('BlockerDialog', () => {
  it('closed: no task-list query observers, no filtering work', () => {
    const { client } = renderDialog(null)
    expect(getAllOptions).not.toHaveBeenCalled()
    expect(getBlockersOptions).not.toHaveBeenCalled()
    expect(
      client
        .getQueryCache()
        .find({ queryKey: ['task.getAll'] })
        ?.getObserversCount()
    ).toBe(0)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('open: lists non-terminal tasks that are not self or already blocking', async () => {
    const { client } = renderDialog('t1')
    expect(await screen.findByText('Candidate A')).toBeTruthy()
    expect(screen.queryByText('Self')).toBeNull()
    expect(screen.queryByText('Finished')).toBeNull()
    expect(await screen.findByRole('button', { name: /Candidate A/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Already blocking/ })).toBeNull()
    expect(
      client
        .getQueryCache()
        .find({ queryKey: ['task.getAll'] })
        ?.getObserversCount()
    ).toBe(1)
  })

  it('close releases the subscriptions', async () => {
    const { client, rerender } = renderDialog('t1')
    await screen.findByText('Candidate A')
    rerender(null)
    await vi.waitFor(() =>
      expect(
        client
          .getQueryCache()
          .find({ queryKey: ['task.getAll'] })
          ?.getObserversCount()
      ).toBe(0)
    )
  })
})
