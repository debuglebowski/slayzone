import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { killCheckpointerThreadForTests } from './checkpointer'
import {
  openChatStorageOwner,
  openChatMaintenanceOwner,
  type AsyncChatStorage
} from './storage-owner'
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

test('online authority snapshots stay on the canonical worker, refresh stored exclusions, and preserve live leases', async () => {
  const owner = await open()
  await owner.db.run(
    'INSERT INTO task_paths(task_id,project_id,worktree_path,base_dir,updated_at) VALUES(?,?,?,?,?)',
    ['a', 'p', '/p/a', '/base/a', 1]
  )
  await owner.db.run(
    'INSERT INTO task_paths(task_id,project_id,worktree_path,base_dir,updated_at) VALUES(?,?,?,?,?)',
    ['b', 'q', '/p/b', '/base/b', 1]
  )
  const lease = await owner.acquireBlobLease('online writer', 60_000)
  try {
    const task = { kind: 'task', taskId: 'a', projectId: 'p' } as const
    expect(await owner.readScope(task)).toMatchObject({
      scope: task,
      row: { taskId: 'a', worktreePath: '/p/a' },
      others: { worktrees: ['/p/b'], baseDirs: ['/base/b'] }
    })
    expect(await owner.readScope({ kind: 'project', projectId: 'p' })).toMatchObject({
      own: ['/p/a', '/base/a'],
      others: ['/p/b', '/base/b']
    })
    await owner.db.run('UPDATE task_paths SET worktree_path=? WHERE task_id=?', ['/new/b', 'b'])
    expect(await owner.readScope(task)).toMatchObject({ others: { worktrees: ['/new/b'] } })
    expect(await owner.hasBlobLeases()).toBe(true)
    await owner.db.exec('DROP TABLE task_paths')
    await expect(owner.readScope(task)).rejects.toThrow(/task_paths/)
    expect(await owner.hasBlobLeases()).toBe(true)
  } finally {
    await lease.release()
  }
})

test('production maintenance composition drains an admitted erasure and its FULL fence before concurrent close', async () => {
  const dir = root()
  const initial = await open(dir)
  await initial.createConversation(identity)
  await initial.append('c', 1, event('erase through the composed owner'))
  await initial.close()
  const maintenance = await openChatMaintenanceOwner({
    stateDir: dir,
    hubScope: 'hub',
    workerPath,
    computerId: 'pc'
  })
  try {
    await expect(open(dir)).rejects.toThrow(/already.*owner/i)
    const erased = maintenance.eraseTask('t', 2)
    const closing = maintenance.close()
    expect(await erased).toEqual({ taskId: 't', revision: 2, erased: true })
    await Promise.all([closing, maintenance.exited])
    const next = await open(dir)
    expect(await next.read('c', -1)).toEqual([])
    expect(await next.taskLifecycle('t')).toMatchObject({ state: 'deleted', revision: 2 })
    expect(await next.maintenanceCursor<string>('storage-durable-prefix-v1')).toEqual(
      expect.any(String)
    )
  } finally {
    await maintenance.close()
  }
})

test('failed worker-local composition releases writer/checkpointer ownership before retry', async () => {
  const dir = root()
  const initial = await open(dir)
  await initial.db.exec(
    'CREATE TABLE artifact_storage_schema(version INTEGER NOT NULL); INSERT INTO artifact_storage_schema VALUES(99)'
  )
  await initial.close()
  const options = { stateDir: dir, hubScope: 'hub', workerPath, computerId: 'pc' }
  await expect(openChatMaintenanceOwner(options)).rejects.toThrow(
    /Unsupported computer artifact schema/
  )
  const repair = await open(dir)
  await repair.db.run('UPDATE artifact_storage_schema SET version=1')
  await repair.close()
  const maintenance = await openChatMaintenanceOwner(options)
  await Promise.all([maintenance.close(), maintenance.exited])
  const next = await open(dir)
  expect(await next.db.get('SELECT version FROM artifact_storage_schema')).toEqual({ version: 1 })
})

test('owned export snapshots retain worker-local readers and close without a lease cycle', async () => {
  const owner = await open()
  await owner.createConversation(identity)
  await owner.append('c', 1, event('snapshot'))
  await expect(owner.openExportReader('c', 1, 'move')).rejects.toThrow(/freeze/i)
  expect(await owner.maintenance.secondaryConnections()).toEqual([])
  expect(await owner.hasBlobLeases()).toBe(false)
  await owner.freeze('c', 1, 'move')
  const reader = await owner.openExportReader('c', 1, 'move')
  expect(reader.eventCount).toBe(1)
  expect(await owner.hasExportReaders()).toBe(true)
  expect(await owner.maintenance.secondaryConnections()).toHaveLength(1)
  await owner.unfreeze('c', 1, 'move')
  await owner.append('c', 1, event('after snapshot'))
  expect((await reader.eventPage(-1)).events.map((row) => row.event)).toEqual([event('snapshot')])
  await reader.close()
  await reader.close()
  expect(await owner.maintenance.secondaryConnections()).toEqual([])
  await owner.freeze('c', 1, 'second')
  const abandoned = await owner.openExportReader('c', 1, 'second')
  const closing = owner.close()
  await Promise.all([closing, abandoned.close(), owner.exited])
  await expect(abandoned.eventPage(-1)).rejects.toThrow(/closed/i)
})

