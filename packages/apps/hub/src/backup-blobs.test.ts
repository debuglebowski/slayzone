import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, expect, test, vi } from 'vitest'
import { createArtifactStore, BlobStore } from '@slayzone/task-artifacts/server'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness'
import { buildBackupOps } from './backup'
import { sanitizeHubChatBackup } from './chat-backup'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function fixture(sanitizeSnapshot?: (path: string) => Promise<void>) {
  const h = await createTestHarness(),
    dir = mkdtempSync(join(realpathSync(tmpdir()), 'hub-backup-blobs-'))
  cleanups.push(() => {
    h.cleanup()
    rmSync(dir, { recursive: true, force: true })
  })
  h.db.exec(
    "INSERT INTO projects(id,name,color) VALUES('p','P','#000'); INSERT INTO tasks(id,project_id,title) VALUES('task','p','Task')"
  )
  const db = { ...h.slayDb, backup: (path: string) => h.db.backup(path).then(() => {}) }
  const artifacts = createArtifactStore(dir),
    blobs = new BlobStore(dir)
  const artifact = (await artifacts.uploadArtifactBlob(db, {
    taskId: 'task',
    title: 'file.txt',
    bytes: Buffer.from('A')
  }))!
  const ops = buildBackupOps({
    db,
    dataRoot: dir,
    dbPath: join(dir, 'slayzone.data.sqlite'),
    supervised: true,
    closeDb: async () => {},
    appRelaunch: () => {},
    shellOpenPath: () => {},
    ...(sanitizeSnapshot ? { sanitizeSnapshot } : {})
  })
  cleanups.push(() => ops.close())
  const gc = () =>
    artifacts.pruneArtifactVersions(db, { artifactId: artifact.id, keepLast: 1, keepNamed: false })
  const edit = (text: string) =>
    artifacts.writeArtifactContent(db, {
      artifactId: artifact.id,
      bytes: Buffer.from(text),
      mutateCurrent: true
    })
  return {
    h,
    dir,
    db,
    ops,
    artifacts,
    artifact,
    blobs,
    gc,
    edit,
    hash: (text: string) => createHash('sha256').update(text).digest('hex')
  }
}

test('hub backup holds original bytes across live mutation, GC and snapshot publication', async () => {
  let release!: () => void, ready!: () => void
  const pause = new Promise<void>((r) => {
      release = r
    }),
    started = new Promise<void>((r) => {
      ready = r
    })
  const f = await fixture(async (path) => {
    await sanitizeHubChatBackup(path)
    ready()
    await pause
  })
  const work = f.ops.create()
  try {
    await started
    await f.edit('B')
    await f.gc()
    expect(f.blobs.has(f.hash('A'))).toBe(true)
    release()
    const backup = await work
    await f.gc()
    expect(f.blobs.has(f.hash('A'))).toBe(true)
    await f.ops.delete(backup.filename)
    await f.gc()
    expect(f.blobs.has(f.hash('A'))).toBe(false)
  } finally {
    release()
    await work.catch(() => {})
  }
})

test('new snapshots do not inherit deleted backups blob pins', async () => {
  const f = await fixture()
  const first = await f.ops.create()
  await f.edit('B')
  const second = await f.ops.create()
  await f.ops.delete(first.filename)
  await f.gc()
  expect(f.blobs.has(f.hash('A'))).toBe(false)
  expect((await f.ops.list()).map((b) => b.filename)).toEqual([second.filename])
  expect(f.blobs.has(f.hash('B'))).toBe(true)
})

test('concurrent backup publication has distinct filenames under the same clock', async () => {
  const f = await fixture()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-02T22:00:00Z'))
  const backups = await Promise.all([f.ops.create('one'), f.ops.create('two')])
  expect(new Set(backups.map((b) => b.filename)).size).toBe(2)
  expect(await f.ops.list()).toHaveLength(2)
  expect((await f.ops.list()).map((b) => b.name).sort()).toEqual(['one', 'two'])
})

test('restored hub rebuilds completed snapshot pins before garbage collection can run', async () => {
  const f = await fixture()
  const first = await f.ops.create()
  await f.edit('B')
  const second = await f.ops.create()
  await f.ops.close()
  f.h.db.prepare("DELETE FROM artifact_blob_pins WHERE scope='hub-backup'").run()
  const recovered = buildBackupOps({
    db: f.db,
    dataRoot: f.dir,
    dbPath: join(f.dir, 'slayzone.data.sqlite'),
    supervised: true,
    closeDb: async () => {},
    appRelaunch: () => {},
    shellOpenPath: () => {}
  })
  cleanups.push(() => recovered.close())
  await f.gc()
  await recovered.prepare()
  await f.gc()
  expect(f.blobs.has(f.hash('A'))).toBe(true)
  await recovered.delete(first.filename)
  await f.gc()
  expect(f.blobs.has(f.hash('A'))).toBe(false)
  expect((await recovered.list())[0].filename).toBe(second.filename)
})

