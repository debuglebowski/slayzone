import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { killCheckpointerThreadForTests } from './checkpointer'
import { openChatStorageOwner, type AsyncChatStorage } from './storage-owner'
import { chatStorageDigest } from './storage-digest'

const roots: string[] = []
const owners: AsyncChatStorage[] = []
const workerPath = resolve('packages/apps/computer/dist/bin.cjs')
const identity = { id: 'c', taskId: 't', tabId: 'tab', mode: 'claude-chat', epoch: 1 }
const event = (text: string) => ({ kind: 'assistant-text', messageId: text, text }) as const
function root() {
  const value = mkdtempSync(join(tmpdir(), 'slz-storage-owner-'))
  roots.push(value)
  return value
}
async function open(stateDir = root(), hubScope = 'hub') {
  const owner = await openChatStorageOwner({
    stateDir,
    hubScope,
    workerPath,
    checkpointIntervalMs: 60_000,
    checkpointerRetryMs: 60_000
  })
  owners.push(owner)
  return owner
}
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.close()
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('the packaged worker opens/migrates the actual store and returns committed seqs, without starting a computer', async () => {
  const owner = await open()
  expect(
    await owner.db.get<{ thread: number }>('SELECT chat_storage_owner_thread() thread')
  ).toMatchObject({ thread: expect.any(Number) })
  expect(
    (await owner.db.get<{ thread: number }>('SELECT chat_storage_owner_thread() thread'))!.thread
  ).toBeGreaterThan(0)
  expect('compose' in owner).toBe(false)
  expect('transaction' in owner).toBe(false)
  await owner.createConversation(identity)
  const stored = await owner.append('c', 1, event('kept'))
  expect(stored).toMatchObject({ seq: 0, event: event('kept') })
  expect(await owner.read('c', -1)).toEqual([stored])
  await owner.putRecord('c', 1, { kind: 'settings', id: 'r', value: { ok: true }, at: 1 })
  expect(await owner.getRecord<{ ok: boolean }>('c', 'settings', 'r')).toEqual({ ok: true })
  await expect(owner.append('c', 2, event('wrong epoch'))).rejects.toThrow()
  expect(await owner.nextSeq('c')).toBe(1)
})

test('durable prefixes are real fences before and after shared checkpointer death; racing flushes do not acknowledge newer writes early', async () => {
  const owner = await open()
  await owner.createConversation(identity)
  await owner.append('c', 1, event('before failure'))
  await Promise.all(Array.from({ length: 10 }, () => owner.flush()))
  const first = await owner.maintenanceCursor<string>('storage-durable-prefix-v1')
  expect(first).toEqual(expect.any(String))
  await killCheckpointerThreadForTests()
  await owner.append('c', 1, event('after failure'))
  await owner.flush()
  expect(await owner.maintenanceCursor<string>('storage-durable-prefix-v1')).not.toBe(first)
  await vi.waitFor(async () =>
    expect(await owner.db.get('PRAGMA synchronous')).toEqual({ synchronous: 2 })
  )
  expect((await owner.read('c', -1)).map((entry) => entry.event)).toEqual([
    event('before failure'),
    event('after failure')
  ])
})

test('one owner per file; close waits for writer/checkpointer release before reopening', async () => {
  const dir = root()
  const owner = await open(dir)
  const id = await owner.storeId()
  await expect(open(dir)).rejects.toThrow(/already.*owner/i)
  const prefix = owner.flush()
  const closing = owner.close()
  await expect(owner.flush()).rejects.toThrow(/closed/i)
  await prefix
  await expect(open(dir)).rejects.toThrow(/already.*owner/i)
  await closing
  const next = await open(dir)
  expect(await next.storeId()).toBe(id)
})

test('failed startup releases control resources and the next valid owner can open', async () => {
  const dir = root()
  await expect(openChatStorageOwner({ stateDir: dir, hubScope: '', workerPath })).rejects.toThrow(
    /scope/i
  )
  const storeDir = join(dir, 'computer-runtime', chatStorageDigest('hub'))
  const file = join(storeDir, 'chat.sqlite')
  mkdirSync(storeDir, { recursive: true })
  writeFileSync(file, 'invalid sqlite database')
  await expect(open(dir)).rejects.toMatchObject({ code: 'SQLITE_NOTADB' })
  rmSync(file)
  const owner = await open(dir)
  await owner.createConversation(identity)
  await owner.flush()
})

