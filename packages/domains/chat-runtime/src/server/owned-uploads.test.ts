import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { BYTE_RANGE_MAX_CHUNK } from '@slayzone/platform/bounded-reads'
import { createComputerChatRuntime } from './computer-runtime'
import { createUploadStaging } from './upload-staging'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness'
import { eraseContent } from '@slayzone/content-erasure/server'

type Route = { id: string; epoch: number }
const alice = { id: 'alice', epoch: 1 },
  bob = { id: 'bob', epoch: 1 }
const dirs: string[] = []
const runtimes: Array<ReturnType<typeof createComputerChatRuntime>> = []
const stores: Array<ReturnType<typeof createUploadStaging>> = []
const harnesses: Array<Awaited<ReturnType<typeof createTestHarness>>> = []
const readers: Array<{ release(consumed?: boolean): Promise<void> }> = []
const pendingErasures: Promise<unknown>[] = []
afterEach(async () => {
  for (const lease of readers.splice(0)) await lease.release(false)
  await Promise.allSettled(pendingErasures.splice(0))
  for (const r of runtimes.splice(0)) await r.close()
  for (const s of stores.splice(0)) await s.close?.()
  for (const h of harnesses.splice(0)) h.cleanup()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  vi.useRealTimers()
})
async function acquire(
  store: ReturnType<typeof createUploadStaging>,
  ref: { sha256: string; size: number; uploadId?: string },
  route: Route,
  operationId?: string
) {
  const lease = await store.acquire(ref, route, operationId)
  readers.push(lease)
  return lease
}
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function files(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]
  )
}
function contains(dir: string, bytes: Buffer) {
  return files(dir).some((file) => readFileSync(file).includes(bytes))
}
function bootstrap(r: ReturnType<typeof createComputerChatRuntime>, id: string) {
  r.bootstrap({
    identity: { id, taskId: id, tabId: `${id}-tab`, mode: 'claude-chat', epoch: 1 },
    projectId: null,
    cwd: r.storage.dir,
    revision: 1,
    providerConfig: {},
    defaultFlags: null,
    env: {}
  })
}
function runtime(stateDir?: string) {
  if (!stateDir) {
    stateDir = mkdtempSync(join(tmpdir(), 'owned-uploads-'))
    dirs.push(stateDir)
  }
  const r = createComputerChatRuntime({
    stateDir,
    hubScope: 'hub',
    computerId: 'pc',
    maintenance: true
  })
  runtimes.push(r)
  return r
}
async function stage(
  r: ReturnType<typeof createComputerChatRuntime>,
  route: Route,
  operationId: string,
  bytes: Buffer,
  complete = true
) {
  const sha256 = sha(bytes),
    size = bytes.length
  const begun = await r.uploads.begin(sha256, size, { route, operationId })
  const scope = { route, uploadId: begun.uploadId! }
  for (let offset = begun.received; offset < size; offset += BYTE_RANGE_MAX_CHUNK) {
    await r.uploads.chunk(
      sha256,
      size,
      offset,
      bytes.subarray(offset, offset + BYTE_RANGE_MAX_CHUNK),
      scope
    )
    if (!complete) break
  }
  return { sha256, size, uploadId: begun.uploadId }
}

test('verified task erasure removes interrupted owned uploads after restart, keeps another task', async () => {
  const state = mkdtempSync(join(tmpdir(), 'owned-upload-restart-'))
  dirs.push(state)
  let r = runtime(state)
  bootstrap(r, 'alice')
  bootstrap(r, 'bob')
  const secret = Buffer.from('alice private abandoned upload'),
    other = Buffer.from('bob retained upload')
  const a = await stage(r, alice, 'abandoned', secret),
    b = await stage(r, bob, 'other', other)
  await r.close()
  r = runtime(state)
  expect(contains(join(r.storage.dir, 'uploads'), secret)).toBe(true)
  expect(await r.eraseTask('alice', 2)).toMatchObject({ erased: true })
  expect(contains(join(r.storage.dir, 'uploads'), secret)).toBe(false)
  const lease = await acquire(r.uploads, b, bob)
  expect(readFileSync(lease.path).equals(other)).toBe(true)
  await lease.release()
  await expect(
    r.uploads.chunk(a.sha256, a.size, 0, secret, { route: alice, uploadId: a.uploadId! })
  ).rejects.toThrow()
  await expect(
    r.uploads.begin(a.sha256, a.size, { route: alice, operationId: 'late' })
  ).rejects.toThrow()
  expect(contains(join(r.storage.dir, 'uploads'), secret)).toBe(false)
})

