import { afterEach, expect, test, vi } from 'vitest'
import { eraseTasksOnComputer } from './erasure-fanout'

afterEach(() => vi.restoreAllMocks())

test('one task the computer cannot erase does not stop the others', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const replies = await eraseTasksOnComputer({
    taskIds: ['a', 'bad', 'c'],
    revisionOf: async () => 2,
    erase: async (taskId, revision) => {
      if (taskId === 'bad') throw new Error('Restored archive could not be erased yet')
      return { taskId, revision, erased: true }
    }
  })
  expect(replies.map((r) => r.taskId)).toEqual(['a', 'c'])
})

test('an unreachable computer stops the fan-out but keeps the replies already received', async () => {
  const unreachable = Object.assign(new Error('timeout'), { name: 'RpcTimeoutError' })
  const erase = vi.fn(async (taskId: string, revision: number) => {
    if (taskId === 'b') throw unreachable
    return { taskId, revision, erased: true as const }
  })
  const replies = await eraseTasksOnComputer({
    taskIds: ['a', 'b', 'c'],
    revisionOf: async () => 1,
    erase
  })
  expect(replies.map((r) => r.taskId)).toEqual(['a'])
  expect(erase).toHaveBeenCalledTimes(2)
})

test('a missing deletion fence fails only that task', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const replies = await eraseTasksOnComputer({
    taskIds: ['x', 'y'],
    revisionOf: async (taskId) => (taskId === 'x' ? null : 3),
    erase: async (taskId, revision) => ({ taskId, revision, erased: true })
  })
  expect(replies).toEqual([{ taskId: 'y', revision: 3, erased: true }])
})
