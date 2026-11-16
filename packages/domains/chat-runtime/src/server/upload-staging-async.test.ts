import { createHash } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as turn } from 'node:timers/promises'
import { afterEach, expect, test, vi } from 'vitest'
import { BYTE_RANGE_MAX_CHUNK } from '@slayzone/platform/bounded-reads'
import { createUploadStaging, assertUploadsErased } from './upload-staging'

const route = { id: 'alice', epoch: 1 }
const bytes = Buffer.from('private durable bytes')
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const dirs: string[] = []
const stores: ReturnType<typeof createUploadStaging>[] = []
const unlocks: Array<() => void> = []
afterEach(async () => {
  for (const unlock of unlocks.splice(0)) unlock()
  vi.restoreAllMocks()
  for (const s of stores.splice(0)) await s.close()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function setup(options: Parameters<typeof createUploadStaging>[1] = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'upload-async-'))
  dirs.push(dir)
  const probe = await open(join(dir, 'probe'), 'w')
  const prototype = Object.getPrototypeOf(probe)
  await probe.close()
  const s = createUploadStaging(dir, {
    validateOwner: (r) => ({ taskId: r.id, revision: 1 }),
    ...options
  })
  stores.push(s)
  await s.sweep()
  return { dir, s, prototype }
}

test('async canonical authority is registered before its first await and close drains it', async () => {
  let entered = false,
    unblock!: () => void
  const held = new Promise<void>((resolve) => {
    unblock = resolve
  })
  unlocks.push(unblock)
  const { s } = await setup({
    validateOwner: undefined,
    readOwner: async () => {
      entered = true
      await held
      return { taskId: 'alice', revision: 1 }
    }
  })
  const pending = begin(s)
  void pending.catch(() => undefined)
  await until(() => entered)
  let closed = false
  const closing = s.close().then(() => {
    closed = true
  })
  await turn()
  expect(closed).toBe(false)
  unblock()
  await expect(pending).rejects.toThrow(/closed/i)
  await closing
})

test('actual staged-path reservation pins the exact incarnation without main body reads or hashing', async () => {
  const { s, prototype } = await setup()
  const begun = await begin(s)
  const ref = { sha256: sha(bytes), size: bytes.length, uploadId: begun.uploadId! }
  await s.chunk(ref.sha256, ref.size, 0, bytes, { route, uploadId: ref.uploadId })
  const read = vi.spyOn(prototype, 'read').mockImplementation(async () => {
    throw new Error('Publication reservation must not read body bytes on main')
  })
  const context = {
    owner: { storeId: 'store', instanceId: 'instance', connectionEpoch: 0 },
    route,
    taskId: 'alice',
    tabId: 'tab',
    lifecycleRevision: 1,
    operationId: 'operation',
    intentHash: 'a'.repeat(64)
  }
  const one = await s.reserveForPublication(ref, context)
  const two = await s.reserveForPublication(ref, context)
  expect(one.grant.entryId).toBe(two.grant.entryId)
  expect(one.grant.leaseId).not.toBe(two.grant.leaseId)
  expect(one.grant).toMatchObject({
    kind: 'staged-path',
    ref,
    identity: { size: bytes.length },
    binding: { kind: 'owned', taskId: 'alice', route, operationId: 'operation', revision: 1 }
  })
  expect(read).not.toHaveBeenCalled()
  let erased = false
  const erasing = s.withTaskErasure('alice', async () => {
    erased = true
  })
  await turn()
  expect(one.signal.aborted).toBe(true)
  expect(erased).toBe(false)
  await one.release(false)
  expect(erased).toBe(false)
  await two.release(false)
  await erasing
  expect(erased).toBe(true)
})

test('old publication cleanup refuses a same-path replacement instead of deleting its incarnation', async () => {
  const { s } = await setup()
  const begun = await begin(s)
  const ref = { sha256: sha(bytes), size: bytes.length, uploadId: begun.uploadId! }
  await s.chunk(ref.sha256, ref.size, 0, bytes, { route, uploadId: ref.uploadId })
  const context = {
    owner: { storeId: 'store', instanceId: 'instance', connectionEpoch: 0 },
    route,
    taskId: 'alice',
    tabId: 'tab',
    lifecycleRevision: 1,
    operationId: 'operation',
    intentHash: 'a'.repeat(64)
  }
  const lease = await s.reserveForPublication(ref, context)
  const { rename, writeFile } = await import('node:fs/promises')
  await rename(lease.grant.path, lease.grant.path + '.old')
  await writeFile(lease.grant.path, 'new incarnation')
  await expect(lease.release(true)).rejects.toThrow(/replac|incarnation/i)
  expect(await readFile(lease.grant.path, 'utf8')).toBe('new incarnation')
})
function gateSync(prototype: { sync(): Promise<void> }) {
  const original = prototype.sync
  let entered = false,
    unblock!: () => void
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve
  })
  unlocks.push(unblock)
  vi.spyOn(prototype, 'sync').mockImplementationOnce(async function (this: FileHandle) {
    entered = true
    await blocked
    await original.call(this)
  })
  return { unblock, entered: () => entered }
}
async function until(check: () => boolean) {
  const end = Date.now() + 500
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 2))
  expect(check()).toBe(true)
}
function begin(s: ReturnType<typeof createUploadStaging>, operationId = 'operation', b = bytes) {
  return s.begin(sha(b), b.length, { route, operationId })
}