test('owner fences await paced timeline mutations and retain metadata and ownership checks', async () => {
  const owner = await open()
  await owner.createConversation(identity)
  const pages = Array.from({ length: 8 }, (_, page) => ({
    page,
    value: JSON.stringify({ rows: 'x'.repeat(1_000_000) }),
    summary: JSON.stringify({ page }),
    searchText: `needle ${page}`
  }))
  let settled = false
  const writing = owner
    .writeTimeline('c', 1, {
      dropPagesFrom: 0,
      pages,
      checkpoint: '{"seq":0}'
    })
    .then(() => {
      settled = true
    })
  await owner.flush()
  expect(settled).toBe(true)
  await writing
  expect(await owner.timelinePageIds('c')).toEqual(pages.map((p) => p.page))
  expect(await owner.searchTimelinePages('c', 1, 'needle')).toEqual(pages.map((p) => p.page))
  await expect(
    owner.writeTimeline('c', 2, { dropPagesFrom: 0, pages: [], checkpoint: null })
  ).rejects.toThrow(/epoch/i)
})

test('export fault identity survives the private worker boundary', async () => {
  const owner = await open()
  await owner.createConversation(identity)
  const sha256 = 'a'.repeat(64)
  await owner.recordExportBlobFault(
    'c',
    Object.assign(new Error('missing image'), {
      name: 'EventBlobUnavailableError',
      sha256
    })
  )
  expect(await owner.listFaults()).toContainEqual(
    expect.objectContaining({
      item_key: `c:${sha256}`,
      fingerprint: sha256,
      kind: 'structural'
    })
  )
})

test('snapshot blob failure stays caller-recorded exactly once across the worker boundary', async () => {
  const owner = await open()
  await owner.createConversation(identity)
  const stored = await owner.extractEventBlobs({
    kind: 'tool-result',
    toolUseId: 'image',
    isError: false,
    structured: null,
    rawContent: [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: Buffer.alloc(4096, 7).toString('base64')
        }
      }
    ]
  })
  await owner.appendAt('c', 1, 0, stored, Date.now())
  const [sha256] = await owner.eventBlobHashes()
  rmSync(join(owner.dir, 'blobs', sha256))
  await owner.freeze('c', 1, 'move')
  const reader = await owner.openExportReader('c', 1, 'move')
  const error = await reader.resolve(stored).catch((error: unknown) => error)
  expect(error).toMatchObject({ name: 'EventBlobUnavailableError', sha256 })
  expect(await owner.listFaults()).toEqual([])
  await owner.recordExportBlobFault('c', error)
  expect(await owner.listFaults()).toHaveLength(1)
  await reader.close()
})

test('legacy row headers and marker backfill execute on the same owner as timeline metadata', async () => {
  const owner = await open()
  await owner.createConversation(identity)
  await owner.append('c', 1, { kind: 'user-message', id: 'prompt', text: 'kept prompt' })
  await owner.db.exec(
    'UPDATE events SET blob_form=0; DELETE FROM event_markers; DELETE FROM event_marker_coverage'
  )
  expect(await owner.legacyEventSizes('c', -1, 10)).toEqual([{ seq: 0, bytes: expect.any(Number) }])
  expect(JSON.parse((await owner.legacyEvent('c', 0))!.event)).toMatchObject({
    text: 'kept prompt'
  })
  expect(await owner.uncoveredMarkerConversations()).toContain('c')
  expect(
    await owner.backfillEventMarkers('c', -1, { maxBytes: 4096, maxEvents: 10 })
  ).toMatchObject({ done: true, through: 0 })
  expect(await owner.uncoveredMarkerConversations()).toEqual([])
  expect(await owner.db.get('SELECT count(*) n FROM event_markers')).toEqual({ n: 1 })
})

test('close drains an accepted paced write and its deferred fence before physical exit', async () => {
  const dir = root()
  const owner = await open(dir)
  await owner.createConversation(identity)
  const writing = owner.writeTimeline('c', 1, {
    dropPagesFrom: 0,
    pages: [{ page: 0, value: '{"rows":"[]"}', summary: '{}', searchText: '' }],
    checkpoint: '{"seq":7}'
  })
  const fencing = owner.flush()
  await Promise.all([writing, fencing, owner.close(), owner.exited])
  const reopened = await open(dir)
  expect(await reopened.timelineRecord('c', 'checkpoint')).toBe('{"seq":7}')
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