test('failed snapshot publication releases provisional pins and its lease', async () => {
  let f: Awaited<ReturnType<typeof fixture>>
  f = await fixture(async (path) => {
    await sanitizeHubChatBackup(path)
    await f.edit('B')
  })
  const rename = fs.renameSync
  vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
    if (String(source).includes('/backups/.pending-'))
      throw new Error('injected publication failure')
    return rename(source, destination)
  })
  await expect(f.ops.create()).rejects.toThrow('injected publication failure')
  await f.gc()
  expect(await f.ops.list()).toEqual([])
  expect(
    f.h.db.prepare("SELECT count(*) n FROM artifact_blob_pins WHERE scope='hub-backup'").get()
  ).toEqual({ n: 0 })
  expect(
    f.h.db.prepare("SELECT count(*) n FROM artifact_blob_leases WHERE id LIKE 'hub-backup:%'").get()
  ).toEqual({ n: 0 })
  expect(f.blobs.has(f.hash('A'))).toBe(false)
})

test('directory sync failure after rename keeps a recoverable backup protected', async () => {
  let f: Awaited<ReturnType<typeof fixture>>
  f = await fixture(async (path) => {
    await sanitizeHubChatBackup(path)
    await f.edit('B')
  })
  const open = fs.openSync,
    close = fs.closeSync,
    sync = fs.fsyncSync,
    dirs = new Set<number>()
  vi.spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => {
    const fd = open(path, flags, mode)
    if (String(path) === join(f.dir, 'backups')) dirs.add(fd)
    return fd
  })
  vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
    close(fd)
    dirs.delete(fd)
  })
  let failed = false
  vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
    if (!failed && dirs.has(fd)) {
      failed = true
      throw new Error('injected directory sync failure')
    }
    sync(fd)
  })
  await expect(f.ops.create()).rejects.toThrow('injected directory sync failure')
  expect(failed).toBe(true)
  await f.gc()
  const backups = await f.ops.list()
  expect(backups).toHaveLength(1)
  expect(f.blobs.has(f.hash('A'))).toBe(true)
  await f.ops.delete(backups[0].filename)
  await f.gc()
  expect(f.blobs.has(f.hash('A'))).toBe(false)
})

test('snapshot retains a pinned migration blob after its mutable version and live consumer are gone', async () => {
  const f = await fixture()
  f.h.db
    .prepare('INSERT INTO artifact_blob_pins VALUES(?,?,?,?,?,?,?,?,?)')
    .run('durable-consumer', 'owner', 'migration', 'file', 'task', f.artifact.id, 1, f.hash('A'), 1)
  await f.edit('B')
  await f.gc()
  const backup = await f.ops.create()
  f.h.db.prepare("DELETE FROM artifact_blob_pins WHERE scope='durable-consumer'").run()
  await f.gc()
  expect(f.blobs.has(f.hash('A'))).toBe(true)
  await f.ops.delete(backup.filename)
  await f.gc()
  expect(f.blobs.has(f.hash('A'))).toBe(false)
})

test('restart under an unchanged clock never overwrites a completed backup', async () => {
  const f = await fixture()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-02T22:00:00Z'))
  const first = await f.ops.create()
  await f.ops.close()
  await f.edit('B')
  const next = buildBackupOps({
    db: f.db,
    dataRoot: f.dir,
    dbPath: join(f.dir, 'slayzone.data.sqlite'),
    supervised: true,
    closeDb: async () => {},
    appRelaunch: () => {},
    shellOpenPath: () => {}
  })
  cleanups.push(() => next.close())
  const second = await next.create()
  expect(second.filename).not.toBe(first.filename)
  expect(await next.list()).toHaveLength(2)
})

test('hub startup erases abandoned unpublished source snapshots and their WAL files', async () => {
  const f = await fixture()
  await f.ops.close()
  const pending = join(f.dir, 'backups', `.pending-${randomUUID()}.sqlite`)
  fs.writeFileSync(pending, 'PRIVATE_UNPUBLISHED_CHAT_SOURCE')
  fs.writeFileSync(pending + '-wal', 'PRIVATE_UNPUBLISHED_WAL')
  const next = buildBackupOps({
    db: f.db,
    dataRoot: f.dir,
    dbPath: join(f.dir, 'slayzone.data.sqlite'),
    supervised: true,
    closeDb: async () => {},
    appRelaunch: () => {},
    shellOpenPath: () => {}
  })
  cleanups.push(() => next.close())
  await next.prepare()
  expect(fs.existsSync(pending)).toBe(false)
  expect(fs.existsSync(pending + '-wal')).toBe(false)
})