test('secondary and blob leases are async handles; failure and termination stay isolated to one store', async () => {
  const dir = root()
  const a = await open(dir, 'a'),
    b = await open(dir, 'b')
  await a.createConversation(identity)
  const secondary = await a.maintenance.registerSecondary('export reader')
  expect(await a.maintenance.secondaryConnections()).toContain('export reader')
  await secondary.release()
  expect(await a.maintenance.secondaryConnections()).toEqual([])
  const lease = await a.acquireBlobLease('backup', 60000)
  expect(await a.hasBlobLeases()).toBe(true)
  await lease.release()
  expect(await a.hasBlobLeases()).toBe(false)
  await a.terminate()
  await expect(a.inventory()).rejects.toThrow(/exited|closed|unavailable/i)
  await b.createConversation(identity)
  await b.append('c', 1, event('other hub kept'))
  await b.flush()
  expect(await b.nextSeq('c')).toBe(1)
  const recovered = await open(dir, 'a')
  expect(await recovered.conversation('c')).not.toBeNull()
})

test('close drains a fence waiting on a paused checkpointer without reopening admission', async () => {
  const owner = await open()
  owners.splice(owners.indexOf(owner), 1)
  await owner.maintenance.pauseCheckpointer()
  const flushing = owner.flush()
  void flushing.catch(() => undefined)
  const closing = owner.close()
  void closing.catch(() => undefined)
  try {
    const completed = await Promise.race([
      closing.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500))
    ])
    expect(completed).toBe(true)
    await flushing
  } finally {
    await owner.terminate()
    await closing.catch(() => undefined)
    await flushing.catch(() => undefined)
  }
})

test.skipIf(process.platform === 'win32')(
  'native proof of actual owner/store/header/reuse/fences/death/close through the packaged worker',
  () => {
    const dir = root()
    const extension = join(dir, process.platform === 'darwin' ? 'syncprobe.dylib' : 'syncprobe.so')
    execFileSync(
      'cc',
      [
        '-std=c11',
        ...(process.platform === 'darwin' ? ['-dynamiclib'] : ['-shared', '-fPIC']),
        '-O2',
        '-pthread',
        '-I',
        fileURLToPath(
          new URL('../../../../../node_modules/better-sqlite3/deps/sqlite3', import.meta.url)
        ),
        fileURLToPath(new URL('./storage-fence.syncprobe.c', import.meta.url)),
        '-o',
        extension
      ],
      { stdio: 'pipe' }
    )
    const output = execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL('./storage-owner.native.fixture.cjs', import.meta.url)),
        dir,
        extension,
        workerPath
      ],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        encoding: 'utf8',
        timeout: 30000
      }
    )
    const result = JSON.parse(output)
    expect(result).toMatchObject({
      actualStore: true,
      packagedWorker: true,
      cycles: 30,
      mainSyncs: 0,
      normalTailSyncs: 0,
      coalescedSyncs: 1,
      racingPrefixes: true,
      pendingDuringSync: true,
      failedCode: 'SQLITE_IOERR_FSYNC',
      integrity: 'ok'
    })
    expect(result.deathFenceSyncs).toBeGreaterThan(0)
  }
)

test('closing retains file ownership until a registered secondary actually releases its lifetime', async () => {
  const dir = root()
  const owner = await open(dir)
  const lease = await owner.maintenance.registerSecondary('held export')
  let closed = false
  const closing = owner.close().then(() => {
    closed = true
  })
  try {
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(closed).toBe(false)
    // Release remains available after admission closes, then replacement is safe.
    await lease.release()
    await closing
    const next = await open(dir)
    expect(await next.maintenance.secondaryConnections()).toEqual([])
  } finally {
    await lease.release().catch(() => undefined)
    await closing
  }
})

test('pausing a failed checker cancels pending recovery until explicitly resumed', async () => {
  const owner = await openChatStorageOwner({
    stateDir: root(),
    hubScope: 'pause-recovery',
    workerPath,
    checkpointIntervalMs: 60000,
    checkpointerRetryMs: 200
  })
  owners.push(owner)
  await vi.waitFor(async () =>
    expect(await owner.db.get('PRAGMA synchronous')).toEqual({ synchronous: 1 })
  )
  await killCheckpointerThreadForTests()
  await vi.waitFor(async () =>
    expect(await owner.db.get('PRAGMA synchronous')).toEqual({ synchronous: 2 })
  )
  await owner.maintenance.pauseCheckpointer()
  let acknowledged = false
  const flushing = owner.flush().then(() => {
    acknowledged = true
  })
  try {
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(acknowledged).toBe(false)
    expect(await owner.db.get('PRAGMA synchronous')).toEqual({ synchronous: 2 })
  } finally {
    await owner.maintenance.resumeCheckpointer()
    await flushing
  }
  await vi.waitFor(async () =>
    expect(await owner.db.get('PRAGMA synchronous')).toEqual({ synchronous: 1 })
  )
})
