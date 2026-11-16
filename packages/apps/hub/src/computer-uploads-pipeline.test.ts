import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createComputerChatRuntime } from '@slayzone/chat-runtime/server'
import { expect, test, vi } from 'vitest'
import { uploadBytesFor, withUploadedBytes, type UploadBytes } from './computer-uploads'

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

// This crosses hub upload negotiation and computer-owned staging, so it belongs
// to the composing app, which depends on chat-runtime (never the reverse).
test.each([true, false])(
  'parallel identical uploads complete with owned mode=%s, even across consumers',
  async (owned) => {
    const root = await mkdtemp(join(tmpdir(), 'hub-upload-concurrent-'))
    const r = createComputerChatRuntime({
      stateDir: root,
      hubScope: 'hub',
      computerId: 'pc',
      maintenance: true
    })
    const routes = [
      { id: 'alice', epoch: 1 },
      { id: 'bob', epoch: 1 }
    ]
    try {
      for (const { id } of routes)
        r.bootstrap({
          identity: { id, taskId: id, tabId: `${id}-tab`, mode: 'claude-chat', epoch: 1 },
          projectId: null,
          cwd: r.storage.dir,
          revision: 1,
          providerConfig: {},
          defaultFlags: null,
          env: {}
        })
      const send = async (raw: unknown) => {
        const p = raw as {
          kind: string
          sha256: string
          size: number
          offset: number
          data: string
          route?: { id: string; epoch: number }
          operationId?: string
          uploadId?: string
        }
        return p.kind === 'upload.begin'
          ? r.uploads.begin(
              p.sha256,
              p.size,
              p.route ? { route: p.route, operationId: p.operationId! } : undefined
            )
          : r.uploads.chunk(
              p.sha256,
              p.size,
              p.offset,
              Buffer.from(p.data, 'base64'),
              p.uploadId ? { route: p.route!, uploadId: p.uploadId } : undefined
            )
      }
      const results = await Promise.allSettled(
        routes.map(async (route) => {
          const result = await uploadBytesFor({
            bounded: true,
            source: bytes,
            send,
            ...(owned ? { owner: { route, operationId: `upload-${route.id}` } } : {})
          })
          if (!('staged' in result)) throw new Error('expected staged bytes')
          const lease = await r.uploads.acquire(result.staged, route)
          try {
            await new Promise((resolve) => setTimeout(resolve, 0))
            expect((await readFile(lease.path)).equals(bytes)).toBe(true)
          } finally {
            await lease.release()
          }
        })
      )
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
    } finally {
      await r.close()
      await rm(root, { recursive: true, force: true })
    }
  }
)
