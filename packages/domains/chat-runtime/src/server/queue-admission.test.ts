import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { createChatQueueRuntime, type QueueAdmission } from '@slayzone/terminal/runtime'
import type { SlayzoneDb } from '@slayzone/platform'
import { createComputerChatRuntime } from './computer-runtime'

const dirs: string[] = []
const runtimes: Array<ReturnType<typeof createComputerChatRuntime>> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.useRealTimers()
})
const identity = { id: 'storage', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 1 }
function fixture(dir = mkdtempSync(join(tmpdir(), 'computer-queue-admission-'))) {
  if (!dirs.includes(dir)) dirs.push(dir)
  const r = createComputerChatRuntime({ stateDir: dir, hubScope: 'hub', computerId: 'pc' })
  runtimes.push(r)
  r.bootstrap({
    identity,
    projectId: null,
    cwd: dir,
    revision: 1,
    providerConfig: {},
    defaultFlags: null,
    env: {}
  })
  const invoke = (method: string, args: unknown[], operationId: string) =>
    r.invoke({
      route: { id: identity.id, epoch: identity.epoch },
      target: 'queue',
      method,
      args,
      operationId
    })
  return {
    r,
    dir,
    invoke,
    reserve: (id: string, key: string, inputHash = 'input-hash') =>
      invoke('reserve', ['tab', id, key, inputHash], key + '-reserve') as Promise<QueueAdmission>,
    push: (id: string, admission?: QueueAdmission) =>
      invoke(
        'push',
        [
          'tab',
          id,
          id,
          {
            id,
            ...(admission ? { admission: { key: admission.key, token: admission.token } } : {})
          }
        ],
        id + '-push'
      )
  }
}

test('a reserved head blocks later ready items until its attachments finish; receipt replay preserves order', async () => {
  const f = fixture()
  const first = await f.reserve('first', 'first-admission')
  expect(await f.reserve('first', 'first-admission')).toEqual(first)
  await expect(f.reserve('first', 'first-admission', 'changed-input')).rejects.toThrow(
    'different input'
  )
  await f.push('second')
  expect(await f.r.local.queue.pop('tab')).toBeNull()
  const committed = await f.push('first', first)
  expect((await f.r.queueOps.list('tab')).map((m) => m.id)).toEqual(['first', 'second'])
  await f.r.close()
  const next = fixture(f.dir)
  expect(await next.push('first', first)).toEqual(committed)
  expect((await next.r.queueOps.list('tab')).map((m) => m.id)).toEqual(['first', 'second'])
  expect(
    next.r.storage.findRecords('settings', undefined, { idPrefix: 'queue-admission:' })
  ).toEqual([])
})

test('clear cancels a pending upload and fences its late completion', async () => {
  const f = fixture()
  const first = await f.reserve('first', 'first-admission')
  await f.push('second')
  expect(await f.invoke('clear', ['tab'], 'clear')).toBe(1)
  await expect(f.push('first', first)).rejects.toThrow('cancelled or expired')
  expect(await f.r.queueOps.list('tab')).toEqual([])
  expect(f.r.storage.findRecords('settings', undefined, { idPrefix: 'queue-admission:' })).toEqual(
    []
  )
})

test('restart cancels unfinished admission without losing a later acknowledged message', async () => {
  const f = fixture()
  const first = await f.reserve('first', 'first-admission')
  await f.push('second')
  await f.r.close()
  const next = fixture(f.dir)
  expect((await next.r.local.queue.pop('tab'))?.id).toBe('second')
  await expect(next.push('first', first)).rejects.toThrow('cancelled or expired')
  expect((await next.r.queueOps.list('tab')).map((m) => m.id)).toEqual(['second'])
})

test('deleting a conversation fences pending admission across restart', async () => {
  const f = fixture()
  const first = await f.reserve('first', 'first-admission')
  await f.r.deleteConversation(identity)
  await expect(f.push('first', first)).rejects.toThrow(/deleted/)
  await f.r.close()
  const r = createComputerChatRuntime({ stateDir: f.dir, hubScope: 'hub', computerId: 'pc' })
  runtimes.push(r)
  expect(r.storage.conversation(identity.id)?.state).toBe('deleted')
  expect(r.storage.findRecords('settings', undefined, { idPrefix: 'queue-admission:' })).toEqual([])
})

test('failed attachment admission releases its slot and leaves the queue usable', async () => {
  const f = fixture()
  await expect(
    f.r.queueOps.push('tab', 'missing', 'missing', {
      id: 'missing',
      content: [
        {
          type: 'attachment',
          attachment: {
            artifactId: 'absent',
            name: 'context.txt',
            kind: 'text',
            mediaType: 'text/plain',
            size: 1
          }
        }
      ]
    })
  ).rejects.toThrow()
  expect(f.r.storage.findRecords('settings', undefined, { idPrefix: 'queue-admission:' })).toEqual(
    []
  )
  await f.push('second')
  expect((await f.r.local.queue.pop('tab'))?.id).toBe('second')
})

test('leases renew only for their owner; cancellation allows waiting messages to proceed', async () => {
  const f = fixture()
  const first = await f.reserve('first', 'first-admission')
  await f.push('second')
  await expect(f.invoke('renewReservation', ['foreign-tab', first], 'foreign')).rejects.toThrow(
    'ownership'
  )
  await expect(
    f.invoke('renewReservation', ['tab', { ...first, token: 'foreign-token' }], 'bad-token')
  ).rejects.toThrow('cancelled or expired')
  const now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 100_000)
  const renewed = (await f.invoke('renewReservation', ['tab', first], 'renew')) as QueueAdmission
  expect(renewed.expiresAt).toBeGreaterThan(first.expiresAt)
  clock.mockReturnValue(now + 120_001)
  expect(await f.r.local.queue.pop('tab')).toBeNull()
  await f.invoke('cancelReservation', ['tab', first], 'cancel')
  expect((await f.r.local.queue.pop('tab'))?.id).toBe('second')
})

test('an abandoned hub lease wakes the drainer after expiry without another request', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const f = fixture()
  const sent: string[] = []
  let ready = true
  const runtime = createChatQueueRuntime({
    dispatchUserMessage: (tabId, message) => {
      sent.push(message.id)
      ready = false
      void f.r.local.queue.remove(message.id)
      return { id: message.id, state: 'queued' }
    },
    ensureSpawned: async () => {
      throw new Error('Queue fixture is already spawned')
    },
    getEventBufferSince: () => [],
    getSessionTerminalState: () => 'idle',
    getSessionInfo: () => null,
    isReadyForQueuedMessage: () => ready,
    registerChatQueueDrainer: () => {}
  })
  const ops = runtime.createChatQueueOps(
    {} as SlayzoneDb,
    f.r.local.queue,
    f.r.local.data.attachments
  )
  try {
    const first = await ops.reserve('tab', 'first', 'first-admission')
    await ops.push('tab', 'second', 'second', { id: 'second' })
    expect(sent).toEqual([])
    await vi.advanceTimersByTimeAsync(119_999)
    expect(sent).toEqual([])
    await vi.advanceTimersByTimeAsync(2)
    expect(sent).toEqual(['second'])
    await expect(
      ops.push('tab', 'first', 'first', { id: 'first', admission: first })
    ).rejects.toThrow('cancelled or expired')
  } finally {
    await runtime.close()
  }
})