test.each(['paused', 'deleted', 'conversation', 'epoch'] as const)(
  'upload reads/chunks/begins obey %s fences',
  async (state) => {
    const r = runtime()
    bootstrap(r, 'alice')
    const bytes = Buffer.from('fenced bytes'),
      ref = await stage(r, alice, 'fenced', bytes)
    if (state === 'conversation')
      await r.deleteConversation(r.storage.conversation('alice')!.identity)
    else if (state === 'epoch')
      r.storage.compose((db) =>
        db.prepare("UPDATE conversations SET epoch=2 WHERE id='alice'").run()
      )
    else await r.applyTaskLifecycle('alice', state, 2)
    await expect(
      r.uploads.chunk(ref.sha256, ref.size, 0, bytes, { route: alice, uploadId: ref.uploadId! })
    ).rejects.toThrow()
    await expect(r.uploads.acquire(ref, alice)).rejects.toThrow()
    await expect(
      r.uploads.begin(ref.sha256, ref.size, { route: alice, operationId: 'late' })
    ).rejects.toThrow()
  }
)

test('a fresh begin after pause/reactivation gets a new token while old chunks stay fenced', async () => {
  const r = runtime()
  bootstrap(r, 'alice')
  const bytes = Buffer.from('resumed after pause'),
    old = await stage(r, alice, 'resume-operation', bytes)
  await r.applyTaskLifecycle('alice', 'paused', 2)
  await r.applyTaskLifecycle('alice', 'active', 3)
  await expect(
    r.uploads.chunk(old.sha256, old.size, 0, bytes, { route: alice, uploadId: old.uploadId! })
  ).rejects.toThrow()
  const fresh = await stage(r, alice, 'resume-operation', bytes)
  expect(fresh.uploadId).not.toBe(old.uploadId)
  const lease = await acquire(r.uploads, fresh, alice)
  expect(readFileSync(lease.path).equals(bytes)).toBe(true)
  await lease.release()
})

test('prepared migration uploads preserve paused-task inline attachment behavior', async () => {
  const r = runtime()
  bootstrap(r, 'alice')
  const bytes = Buffer.from('prepared migration text')
  const ref = r.attachments.put(
    'alice-tab',
    {
      artifactId: 'prepared',
      name: 'file.txt',
      kind: 'text',
      mediaType: 'text/plain',
      size: bytes.length
    },
    bytes
  )
  r.storage.compose((db) =>
    db.prepare("UPDATE conversations SET state='prepared' WHERE id='alice'").run()
  )
  await r.applyTaskLifecycle('alice', 'paused', 2)
  expect(() => r.attachments.putPrepared('alice', 1, ref, bytes)).not.toThrow()
  const staged = await stage(r, alice, 'migration', bytes)
  const lease = await acquire(r.uploads, staged, alice)
  expect(() => r.attachments.putPrepared('alice', 1, ref, readFileSync(lease.path))).not.toThrow()
  await lease.release()
})

test('operation-owned uploads isolate identical bytes and reject foreign consumption or operation reuse', async () => {
  const r = runtime()
  bootstrap(r, 'alice')
  bootstrap(r, 'bob')
  const bytes = Buffer.from('identical content')
  const a = await stage(r, alice, 'first', bytes),
    b = await stage(r, alice, 'second', bytes)
  expect(a.uploadId).toBeTruthy()
  expect(b.uploadId).not.toBe(a.uploadId)
  await expect(r.uploads.acquire(a, bob)).rejects.toThrow()
  await expect(r.uploads.acquire(a, alice, 'wrong-operation')).rejects.toThrow()
  await expect(
    r.uploads.begin(sha(Buffer.from('different')), 9, { route: alice, operationId: 'first' })
  ).rejects.toThrow()
  for (const [ref, op] of [
    [a, 'first'],
    [b, 'second']
  ] as const) {
    const lease = await acquire(r.uploads, ref, alice, op)
    expect(readFileSync(lease.path).equals(bytes)).toBe(true)
    await lease.release()
  }
})

