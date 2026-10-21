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
const dbPath = path.join(dataRoot, 'slayzone.data.sqlite')
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

// The main DB was renamed slayzone.sqlite → slayzone.data.sqlite, and backup files are
// named from the live DB filename. Backups made before the rename carry the old
// prefix and are the user's safety net, so the Backups list must keep showing them.
test('a new backup is named from the renamed DB file', async () => {
  const o = ops()
  const made = await o.create('Named')
  expect(made.filename.startsWith('slayzone.data.')).toBe(true)
  await o.delete(made.filename)
})

test('backups under every historical prefix still list', async () => {
  const dir = path.join(dataRoot, 'backups')
  fs.mkdirSync(dir, { recursive: true })
  const ts = '2026-03-07T12-30-00-000Z'
  const names = [
    `slayzone.${ts}.manual.sqlite`, // v0.35.0 / beta prod
    `slayzone.dev.${ts}.auto.sqlite`, // v0.35.0 / beta dev
    `slayzone.data.${ts}.migration.sqlite`, // after the rename, prod
    `slayzone.dev.data.${ts}.manual.sqlite` // after the rename, dev
  ]
  for (const n of names) fs.writeFileSync(path.join(dir, n), 'B')
  fs.writeFileSync(path.join(dir, `slayzone.auth.${ts}.manual.sqlite`), 'NOT-A-BACKUP')
  const listed = (await ops().list()).map((b) => b.filename)
  for (const n of names) expect(listed.includes(n)).toBe(true)
  expect(listed.includes(`slayzone.auth.${ts}.manual.sqlite`)).toBe(false)
  for (const n of [...names, `slayzone.auth.${ts}.manual.sqlite`]) fs.rmSync(path.join(dir, n))
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

// --- Auto-backup retention (data-safety audit M3) -------------------------------------
// v0.35.0 skipped cleanup entirely when the cap was 0 ("0 = unlimited", which is what the
// Settings UI stores for Unlimited). The hub port lost that guard, so with Unlimited every
// tick deleted EVERY auto backup, including the one it had just made.
function seedAutoBackups(n: number): string[] {
  const dir = path.join(dataRoot, 'backups')
  fs.mkdirSync(dir, { recursive: true })
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const name = `slayzone.data.2026-01-0${i + 1}T10-00-00-000Z.auto.sqlite`
    fs.writeFileSync(path.join(dir, name), 'OLD-AUTO')
    out.push(name)
  }
  return out
}
function clearBackups(): void {
  const dir = path.join(dataRoot, 'backups')
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) fs.rmSync(path.join(dir, f))
}

test('Unlimited (0) auto backups: a tick adds one and deletes NOTHING', async () => {
  clearBackups()
  const o = ops()
  const seeded = seedAutoBackups(3)
  await o.setSettings({ autoEnabled: false, maxAutoBackups: 0 })
  await o.runAutoBackup()
  const autos = (await o.list()).filter((b) => b.type === 'auto').map((b) => b.filename)
  expect(autos.length).toBe(4)
  for (const n of seeded) expect(autos.includes(n)).toBe(true)
  clearBackups()
})

test('a finite cap keeps the newest N, including the backup just made', async () => {
  clearBackups()
  const o = ops()
  const seeded = seedAutoBackups(3)
  await o.setSettings({ autoEnabled: false, maxAutoBackups: 2 })
  await o.runAutoBackup()
  const autos = (await o.list()).filter((b) => b.type === 'auto').map((b) => b.filename)
  expect(autos.length).toBe(2)
  // The two newest are the fresh one and the newest seeded one; the two oldest went.
  expect(autos.includes(seeded[2])).toBe(true)
  expect(autos.includes(seeded[0])).toBe(false)
  expect(autos.includes(seeded[1])).toBe(false)
  clearBackups()
})

test('a cap never touches manual or migration backups', async () => {
  clearBackups()
  const o = ops()
  const dir = path.join(dataRoot, 'backups')
  fs.writeFileSync(path.join(dir, 'slayzone.data.2026-01-01T10-00-00-000Z.manual.sqlite'), 'M')
  fs.writeFileSync(path.join(dir, 'slayzone.data.2026-01-01T10-00-00-000Z.migration.sqlite'), 'G')
  await o.setSettings({ autoEnabled: false, maxAutoBackups: 1 })
  await o.runAutoBackup()
  await o.runAutoBackup()
  const kinds = (await o.list()).map((b) => b.type).sort()
  expect(kinds.join(',')).toBe('auto,manual,migration')
  clearBackups()
})

// v0.35.0 called startAutoBackup(db) at boot; the hub refactor dropped the call, so a user
// with the switch ON got no backups until they happened to touch the setting.
test('startAuto arms the timer when auto backup is enabled, and not when disabled', async () => {
  const o = ops()
  await o.setSettings({ autoEnabled: false })
  await o.startAuto()
  expect(o.autoRunning()).toBe(false)
  await o.setSettings({ autoEnabled: true })
  o.stopAuto()
  expect(o.autoRunning()).toBe(false)
  await o.startAuto()
  expect(o.autoRunning()).toBe(true)
  o.stopAuto()
  expect(o.autoRunning()).toBe(false)
  await o.setSettings({ autoEnabled: false })
})

// NO trailing `fs.rmSync(dataRoot)` here. The harness's `test()` queues async
// bodies and returns immediately, so a cleanup at module scope runs while the
// first test is still mid-flight — it deleted the backups dir underneath it, and
// only that test failed (later ones re-created the dir via mkdirSync), which is a
// confusing way to learn this. The OS reaps the temp dir.
