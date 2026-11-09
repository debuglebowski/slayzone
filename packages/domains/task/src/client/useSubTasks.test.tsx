// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { createTrpcTest } from '@slayzone/transport/testing'
import type { Task } from '@slayzone/task-contracts'

const toast = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('@slayzone/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@slayzone/ui')>()),
  toast
}))

const { useSubTasks } = await import('./useSubTasks')

const sub = { id: '00000000-0000-4000-8000-0000000000a1', title: 'Sub' } as Task

async function setup(deleteResult: unknown) {
  // The hub's view: a refused delete keeps the row, any other result drops it.
  let rows = [sub]
  const { wrapper } = createTrpcTest({
    procedures: {
      'task.getSubTasks': () => rows,
      'task.delete': () => {
        const refused = deleteResult === false || (deleteResult as { blocked?: true }).blocked
        if (!refused) rows = []
        return deleteResult
      }
    }
  })
  const hook = renderHook(() => useSubTasks('parent'), { wrapper })
  await waitFor(() => expect(hook.result.current.subTasks).toHaveLength(1))
  return hook
}

beforeEach(() => vi.clearAllMocks())
afterEach(cleanup)

it('a subtask linked to a provider stays and the user is told why', async () => {
  const { result } = await setup({ blocked: true, reason: 'linked_to_provider' })
  await act(async () => {
    await expect(result.current.deleteSubTask(sub.id)).rejects.toThrow()
    await new Promise((r) => setTimeout(r, 10))
  })
  expect(toast.error).toHaveBeenCalledWith(
    'Unlink this task from its external provider before deleting it.'
  )
  expect(result.current.subTasks.map((s) => s.id)).toEqual([sub.id])
})

it('a subtask the hub did not delete stays', async () => {
  const { result } = await setup(false)
  await act(async () => {
    await expect(result.current.deleteSubTask(sub.id)).rejects.toThrow()
    await new Promise((r) => setTimeout(r, 10))
  })
  expect(result.current.subTasks.map((s) => s.id)).toEqual([sub.id])
})

it('incomplete erasure removes the subtask and warns like the main delete path', async () => {
  const { result } = await setup({ incomplete: true, erasure: { computers: [] } })
  await act(() => result.current.deleteSubTask(sub.id))
  await waitFor(() => expect(result.current.subTasks).toEqual([]))
  expect(toast.warning).toHaveBeenCalledWith('Some data has not been deleted. Cleanup will retry.')
})

it('a completed delete removes the subtask and reports success', async () => {
  const { result } = await setup(true)
  await act(() => result.current.deleteSubTask(sub.id))
  await waitFor(() => expect(result.current.subTasks).toEqual([]))
  expect(toast.success).toHaveBeenCalledWith('Task permanently deleted.')
})
