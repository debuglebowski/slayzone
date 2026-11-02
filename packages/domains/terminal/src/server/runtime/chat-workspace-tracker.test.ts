import { expect, it } from 'vitest'
import { ChatWorkspaceTracker } from './chat-workspace-tracker'

it('takes one baseline per turn and waits for final capture before another turn', async () => {
  const calls: string[] = []
  let release!: () => void
  const finishing = new Promise<void>((r) => {
    release = r
  })
  const events: unknown[] = []
  const tracker = new ChatWorkspaceTracker({
    backend: {
      begin: async () => {
        calls.push('begin')
        return { status: 'ready' }
      },
      finish: async () => {
        calls.push('finish')
        await finishing
        return { status: 'complete', files: [] }
      },
      discard: async () => {
        calls.push('discard')
      }
    },
    store: { begin: async () => {}, save: async () => {}, get: async () => null },
    emit: (event) => events.push(event)
  })
  const ctx = { tabId: 'tab', gen: 1, rootPath: '/repo', computerId: 'computer', projectId: null }
  await tracker.beforeSend(ctx, 'first')
  await tracker.beforeSend(ctx, 'steer')
  expect(calls).toEqual(['begin'])
  const end = tracker.finish(1)
  const next = tracker.beforeSend(ctx, 'second')
  await Promise.resolve()
  expect(calls).toEqual(['begin', 'finish'])
  release()
  await Promise.all([end, next])
  expect(calls).toEqual(['begin', 'finish', 'discard', 'begin'])
  expect(events).toContainEqual(
    expect.objectContaining({ kind: 'workspace-changes', messageId: 'first', status: 'complete' })
  )
})

it('reports failed baseline and unconfirmed exit without taking a misleading final snapshot', async () => {
  const events: unknown[] = []
  let finishes = 0
  const tracker = new ChatWorkspaceTracker({
    backend: {
      begin: async () => ({ status: 'ready' }),
      finish: async () => {
        finishes++
        throw new Error()
      },
      discard: async () => {}
    },
    store: { begin: async () => {}, save: async () => {}, get: async () => null },
    emit: (event) => events.push(event)
  })
  await tracker.beforeSend(
    { tabId: 'tab', gen: 1, rootPath: '/repo', computerId: null, projectId: null },
    'message'
  )
  await tracker.finish(2)
  expect(finishes).toBe(0)
  await tracker.finish(1, 'Computer disconnected before turn completion.')
  expect(finishes).toBe(0)
  expect(events.at(-1)).toMatchObject({
    status: 'unavailable',
    interrupted: true,
    reason: 'Computer disconnected before turn completion.'
  })
})

it('shares an in-flight baseline and discards a withdrawn message before the next capture', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  const calls: string[] = []
  const events: unknown[] = []
  const tracker = new ChatWorkspaceTracker({
    backend: {
      begin: async () => {
        calls.push('begin')
        await gate
        return { status: 'ready' }
      },
      finish: async () => ({ status: 'complete', files: [] }),
      discard: async () => {
        calls.push('discard')
      }
    },
    store: {
      begin: async () => {},
      save: async () => {},
      get: async () => null,
      remove: async () => {
        calls.push('remove')
      }
    },
    emit: (event) => events.push(event)
  })
  const ctx = { tabId: 'tab', gen: 1, rootPath: '/repo', computerId: null }
  let secondSent = false
  const first = tracker.beforeSend(ctx, 'first')
  const second = tracker.beforeSend(ctx, 'steer').then(() => {
    secondSent = true
  })
  await Promise.resolve()
  await Promise.resolve()
  expect(secondSent).toBe(false)
  expect(calls).toEqual(['begin'])
  tracker.cancel('first')
  release()
  await Promise.all([first, second])
  await tracker.beforeSend(ctx, 'replacement')
  expect(calls).toEqual(['begin', 'remove', 'discard', 'begin'])
  expect(events).toEqual([])
})

it('marks autonomous turns without a baseline unavailable instead of guessing from HEAD', async () => {
  const events: unknown[] = []
  const tracker = new ChatWorkspaceTracker({
    backend: {
      begin: async () => {
        throw new Error('must not capture a late baseline')
      },
      finish: async () => {
        throw new Error('must not capture')
      },
      discard: async () => {}
    },
    store: { begin: async () => {}, save: async () => {}, get: async () => null },
    emit: (event) => events.push(event)
  })
  tracker.observeAgentTurn({ tabId: 'tab', gen: 1, rootPath: '/repo', computerId: null })
  await tracker.finish(1)
  expect(events.at(-1)).toMatchObject({ status: 'unavailable' })
})