test('native sync holds the durable ack; heartbeat and unrelated owner work keep running', async () => {
  const { s, prototype } = await setup()
  const gate = gateSync(prototype)
  let ack = false
  const pending = Promise.resolve(begin(s)).then((v) => {
    ack = true
    return v
  })
  await until(gate.entered)
  let heartbeat = false
  await turn().then(() => {
    heartbeat = true
  })
  expect(heartbeat).toBe(true)
  expect(ack).toBe(false)
  expect(
    await s.begin(sha(bytes), bytes.length, {
      route: { id: 'bob', epoch: 1 },
      operationId: 'other'
    })
  ).toMatchObject({ received: 0 })
  gate.unblock()
  expect(await pending).toMatchObject({ received: 0 })
})

test('native sync failure rejects chunk ack; begin cannot acknowledge unsynced retry bytes', async () => {
  const { s, prototype } = await setup()
  const ref = await begin(s)
  const scope = { route, uploadId: ref.uploadId! }
  vi.spyOn(prototype, 'sync').mockRejectedValueOnce(new Error('disk sync failed'))
  await expect(
    Promise.resolve().then(async () => s.chunk(sha(bytes), bytes.length, 0, bytes, scope))
  ).rejects.toThrow('disk sync failed')
  vi.restoreAllMocks()
  const gate = gateSync(prototype)
  let ack = false
  const retry = Promise.resolve(begin(s)).then((v) => {
    ack = true
    return v
  })
  await until(gate.entered)
  expect(ack).toBe(false)
  gate.unblock()
  expect(await retry).toMatchObject({ received: bytes.length })
})