test('consume leases survive another release; stale release cannot remove a replacement', async () => {
  const r = runtime()
  bootstrap(r, 'alice')
  const bytes = Buffer.from('lease data'),
    ref = await stage(r, alice, 'leases', bytes)
  const one = await acquire(r.uploads, ref, alice),
    two = await acquire(r.uploads, ref, alice)
  await one.release()
  expect(existsSync(two.path)).toBe(true)
  expect(readFileSync(two.path).equals(bytes)).toBe(true)
  await two.release()
  expect(existsSync(two.path)).toBe(false)
  const replacement = await stage(r, alice, 'leases', bytes)
  const next = await acquire(r.uploads, replacement, alice)
  await one.release()
  expect(existsSync(next.path)).toBe(true)
  await next.release()
})

test('verified erasure waits for consumers and fences their late writes', async () => {
  const r = runtime()
  bootstrap(r, 'alice')
  const ref = await stage(r, alice, 'in-use', Buffer.from('in-use secret'))
  const lease = await acquire(r.uploads, ref, alice)
  let done = false
  const erasing = r.eraseTask('alice', 2).then((value) => {
    done = true
    return value
  })
  pendingErasures.push(erasing)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(done).toBe(false)
  expect(() => lease.assertCurrent()).toThrow()
  expect(existsSync(lease.path)).toBe(true)
  await lease.release(false)
  expect(await erasing).toMatchObject({ erased: true })
  expect(existsSync(lease.path)).toBe(false)
})

test('erasure drains an actual asynchronous staged artifact writer before confirming deletion', async () => {
  const r = runtime()
  bootstrap(r, 'alice')
  const artifact = (await r.artifacts.invoke({
    route: alice,
    method: 'uploadArtifactBlob',
    operationId: 'original',
    args: [{ taskId: 'alice', title: 'file.txt', data: Buffer.from('original').toString('base64') }]
  })) as { id: string }
  const secret = Buffer.from('late staged private artifact write')
  const staged = await stage(r, alice, 'write', secret)
  const original = r.artifacts.store.writeArtifactContent.bind(r.artifacts.store)
  let entered!: () => void, resume!: () => void
  const waiting = new Promise<void>((resolve) => {
    entered = resolve
  })
  const proceed = new Promise<void>((resolve) => {
    resume = resolve
  })
  const mock = vi
    .spyOn(r.artifacts.store, 'writeArtifactContent')
    .mockImplementation(async (...args) => {
      entered()
      await proceed
      return original(...args)
    })
  const writing = r.artifacts
    .invoke({
      route: alice,
      method: 'writeArtifactContent',
      operationId: 'write',
      args: [{ artifactId: artifact.id, staged }]
    })
    .then(
      () => null,
      (error: Error) => error
    )
  try {
    await waiting
    let erased = false
    const deletion = r.eraseTask('alice', 2).then((reply) => {
      erased = true
      return reply
    })
    pendingErasures.push(deletion)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(erased).toBe(false)
    resume()
    expect(await writing).toBeInstanceOf(Error)
    expect(await deletion).toMatchObject({ erased: true })
    expect(contains(r.storage.dir, secret)).toBe(false)
  } finally {
    resume()
    await writing
    mock.mockRestore()
  }
})

test('live expiry removes idle uploads, pins active consumers, closes without losing resumability', async () => {
  let now = 1000
  const dir = mkdtempSync(join(tmpdir(), 'owned-upload-expiry-'))
  dirs.push(dir)
  const options = {
    now: () => now,
    automatic: true,
    staleMs: 100,
    sweepIntervalMs: 10,
    validateOwner: (_route: Route) => ({ taskId: 'alice', revision: 0 })
  }
  const s = createUploadStaging(dir, options)
  stores.push(s)
  const bytes = Buffer.from('expiry data'),
    hash = sha(bytes)
  const begun = await s.begin(hash, bytes.length, { route: alice, operationId: 'idle' })
  await s.chunk(hash, bytes.length, 0, bytes, { route: alice, uploadId: begun.uploadId! })
  now += 110
  await vi.waitFor(() => expect(files(join(dir, 'uploads'))).toEqual([]))
  const active = await s.begin(hash, bytes.length, { route: alice, operationId: 'active' })
  await s.chunk(hash, bytes.length, 0, bytes, { route: alice, uploadId: active.uploadId! })
  const lease = await acquire(
    s,
    { sha256: hash, size: bytes.length, uploadId: active.uploadId },
    alice
  )
  now += 110
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(existsSync(lease.path)).toBe(true)
  await lease.release(false)
  await vi.waitFor(() => expect(existsSync(lease.path)).toBe(false))
  const resume = await s.begin(hash, bytes.length, { route: alice, operationId: 'resume' })
  await s.chunk(hash, bytes.length, 0, bytes.subarray(0, 3), {
    route: alice,
    uploadId: resume.uploadId!
  })
  await s.close()
  const restarted = createUploadStaging(dir, options)
  stores.push(restarted)
  expect(
    (await restarted.begin(hash, bytes.length, { route: alice, operationId: 'resume' })).received
  ).toBe(3)
})

