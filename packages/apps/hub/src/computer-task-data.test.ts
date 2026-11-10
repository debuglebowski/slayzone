/**
 * Task data through the hub relay (robustness plan §9): the computer holding the task's
 * data answers; the hub keeps no copy, so an offline computer is an answer, not an error.
 */
import { expect, test } from 'vitest'
import { createComputerTaskDataRelay } from './computer-task-data'

function fixture(over: { usable?: boolean; target?: string | null } = {}) {
  const calls: Array<{ computerId: string; request: unknown }> = []
  const flushed: Array<[string, string]> = []
  const relay = createComputerTaskDataRelay({
    target: async () => (over.target === undefined ? 'pc' : over.target),
    usable: () => over.usable ?? true,
    flushTask: async (taskId, computerId) => {
      flushed.push([taskId, computerId])
    },
    request: async (computerId, request) => {
      calls.push({ computerId, request })
      return { computerId, storeId: 's', lifecycle: 'active' }
    }
  })
  return { relay, calls, flushed }
}

test('relays a read to the computer holding the task, after handing it the hub’s rows', async () => {
  const f = fixture()
  expect(await f.relay.read('t1', { kind: 'describe' })).toEqual({
    ok: true,
    value: { computerId: 'pc', storeId: 's', lifecycle: 'active' }
  })
  expect(f.flushed).toEqual([['t1', 'pc']])
  expect(f.calls).toEqual([
    { computerId: 'pc', request: { kind: 'taskData', taskId: 't1', request: { kind: 'describe' } } }
  ])
})

test('no connected computer: computer-offline, nothing sent', async () => {
  for (const f of [fixture({ usable: false }), fixture({ target: null })]) {
    expect(await f.relay.read('t1', { kind: 'describe' })).toEqual({
      ok: false,
      unavailable: 'computer-offline'
    })
    expect(f.calls).toEqual([])
  }
})

test('an invalid request is refused before it reaches a computer', async () => {
  const f = fixture()
  await expect(f.relay.read('t1', { kind: 'nope' } as never)).rejects.toThrow()
  expect(f.calls).toEqual([])
})
