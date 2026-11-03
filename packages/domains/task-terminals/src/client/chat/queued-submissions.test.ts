import { expect, test, vi } from 'vitest'
import {
  createQueuedSubmissions,
  parseQueuedSubmission,
  type QueuedSubmission
} from './queued-submissions'

function fixture(deliver = vi.fn(async (_entry: QueuedSubmission) => {})) {
  const records = new Map<string, QueuedSubmission>()
  const storage = {
    list: async () => [...records.values()],
    put: async (entry: QueuedSubmission) => {
      records.set(entry.id, structuredClone(entry))
    },
    remove: async (id: string) => {
      records.delete(id)
    }
  }
  let next = 0
  const open = () =>
    createQueuedSubmissions({ storage, deliver, createId: () => `message-${++next}` })
  return { records, storage, deliver, open }
}
const input = {
  send: 'expanded',
  original: '/command',
  content: [{ type: 'text' as const, text: 'expanded' }]
}

test('lost acknowledgement retries one durable identity across editor remount without changing payload', async () => {
  const accepted = new Set<string>()
  let loseAck = true
  const f = fixture(
    vi.fn(async (entry) => {
      accepted.add(entry.id)
      if (loseAck) throw new Error('Acknowledgement lost')
    })
  )
  await expect(f.open().push(input)).rejects.toThrow('Acknowledgement lost')
  const [saved] = [...f.records.values()]
  expect(saved).toMatchObject({ ...input, state: 'failed' })
  loseAck = false
  const reopened = f.open()
  await reopened.push(input)
  expect(f.deliver.mock.calls.map(([entry]) => entry.id)).toEqual([saved.id, saved.id])
  expect(accepted.size).toBe(1)
  expect(f.records.size).toBe(0)
})

test('pending double submit joins one attempt; later edits keep independent durable entries', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = fixture(
    vi.fn(async () => {
      await gate
      throw new Error('Offline')
    })
  )
  const manager = f.open()
  const first = manager.push(input).catch(() => {})
  const duplicate = manager.push(input).catch(() => {})
  const later = manager.push({ ...input, original: 'later', send: 'later' }).catch(() => {})
  await vi.waitFor(() => expect(f.deliver).toHaveBeenCalledTimes(2))
  expect(f.records.size).toBe(2)
  release()
  await Promise.all([first, duplicate, later])
  expect([...f.records.values()].map((entry) => entry.original)).toEqual(['/command', 'later'])
})

test('journal failure refuses network delivery, preserving composer as the only copy', async () => {
  const f = fixture()
  f.storage.put = async () => {
    throw new Error('Disk full')
  }
  await expect(f.open().push(input)).rejects.toThrow('Disk full')
  expect(f.deliver).not.toHaveBeenCalled()
})

test('slow earlier journal staging cannot reorder later queue RPC admission', async () => {
  const f = fixture()
  let release!: () => void
  const staged = new Promise<void>((resolve) => {
    release = resolve
  })
  const put = f.storage.put
  f.storage.put = async (entry) => {
    if (entry.original === '/command') await staged
    await put(entry)
  }
  const manager = f.open()
  const first = manager.push(input)
  const second = manager.push({ ...input, send: 'later', original: 'later' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(f.deliver).not.toHaveBeenCalled()
  release()
  await Promise.all([first, second])
  expect(f.deliver.mock.calls.map(([entry]) => entry.original)).toEqual(['/command', 'later'])
})

test.each([
  null,
  {},
  { type: 'tool-result' },
  { type: 'attachment', attachment: {} },
  { type: 'text', text: 2 }
])('corrupt journal content is not a retryable submission: %j', (block) => {
  expect(
    parseQueuedSubmission(
      JSON.stringify({ ...input, id: 'message', createdAt: 1, state: 'failed', content: [block] })
    )
  ).toBeNull()
})

test('an acknowledged message stays accepted when local journal cleanup fails; retry still uses its identity', async () => {
  const f = fixture()
  f.storage.remove = async () => {
    throw new Error('Local storage unavailable')
  }
  const manager = f.open()
  await expect(manager.push(input)).resolves.toBeUndefined()
  expect(manager.getSnapshot()[0].error).toContain('Message accepted')
  await manager.push(input)
  expect(new Set(f.deliver.mock.calls.map(([entry]) => entry.id)).size).toBe(1)
})

test('provider change creates a new intent while retry preserves the old expected provider', async () => {
  const f = fixture(
    vi.fn(async () => {
      throw new Error('Offline')
    })
  )
  const manager = f.open()
  await manager.push({ ...input, expectedMode: 'claude-chat' }).catch(() => {})
  const firstId = manager.getSnapshot()[0].id
  await manager.push({ ...input, expectedMode: 'codex-chat' }).catch(() => {})
  expect(manager.getSnapshot()).toHaveLength(2)
  await manager.retry(firstId).catch(() => {})
  expect(f.deliver.mock.calls.at(-1)?.[0]).toMatchObject({
    id: firstId,
    expectedMode: 'claude-chat'
  })
})

test('stage resolves once the message is saved on this device, before the hub confirms it', async () => {
  let confirm!: () => void
  const f = fixture(
    vi.fn(
      () =>
        new Promise<void>((resolve) => {
          confirm = resolve
        })
    )
  )
  const queue = f.open()
  await queue.stage(input)
  // Saved and shown as pending; the hub has not answered yet.
  expect([...f.records.values()]).toEqual([expect.objectContaining({ ...input, state: 'pending' })])
  expect(queue.getSnapshot()).toEqual([expect.objectContaining({ state: 'pending' })])
  confirm()
  await vi.waitFor(() => expect(queue.getSnapshot()).toEqual([]))
  expect(f.records.size).toBe(0)
})

test('stage: a delivery that fails after saving leaves a failed entry with why (nothing lost)', async () => {
  const f = fixture(
    vi.fn(async () => {
      throw new Error('Computer offline')
    })
  )
  const queue = f.open()
  await expect(queue.stage(input)).resolves.toBeUndefined()
  await vi.waitFor(() =>
    expect(queue.getSnapshot()).toEqual([
      expect.objectContaining({ state: 'failed', error: 'Computer offline' })
    ])
  )
  expect([...f.records.values()]).toEqual([expect.objectContaining({ state: 'failed' })])
})

test('stage: a message that could not be saved on this device rejects (the draft stays)', async () => {
  const f = fixture()
  f.storage.put = async () => {
    throw new Error('Disk full')
  }
  await expect(f.open().stage(input)).rejects.toThrow('Disk full')
  expect(f.deliver).not.toHaveBeenCalled()
})