test('expiry filesystem failures are reported and retried without escaping the timer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'owned-upload-sweep-error-'))
  dirs.push(dir)
  const errors: unknown[] = []
  const s = createUploadStaging(dir, {
    automatic: true,
    sweepIntervalMs: 10,
    onSweepError: (error: unknown) => errors.push(error)
  })
  stores.push(s)
  await s.begin(sha(Buffer.alloc(0)), 0)
  rmSync(join(dir, 'uploads'), { recursive: true })
  await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0))
})

test('legacy unattributed staging prevents a false verified erasure receipt', async () => {
  const r = runtime()
  bootstrap(r, 'alice')
  const bytes = Buffer.from('legacy pending bytes'),
    hash = sha(bytes)
  await r.uploads.begin(hash, bytes.length)
  await r.uploads.chunk(hash, bytes.length, 0, bytes)
  await expect(r.eraseTask('alice', 2)).rejects.toThrow(/unattributed|staging/i)
  await r.uploads.release(hash, bytes.length)
  expect(await r.eraseTask('alice', 2)).toMatchObject({ erased: true })
})

test('unattributed files inside the owned namespace also prevent a false receipt', async () => {
  const r = runtime()
  bootstrap(r, 'alice')
  const owned = join(r.storage.dir, 'uploads', 'owned')
  mkdirSync(owned, { recursive: true })
  writeFileSync(join(owned, 'unattributed.part'), 'unattributed bytes')
  await expect(r.eraseTask('alice', 2)).rejects.toThrow(/unattributed|staging/i)
})

test('account erasure verifies owned computer staging across tasks, preserves another account', async () => {
  const h = await createTestHarness()
  harnesses.push(h)
  const r = runtime()
  h.db
    .prepare(
      "INSERT INTO computers(id,name,platform,version,capabilities_json,created_at,owner_user_id) VALUES('pc','PC','fixture','1','[]',1,'alice')"
    )
    .run()
  const secret = Buffer.from('alice account private staging'),
    other = Buffer.from('bob account kept staging')
  for (const id of ['alice', 'alice2', 'bob']) {
    const user = id === 'bob' ? 'bob' : 'alice'
    h.db
      .prepare('INSERT INTO projects(id,name,color,owner_user_id) VALUES(?,?,?,?)')
      .run(id, id, '#000', user)
    h.db.prepare('INSERT INTO tasks(id,project_id,title) VALUES(?,?,?)').run(id, id, id)
    h.db.prepare('INSERT INTO chat_task_computers VALUES(?,?)').run(id, 'pc')
    bootstrap(r, id)
    await stage(r, { id, epoch: 1 }, `private-${id}`, id === 'bob' ? other : secret)
  }
  const report = await eraseContent(
    h.slayDb,
    h.tmpDir(),
    { kind: 'user', userId: 'alice' },
    {
      cleanupComputer: async ({ taskIds }) =>
        Promise.all(
          taskIds.map(async (taskId) => {
            const fence = h.db
              .prepare('SELECT revision FROM chat_task_lifecycle WHERE task_id=?')
              .get(taskId) as { revision: number }
            return r.eraseTask(taskId, fence.revision)
          })
        )
    }
  )
  expect(report.state).toBe('complete')
  expect(contains(join(r.storage.dir, 'uploads'), secret)).toBe(false)
  expect(contains(join(r.storage.dir, 'uploads'), other)).toBe(true)
})
