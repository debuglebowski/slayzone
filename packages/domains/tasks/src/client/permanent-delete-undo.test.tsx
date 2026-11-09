// @vitest-environment jsdom
import { expect, test, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { Task } from '@slayzone/task-contracts'
vi.mock('./trpc', () => ({ useTRPCClient: () => ({}), getClientForHub: () => ({}) }))
vi.mock('@slayzone/transport/client', () => ({
  getHubIdForTask: () => undefined,
  useHubOwnershipStore: { getState: () => ({}) }
}))
const { useUndoableTaskActions } = await import('./useUndoableTaskActions')

test('permanent deletion never adds a restore action to Undo', async () => {
  const push = vi.fn(),
    remove = vi.fn(async () => undefined)
  const mutations = {
    tasks: [{ id: 'task', title: 'Private title' } as Task],
    setTasks: vi.fn(),
    updateTask: vi.fn(),
    archiveTask: vi.fn(async () => undefined),
    archiveTasks: vi.fn(async () => []),
    deleteTask: remove,
    bulkDelete: vi.fn(async () => ['task']),
    contextMenuUpdate: vi.fn(async () => undefined),
    bulkContextMenuUpdate: vi.fn(async () => [])
  }
  const { result } = renderHook(() =>
    useUndoableTaskActions(mutations, { push, undo: async () => undefined })
  )
  await act(() => result.current.deleteTask('task'))
  expect(remove).toHaveBeenCalledWith('task')
  expect(push).not.toHaveBeenCalled()
  await act(() => result.current.bulkDelete(['task']))
  expect(push).not.toHaveBeenCalled()
})
