import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import type { SlayzoneDb } from '@slayzone/platform'
import { createArtifactStore, BlobStore } from '@slayzone/task-artifacts/server'
import { createArtifactBackupProtection } from '@slayzone/task-artifacts/storage'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness'
import { buildBackupOps } from './backup'

const cleanups: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function fixture() {
  const h = await createTestHarness()
  const dir = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'hub-backup-pin-review-'))
  cleanups.push(() => {
    h.cleanup()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  h.db.exec(
    "INSERT INTO projects(id,name,color) VALUES('p','P','#000'); INSERT INTO tasks(id,project_id,title) VALUES('task','p','Task')"
  )
  const db: SlayzoneDb = {
    ...h.slayDb,
    backup: (path) => h.db.backup(path).then(() => {})
  }
  const artifacts = createArtifactStore(dir),
    blobs = new BlobStore(dir)
  const artifact = (await artifacts.uploadArtifactBlob(db, {
    taskId: 'task',
    title: 'file.txt',
    bytes: Buffer.from('A')
  }))!
  const deps = {
    db,
    dataRoot: dir,
    dbPath: join(dir, 'slayzone.data.sqlite'),
    supervised: true,
    closeDb: async () => {},
    appRelaunch: () => {},
    shellOpenPath: () => {}
  }
  const ops = buildBackupOps(deps)
  cleanups.push(() => ops.close())
  return {
    h,
    dir,
    db,
    deps,
    ops,
    blobs,
    artifact,
    hash: (text: string) => createHash('sha256').update(text).digest('hex'),
    edit: (text: string) =>
      artifacts.writeArtifactContent(db, {
        artifactId: artifact.id,
        bytes: Buffer.from(text),
        mutateCurrent: true
      }),
    gc: () =>
      artifacts.pruneArtifactVersions(db, {
        artifactId: artifact.id,
        keepLast: 1,
        keepNamed: false
      })
  }
}

test('deleting during pin reconstruction cannot resurrect deleted backup pins', async () => {
  const f = await fixture()
  const backup = await f.ops.create()
  await f.edit('B')
  await f.ops.close()
  f.h.db.prepare("DELETE FROM artifact_blob_pins WHERE scope='hub-backup'").run()
  let entered!: () => void, release!: () => void
  const reached = new Promise<void>((done) => {
      entered = done
    }),
    held = new Promise<void>((done) => {
      release = done
    })
  const db: SlayzoneDb = {
    ...f.db,
    batchTxn: async (ops) => {
      if (
        ops.some((op) => op.type === 'run' && op.sql.startsWith('INSERT INTO artifact_blob_pins'))
      ) {
        entered()
        await held
      }
      return f.db.batchTxn(ops)
    }
  }
  const protection = createArtifactBackupProtection(db, f.dir, (name) => name === backup.filename)
  cleanups.push(() => protection.close())
  const rebuilding = protection.prepare()
  try {
    await reached
    fs.unlinkSync(join(f.dir, 'backups', backup.filename))
    const removal = protection.forget(backup.filename)
    // Let removal enter its database/fence await. A correct implementation may
    // wait for reconstruction, so do not wait for its DELETE before releasing.
    await Promise.resolve()
    release()
    await Promise.all([rebuilding, removal])
    expect(
      f.h.db.prepare("SELECT count(*) n FROM artifact_blob_pins WHERE scope='hub-backup'").get()
    ).toEqual({ n: 0 })
    await f.gc()
    expect(f.blobs.has(f.hash('A'))).toBe(false)
  } finally {
    release()
    await rebuilding
  }
})

test('restore keeps failed-reconstruction guard until the live connection closes', async () => {
  const f = await fixture()
  const backup = await f.ops.create()
  await f.edit('B')
  await f.ops.close()
  f.h.db.prepare("DELETE FROM artifact_blob_pins WHERE scope='hub-backup'").run()
  let fail = true
  const db: SlayzoneDb = {
    ...f.db,
    batchTxn: async (ops) => {
      if (
        fail &&
        ops.some((op) => op.type === 'run' && op.sql.startsWith('INSERT INTO artifact_blob_pins'))
      )
        throw new Error('injected pin rebuild failure')
      return f.db.batchTxn(ops)
    }
  }
  const restored = buildBackupOps({
    ...f.deps,
    db,
    // A queued GC may run before the asynchronous worker close request. This
    // callback models that last live-connection operation, without real relaunch.
    closeDb: async () => {
      await f.gc()
    }
  })
  cleanups.push(() => restored.close())
  await restored.prepare()
  expect(
    f.h.db.prepare("SELECT count(*) n FROM artifact_blob_pins WHERE scope='hub-backup'").get()
  ).toEqual({ n: 0 })
  expect(
    f.h.db
      .prepare("SELECT count(*) n FROM artifact_blob_leases WHERE id LIKE 'hub-backup-recovery:%'")
      .get()
  ).toEqual({ n: 1 })
  fail = false
  await restored.restore(backup.filename)
  expect(f.blobs.has(f.hash('A'))).toBe(true)
})

test('a backup published after a reconstruction census retains its independent blob pins', async () => {
  const f = await fixture()
  await f.ops.create()
  await f.ops.close()
  await f.edit('B')
  let hold = false,
    entered!: () => void,
    release!: () => void
  const reached = new Promise<void>((done) => {
      entered = done
    }),
    held = new Promise<void>((done) => {
      release = done
    })
  const db: SlayzoneDb = {
    ...f.db,
    all: async <T>(sql: string, params?: unknown[]) => {
      if (hold && sql.startsWith('SELECT DISTINCT owner_id FROM artifact_blob_pins')) {
        entered()
        await held
      }
      return f.db.all<T>(sql, params)
    }
  }
  const protection = createArtifactBackupProtection(db, f.dir, (name) =>
    name.endsWith('.manual.sqlite')
  )
  cleanups.push(() => protection.close())
  const filename = 'slayzone.data.2030-01-01T00-00-00-000Z.manual.sqlite'
  const publication = await protection.begin(filename)
  const pending = join(f.dir, 'backups', '.pending-review.sqlite')
  await f.db.backup(pending)
  await publication.pinSnapshot(pending)
  await f.edit('C')
  hold = true
  const rebuilding = protection.prepare()
  try {
    await reached
    fs.renameSync(pending, join(f.dir, 'backups', filename))
    await publication.finish(true)
    release()
    await rebuilding
    expect(
      f.h.db
        .prepare(
          "SELECT count(*) n FROM artifact_blob_pins WHERE scope='hub-backup' AND owner_id=?"
        )
        .get(filename)
    ).toEqual({ n: 1 })
    await f.gc()
    expect(f.blobs.has(f.hash('B'))).toBe(true)
  } finally {
    release()
    await rebuilding
    await publication.finish(true)
  }
})

test('metadata-only hub backup remains available for salvage when an original was already missing', async () => {
  const f = await fixture()
  fs.unlinkSync(f.blobs.blobPath(f.hash('A')))
  const backup = await f.ops.create()
  expect((await f.ops.list()).map((b) => b.filename)).toEqual([backup.filename])
  expect(f.blobs.has(f.hash('A'))).toBe(false)
})