test.each(['begin', 'chunk', 'hash'] as const)(
  'erase drains delayed %s, fences its ack and leaves no bytes',
  async (kind) => {
    const { s, dir, prototype } = await setup()
    const ref = kind === 'begin' ? undefined : await begin(s)
    if (kind === 'hash')
      await s.chunk(sha(bytes), bytes.length, 0, bytes, { route, uploadId: ref!.uploadId! })
    let entered = false,
      unblock!: () => void
    const block = new Promise<void>((r) => {
      unblock = r
    })
    unlocks.push(unblock)
    const method = kind === 'hash' ? 'read' : 'sync'
    const original = prototype[method]
    vi.spyOn(prototype, method).mockImplementationOnce(async function (
      this: FileHandle,
      ...args: unknown[]
    ) {
      entered = true
      await block
      return original.apply(this, args)
    })
    const work = Promise.resolve().then(async () =>
      kind === 'begin'
        ? begin(s)
        : kind === 'chunk'
          ? s.chunk(sha(bytes), bytes.length, 0, bytes, { route, uploadId: ref!.uploadId! })
          : s.acquire({ sha256: sha(bytes), size: bytes.length, uploadId: ref!.uploadId }, route)
    )
    // Attach a rejection observer before fencing; no unhandled rejection may escape.
    const result = work.then(
      async (v) => {
        if ('release' in v) await v.release(false)
        return 'ack'
      },
      () => 'fenced'
    )
    await until(() => entered)
    let erased = false
    const erasure = s
      .withTaskErasure('alice', async () => {
        await assertUploadsErased(dir, 'alice')
      })
      .then(() => {
        erased = true
      })
    await turn()
    expect(erased).toBe(false)
    unblock()
    expect(await result).toBe('fenced')
    await erasure
    await expect(
      stat(join(dir, 'uploads', 'owned', sha(Buffer.from(JSON.stringify('alice')))))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  }
)

test('same operation serializes concurrent begins and idempotent chunks', async () => {
  const { s } = await setup()
  const refs = await Promise.all([begin(s), begin(s)])
  expect(refs[0]).toEqual(refs[1])
  const scope = { route, uploadId: refs[0].uploadId! }
  expect(
    await Promise.all([
      s.chunk(sha(bytes), bytes.length, 0, bytes, scope),
      s.chunk(sha(bytes), bytes.length, 0, bytes, scope)
    ])
  ).toEqual([{ received: bytes.length }, { received: bytes.length }])
  const lease = await s.acquire(
    { sha256: sha(bytes), size: bytes.length, uploadId: scope.uploadId },
    route
  )
  expect(await readFile(lease.path)).toEqual(bytes)
  await lease.release()
})

test('large verification yields bounded async reads so control turns run before completion', async () => {
  const { s, prototype } = await setup()
  const big = Buffer.alloc(16 * 1024 * 1024, 7)
  const ref = await begin(s, 'big', big)
  for (let offset = 0; offset < big.length; offset += BYTE_RANGE_MAX_CHUNK)
    await s.chunk(
      sha(big),
      big.length,
      offset,
      big.subarray(offset, offset + BYTE_RANGE_MAX_CHUNK),
      { route, uploadId: ref.uploadId! }
    )
  const original = prototype.read
  let reads = 0,
    heartbeat = false
  vi.spyOn(prototype, 'read').mockImplementation(async function (
    this: FileHandle,
    ...args: unknown[]
  ) {
    reads++
    expect(args[2]).toBeLessThanOrEqual(BYTE_RANGE_MAX_CHUNK)
    if (reads === 1)
      setImmediate(() => {
        heartbeat = true
      })
    return original.apply(this, args)
  })
  const lease = await s.acquire(
    { sha256: sha(big), size: big.length, uploadId: ref.uploadId },
    route
  )
  try {
    expect(reads).toBeGreaterThan(1)
    expect(heartbeat).toBe(true)
  } finally {
    await lease.release(false)
  }
})

test('expiry skips active I/O; close waits native work, rejects late ack, keeps resumable bytes', async () => {
  let now = 1000
  const { s, prototype, dir } = await setup({ now: () => now, staleMs: 100 })
  const ref = await begin(s)
  const gate = gateSync(prototype)
  const chunk = Promise.resolve().then(async () =>
    s.chunk(sha(bytes), bytes.length, 0, bytes, { route, uploadId: ref.uploadId! })
  )
  const result = chunk.then(
    () => 'ack',
    () => 'closed'
  )
  await until(gate.entered)
  now += 200
  await s.sweep()
  let closed = false
  const close = s.close().then(() => {
    closed = true
  })
  await turn()
  expect(closed).toBe(false)
  gate.unblock()
  expect(await result).toBe('closed')
  await close
  // Close fenced the ack, but waited for the actual sync and retained the partial operation.
  const restarted = createUploadStaging(dir, {
    now: () => 1000,
    validateOwner: (r) => ({ taskId: r.id, revision: 1 })
  })
  stores.push(restarted)
  expect(await begin(restarted)).toMatchObject({ received: bytes.length })
})

test.each(['begin', 'chunk'] as const)(
  'lifecycle revision changes fence delayed %s',
  async (kind) => {
    let revision = 1
    const { s, prototype } = await setup({ validateOwner: (r) => ({ taskId: r.id, revision }) })
    const ref = kind === 'chunk' ? await begin(s) : undefined
    const gate = gateSync(prototype)
    const pending = Promise.resolve().then(async () =>
      kind === 'begin'
        ? begin(s)
        : s.chunk(sha(bytes), bytes.length, 0, bytes, { route, uploadId: ref!.uploadId! })
    )
    const result = pending.then(
      () => 'ack',
      () => 'fenced'
    )
    await until(gate.entered)
    revision = 2
    gate.unblock()
    expect(await result).toBe('fenced')
    expect(await begin(s)).toMatchObject({ received: 0 })
  }
)

test('verified erasure holds legacy admission through receipt; other owned tasks progress', async () => {
  const { s, dir } = await setup()
  let finish!: () => void,
    entered = false
  const wait = new Promise<void>((r) => {
    finish = r
  })
  unlocks.push(finish)
  const erasure = s.withTaskErasure('alice', async () => {
    entered = true
    await wait
    await assertUploadsErased(dir, 'alice')
    return { erased: true }
  })
  await until(() => entered)
  await expect(s.begin(sha(bytes), bytes.length)).rejects.toThrow(/erasure/)
  expect(
    await s.begin(sha(bytes), bytes.length, {
      route: { id: 'bob', epoch: 1 },
      operationId: 'other'
    })
  ).toMatchObject({ received: 0 })
  finish()
  expect(await erasure).toEqual({ erased: true })
})

test('an unrelated task erasure does not wait for another task expiry sync', async () => {
  let now = 1000
  const { s, dir, prototype } = await setup({ now: () => now, staleMs: 100 })
  await s.begin(sha(bytes), bytes.length, {
    route: { id: 'bob', epoch: 1 },
    operationId: 'expired'
  })
  now += 200
  const gate = gateSync(prototype)
  const sweeping = s.sweep()
  await until(gate.entered)
  let receipt = false
  const erasure = s.withTaskErasure('alice', async () => {
    await assertUploadsErased(dir, 'alice')
    receipt = true
  })
  try {
    await until(() => receipt)
  } finally {
    gate.unblock()
    await sweeping
    await erasure
  }
})

test('erasure drains its own expiry handles before receipt', async () => {
  let now = 1000
  const { s, dir, prototype } = await setup({ now: () => now, staleMs: 100 })
  await begin(s)
  now += 200
  const gate = gateSync(prototype)
  const sweeping = s.sweep()
  await until(gate.entered)
  let receipt = false
  const erasure = s.withTaskErasure('alice', async () => {
    await assertUploadsErased(dir, 'alice')
    receipt = true
  })
  try {
    await new Promise((r) => setTimeout(r, 25))
    expect(receipt).toBe(false)
  } finally {
    gate.unblock()
    await sweeping
    await erasure
  }
})

test('verified erasure drains unattributed expiry durability before checking leftovers', async () => {
  let now = 1000
  const { s, dir, prototype } = await setup({ now: () => now, staleMs: 100 })
  await s.begin(sha(bytes), bytes.length)
  now += 200
  const gate = gateSync(prototype)
  const sweeping = s.sweep()
  await until(gate.entered)
  let receipt = false
  const erasure = s.withTaskErasure('alice', async () => {
    await assertUploadsErased(dir, 'alice')
    receipt = true
  })
  try {
    await new Promise((r) => setTimeout(r, 25))
    expect(receipt).toBe(false)
  } finally {
    gate.unblock()
    await sweeping
    await erasure
  }
})

test('task admission fences immediately while erasure drains an unattributed begin', async () => {
  const { s, dir, prototype } = await setup()
  const gate = gateSync(prototype)
  const legacy = s.begin(sha(bytes), bytes.length).then(
    () => 'ack',
    () => 'fenced'
  )
  await until(gate.entered)
  const erasure = s
    .withTaskErasure('alice', () => assertUploadsErased(dir, 'alice'))
    .then(
      () => 'receipt',
      () => 'leftovers'
    )
  try {
    await expect(begin(s, 'late')).rejects.toThrow(/deleted|erasure/)
  } finally {
    gate.unblock()
    expect(await legacy).toBe('fenced')
    expect(await erasure).toBe('leftovers')
  }
})

test('initialization durably links the upload directory before acknowledging offsets', async () => {
  const { prototype } = await setup()
  const dir = await mkdtemp(join(tmpdir(), 'upload-root-durability-'))
  dirs.push(dir)
  const original = prototype.sync
  let firstSyncIsDirectory = false
  vi.spyOn(prototype, 'sync').mockImplementationOnce(async function (this: FileHandle) {
    firstSyncIsDirectory = (await this.stat()).isDirectory()
    return original.call(this)
  })
  const s = createUploadStaging(dir, { validateOwner: (r) => ({ taskId: r.id, revision: 1 }) })
  stores.push(s)
  await begin(s)
  if (process.platform !== 'win32') expect(firstSyncIsDirectory).toBe(true)
})

// A stale compatibility release has no authority over another manager's entry.
test('closed manager late hash release cannot delete a fresh same-key incarnation', async () => {
  const { dir, s } = await setup()
  await s.begin(sha(bytes), bytes.length)
  await s.chunk(sha(bytes), bytes.length, 0, bytes)
  await s.release(sha(bytes), bytes.length)
  await s.close()
  const fresh = createUploadStaging(dir, { validateOwner: (r) => ({ taskId: r.id, revision: 1 }) })
  stores.push(fresh)
  await fresh.begin(sha(bytes), bytes.length)
  await fresh.chunk(sha(bytes), bytes.length, 0, bytes)
  await expect(s.release(sha(bytes), bytes.length)).rejects.toThrow(/closed/i)
  const lease = await fresh.acquire({ sha256: sha(bytes), size: bytes.length }, route)
  expect(await readFile(lease.path)).toEqual(bytes)
  await lease.release(false)
})
