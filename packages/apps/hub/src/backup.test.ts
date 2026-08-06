/**
 * Backup, owned by the process that owns the database.
 *
 * `db.backup()` snapshots a LIVE connection, and after the schema flip the only
 * live connection is the hub's. So backup could not stay on the Electron host
 * without the host keeping a connection open purely to serve it. Its actual
 * Electron surface is two calls: `app.relaunch()` and `shell.openPath()`.
 *
 * TWO THINGS ARE LOAD-BEARING HERE.
 *
 * 1. RESTORE ORDERING. Restore overwrites the live database file, then relaunches
 *    the desktop — which kills the side-car as a child process. If the relaunch
 *    is issued before the copy is complete and the connection closed, the restored
 *    file is truncated and the user's data is gone. The order must be:
 *    stop timer → close connection → copy → unlink -wal/-shm → relaunch LAST.
 *    This is the highest-consequence sequence in the whole DB-ownership change,
 *    so it is asserted directly rather than left to code review.
 *
 * 2. RESTORE IS REFUSED ON A REMOTE HUB. Once backup follows the database, a
 *    remote-mode client's Backups UI acts on whichever hub it is connected to.
 *    Creating and listing are fine. Restore is a destructive whole-DB overwrite
 *    plus a relaunch — on a shared hub one client would silently overwrite
 *    everyone's data, and the relaunch semantics do not even apply to a server the
 *    client does not run.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *     --experimental-loader ./packages/shared/test-utils/loader.ts \
 *     packages/apps/hub/src/backup.test.ts
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createTestHarness, test, expect } from '../../../shared/test-utils/ipc-harness.js'
import { buildBackupOps } from './backup.js'

const h = await createTestHarness()

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-hub-backup-'))
const dbPath = path.join(dataRoot, 'slayzone.sqlite')
fs.writeFileSync(dbPath, 'LIVE-DB')
fs.writeFileSync(`${dbPath}-wal`, 'WAL')
fs.writeFileSync(`${dbPath}-shm`, 'SHM')

/** Records the order of the irreversible steps so the sequence can be asserted. */
let trace: string[] = []

// The shared harness stubs `backup()` as a no-op, so nothing would land on disk
// and every file assertion here would be vacuous. Give it one that actually
// writes — this test is about the restore SEQUENCE and the name/settings
// bookkeeping around it, not about better-sqlite3's snapshot fidelity.
const db: typeof h.slayDb = {
  ...h.slayDb,
  backup: async (destPath: string) => {
    fs.writeFileSync(destPath, 'SNAPSHOT')
  }
}

function ops(opts: { supervised?: boolean } = {}): ReturnType<typeof buildBackupOps> {
  trace = []
  return buildBackupOps({
    db,
    dataRoot,
    dbPath,
    supervised: opts.supervised ?? true,
    closeDb: async () => {
      trace.push('close')
    },
    appRelaunch: () => {
      trace.push('relaunch')
    },
    shellOpenPath: (p: string) => {
      trace.push(`reveal:${p}`)
    }
  })
}

test('create → list → rename → delete round-trips', async () => {
  const o = ops()
  const made = await o.create('First')
  expect(made.name).toBe('First')
  const listed = await o.list()
  expect(listed.length).toBe(1)
  expect(listed[0].filename).toBe(made.filename)

  await o.rename(made.filename, 'Renamed')
  expect((await o.list())[0].name).toBe('Renamed')

  await o.delete(made.filename)
  expect((await o.list()).length).toBe(0)
})

test('restore: close → copy → unlink wal/shm → relaunch LAST', async () => {
  const o = ops()
  const made = await o.create('ToRestore')
  // Make the on-disk backup distinguishable from the live file.
  fs.writeFileSync(path.join(dataRoot, 'backups', made.filename), 'RESTORED-BYTES')
  fs.writeFileSync(dbPath, 'LIVE-DB')
  fs.writeFileSync(`${dbPath}-wal`, 'WAL')
  fs.writeFileSync(`${dbPath}-shm`, 'SHM')

  await o.restore(made.filename)

  // The relaunch kills the side-car — anything after it may simply not happen.
  expect(trace[trace.length - 1]).toBe('relaunch')
  expect(trace.indexOf('close') < trace.indexOf('relaunch')).toBe(true)
  expect(fs.readFileSync(dbPath, 'utf8')).toBe('RESTORED-BYTES')
  expect(fs.existsSync(`${dbPath}-wal`)).toBe(false)
  expect(fs.existsSync(`${dbPath}-shm`)).toBe(false)
})

test('restore is REFUSED on a non-supervised (remote/standalone) hub', async () => {
  const o = ops({ supervised: false })
  const made = await o.create('NoRestore')
  fs.writeFileSync(dbPath, 'UNTOUCHED')

  let threw = false
  try {
    await o.restore(made.filename)
  } catch {
    threw = true
  }
  expect(threw).toBe(true)
  // Nothing destructive ran, and the live file is byte-identical.
  expect(trace.length).toBe(0)
  expect(fs.readFileSync(dbPath, 'utf8')).toBe('UNTOUCHED')
  await o.delete(made.filename)
})

test('create and list still work on a non-supervised hub', async () => {
  const o = ops({ supervised: false })
  const made = await o.create('RemoteOk')
  expect((await o.list()).some((b) => b.filename === made.filename)).toBe(true)
  await o.delete(made.filename)
})

test('restore rejects a filename escaping the backups dir', async () => {
  const o = ops()
  let threw = false
  try {
    await o.restore('../../etc/passwd')
  } catch {
    threw = true
  }
  expect(threw).toBe(true)
  expect(trace.length).toBe(0)
})

// NO trailing `fs.rmSync(dataRoot)` here. The harness's `test()` queues async
// bodies and returns immediately, so a cleanup at module scope runs while the
// first test is still mid-flight — it deleted the backups dir underneath it, and
// only that test failed (later ones re-created the dir via mkdirSync), which is a
// confusing way to learn this. The OS reaps the temp dir.
