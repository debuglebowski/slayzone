import { describe, expect, it } from 'vitest'
import type { DirectLease, DirectLinkManager } from './direct-link'
import { readTaskData } from './direct-task-data'

function manager(read: (input: unknown) => Promise<unknown>, available = true) {
  const acquired: unknown[] = []
  let released = 0
  const lease = {
    computerId: 'pc',
    client: { task: { read: { query: read } } },
    onLost: () => () => undefined,
    release: () => {
      released++
    }
  } as unknown as DirectLease
  const m = {
    acquire: async (target: unknown) => {
      acquired.push(target)
      return available ? lease : null
    }
  } as unknown as DirectLinkManager
  return { m, acquired, released: () => released }
}

const relayed = { ok: true as const, value: 'relay' }

describe('readTaskData', () => {
  it('reads over the direct link when a lease is granted, then releases it', async () => {
    const f = manager(async (input) => ({ via: 'direct', input }))
    const out = await readTaskData({
      manager: f.m,
      taskId: 't1',
      request: { kind: 'describe' },
      relay: async () => relayed
    })
    expect(out).toEqual({
      ok: true,
      value: { via: 'direct', input: { taskId: 't1', request: { kind: 'describe' } } }
    })
    expect(f.acquired).toEqual([{ kind: 'task', taskId: 't1' }])
    expect(f.released()).toBe(1)
  })

  it('uses the hub relay without a manager, without a lease, or when the grant ended', async () => {
    const relay = async () => relayed
    expect(await readTaskData({ manager: null, taskId: 't', request: {}, relay })).toEqual(relayed)
    expect(
      await readTaskData({
        manager: manager(async () => 1, false).m,
        taskId: 't',
        request: {},
        relay
      })
    ).toEqual(relayed)
    const refused = manager(async () => {
      throw Object.assign(new Error('no capability'), { data: { code: 'FORBIDDEN' } })
    })
    expect(await readTaskData({ manager: refused.m, taskId: 't', request: {}, relay })).toEqual(
      relayed
    )
    expect(refused.released()).toBe(1)
  })

  it('an answer from the computer stands (not retried through the hub)', async () => {
    const f = manager(async () => {
      throw Object.assign(new Error('bad request'), { data: { code: 'BAD_REQUEST' } })
    })
    let relayCalls = 0
    await expect(
      readTaskData({
        manager: f.m,
        taskId: 't',
        request: {},
        relay: async () => {
          relayCalls++
          return relayed
        }
      })
    ).rejects.toThrow('bad request')
    expect(relayCalls).toBe(0)
  })
})
