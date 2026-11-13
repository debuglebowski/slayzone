/**
 * Backup pins are retention metadata for bytes a retained backup still holds.
 * Content erasure keeps them (the bytes live until the backup is gone), so the
 * hub must be able to rebuild them after a restart even for erased tasks, and a
 * failed rebuild must never leave a retained backup with zero pins.
 */
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createTestHarness, type TestHarness } from '../../../../shared/test-utils/ipc-harness'
import { createArtifactBackupProtection, HUB_BACKUP_PIN_SCOPE } from './backup-pins'

const cleanups: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const hash = (text: string) => createHash('sha256').update(text).digest('hex')

async function fixture(versions: string[]) {
  const h: TestHarness = await createTestHarness()
  const root = h.tmpDir()
  cleanups.push(() => h.cleanup())
  h.db.exec(`INSERT INTO projects(id,name,color) VALUES('p','P','#000');
    INSERT INTO tasks(id,project_id,title) VALUES('t','p','Task');
    INSERT INTO task_artifacts(id,task_id,title) VALUES('a','t','file.txt');`)
  versions.forEach((text, i) =>
    h.db
      .prepare(
        'INSERT INTO artifact_versions(id,artifact_id,version_num,content_hash,size) VALUES(?,?,?,?,?)'
      )
      .run(`v${i}`, 'a', i + 1, hash(text), text.length)
  )
  mkdirSync(join(root, 'backups'))
  h.db.exec(`VACUUM INTO '${join(root, 'backups', 'old.sqlite')}'`)
  const protect = () => {
    const p = createArtifactBackupProtection(h.slayDb, root, (n) => n.endsWith('.sqlite'))
    cleanups.push(() => p.close())
    return p
  }
  const pins = () =>
    (
      h.db
        .prepare('SELECT content_hash FROM artifact_blob_pins WHERE scope=? AND owner_id=?')
        .all(HUB_BACKUP_PIN_SCOPE, 'old.sqlite') as Array<{ content_hash: string }>
    )
      .map((r) => r.content_hash)
      .sort()
  const recoveryGuards = () =>
    h.db.prepare("SELECT id FROM artifact_blob_leases WHERE id LIKE 'hub-backup-recovery:%'").all()
  // What erasure leaves: the job journal fences the task; content rows are gone;
  // backup pins are kept (bytes stay until the backup is gone).
  const erase = () =>
    h.db.exec(`INSERT INTO content_erasure_jobs(id,scope,manifest,db_erased) VALUES('j','{}','{}',1);
      INSERT INTO content_erasure_tasks(task_id,job_id) VALUES('t','j');
      DELETE FROM artifact_versions; DELETE FROM task_artifacts; DELETE FROM tasks WHERE id='t';`)
  return { h, root, protect, pins, recoveryGuards, erase }
}

test('a backup taken before an erasure is re-pinned after a hub restart', async () => {
  const f = await fixture(['A', 'B'])
  await f.protect().prepare()
  expect(f.pins()).toEqual([hash('A'), hash('B')].sort())
  f.erase()
  expect(f.pins(), 'erasure keeps backup pins').toHaveLength(2)

  // Restart: a fresh protection has no inspection cache and rebuilds every pin.
  await f.protect().prepare()

  expect(f.pins()).toEqual([hash('A'), hash('B')].sort())
  // Reconciliation completed: the recovery guard no longer defers blob GC.
  expect(f.recoveryGuards()).toEqual([])
})

test('a failed re-pin keeps the backup’s previous pins', async () => {
  const f = await fixture(['A', 'B'])
  await f.protect().prepare()
  expect(f.pins()).toHaveLength(2)
  // Any failure while inserting the rebuilt pins (here: the second one).
  f.h.db.exec(`CREATE TEMP TRIGGER fail_pin BEFORE INSERT ON artifact_blob_pins
    WHEN NEW.content_hash='${hash('B')}' BEGIN SELECT RAISE(ABORT,'injected'); END`)

  await f.protect().prepare()

  expect(f.pins(), 'never a retained backup with zero pins').toEqual([hash('A'), hash('B')].sort())
  // Inspection failed, so the guard keeps deferring GC (existing behavior).
  expect(f.recoveryGuards()).toHaveLength(1)
})

test('an unreadable backup is quarantined: the other backups are pinned and blob cleanup is unblocked', async () => {
  const f = await fixture(['A'])
  const { writeFileSync } = await import('node:fs')
  const { listQuarantine } = await import('@slayzone/platform/quarantine')
  // A damaged snapshot sorted BEFORE the good one.
  writeFileSync(join(f.root, 'backups', 'a-broken.sqlite'), 'this is not a database')
  const errors: unknown[] = []
  const original = console.error
  console.error = (...args: unknown[]) => void errors.push(args)
  try {
    await f.protect().prepare()
  } finally {
    console.error = original
  }
  expect(f.pins()).toEqual([hash('A')])
  expect(f.recoveryGuards(), 'GC no longer blocked').toEqual([])
  expect(listQuarantine(f.root)).toMatchObject([{ pass: 'hub-backup' }])
})
