import { createHash } from 'node:crypto'
import { expect, test, vi } from 'vitest'
import { withUploadedBytes, type UploadBytes } from './computer-uploads'

const bytes = Buffer.alloc(600_000, 65)
function receiver(owned: boolean) {
  const slots = new Map<string, Buffer>()
  const offsets: number[] = []
  let loseAck = false
  return {
    slots,
    offsets,
    loseNextAck: () => {
      loseAck = true
    },
    send: async (raw: unknown) => {
      const p = raw as {
        kind: string
        operationId?: string
        uploadId?: string
        sha256: string
        offset: number
        data: string
      }
      const key = owned
        ? (p.uploadId ?? createHash('sha256').update(p.operationId!).digest('hex'))
        : p.sha256
      const current = slots.get(key) ?? Buffer.alloc(0)
      if (p.kind === 'upload.begin') {
        slots.set(key, current)
        return { received: current.length, ...(owned ? { uploadId: key } : {}) }
      }
      if (p.offset !== current.length) throw new Error('legacy/shared offset race')
      offsets.push(p.offset)
      slots.set(key, Buffer.concat([current, Buffer.from(p.data, 'base64')]))
      if (loseAck) {
        loseAck = false
        throw new Error('lost acknowledgement')
      }
      return { received: slots.get(key)!.length }
    },
    key: (payload: UploadBytes) => {
      if (!('staged' in payload)) throw new Error('expected staged bytes')
      return payload.staged.uploadId ?? payload.staged.sha256
    }
  }
}
const owner = (operationId: string) => ({ route: { id: 'conversation', epoch: 1 }, operationId })

test('legacy compatibility slot remains locked until its consumer completes', async () => {
  const remote = receiver(false)
  const trace: string[] = []
  await Promise.all(
    ['one', 'two'].map((operationId) =>
      withUploadedBytes(
        {
          bounded: true,
          computerId: 'legacy-pc',
          owner: owner(operationId),
          source: bytes,
          send: remote.send
        },
        async (payload) => {
          trace.push(`start ${operationId}`)
          const key = remote.key(payload)
          expect(remote.slots.get(key)?.equals(bytes)).toBe(true)
          await new Promise((resolve) => setTimeout(resolve, 0))
          remote.slots.delete(key)
          trace.push(`end ${operationId}`)
        }
      )
    )
  )
  expect(trace).toEqual(['start one', 'end one', 'start two', 'end two'])
})

test('owned acknowledgement permits concurrent independent consumers of identical bytes', async () => {
  const remote = receiver(true)
  let resume!: () => void
  const gate = new Promise<void>((resolve) => {
    resume = resolve
  })
  let started = 0
  const pending = Promise.all(
    ['one', 'two'].map((operationId) =>
      withUploadedBytes(
        {
          bounded: true,
          computerId: 'owned-pc',
          owner: owner(operationId),
          source: bytes,
          send: remote.send
        },
        async (payload) => {
          started++
          const key = remote.key(payload)
          expect(remote.slots.get(key)?.equals(bytes)).toBe(true)
          await gate
          remote.slots.delete(key)
        }
      )
    )
  )
  const outcome = pending.catch((error: unknown) => error)
  try {
    await vi.waitFor(() => expect(started).toBe(2))
  } finally {
    resume()
    await outcome
  }
  await pending
})

test('a failed legacy consumer releases the compatibility gate for the next upload', async () => {
  const remote = receiver(false)
  const results = await Promise.allSettled(
    ['bad', 'good'].map((operationId) =>
      withUploadedBytes(
        {
          bounded: true,
          computerId: 'failed-legacy-pc',
          owner: owner(operationId),
          source: bytes,
          send: remote.send
        },
        async (payload) => {
          const key = remote.key(payload)
          expect(remote.slots.get(key)?.equals(bytes)).toBe(true)
          if (operationId === 'bad') throw new Error('consumer refused')
          remote.slots.delete(key)
        }
      )
    )
  )
  expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled'])
})

test('a stable operation resumes after a lost chunk acknowledgement', async () => {
  const remote = receiver(true)
  const opts = {
    bounded: true,
    computerId: 'resuming-pc',
    owner: owner('resumable'),
    source: bytes,
    send: remote.send
  }
  remote.loseNextAck()
  await expect(withUploadedBytes(opts, async () => undefined)).rejects.toThrow(
    'lost acknowledgement'
  )
  await withUploadedBytes(opts, async (payload) => {
    expect(remote.slots.get(remote.key(payload))?.equals(bytes)).toBe(true)
  })
  expect(remote.offsets).toEqual([0, 262144, 524288])
})
