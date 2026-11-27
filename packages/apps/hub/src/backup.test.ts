/**
 * Backup, owned by the process that owns the database.
 *
 * `db.backup()` snapshots a LIVE connection, and after the schema flip the only
 * live connection is the hub's. So backup could not stay on the Electron host
 * without the host keeping a connection open purely to serve it. Its actual
 * Electron surface is two calls: `app.relaunch()` and `shell.openPath()`.
 *
 * RESTORE = STAGE, THEN THE HUB RESTARTS ITSELF (D2). Nothing overwrites the live
 * file under an open connection: restore validates the backup (a file this build
 * cannot run is refused with nothing changed), takes a pre-restore backup, writes the
 * marker the next boot swaps from (restore-swap.ts), and only then — after its reply
 * — asks the hub to restart (exit 75). Any hub may do this; who may call it is the
 * admin gate (admin-policy.ts), not "is this the desktop's own hub".
 *
 * Run with: vitest (packages/shared/test-utils/vitest.harness.config.ts)
 */
import Database from 'better-sqlite3'
import { afterAll, expect, test } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness.js'
import { buildBackupOps } from './backup.js'
import { RESTORE_MARKER_FILE } from './restore-swap.js'

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

let canRestart = true
let respawner: 'desktop' | 'launchd' | 'systemd' | null = 'systemd'

function ops(): ReturnType<typeof buildBackupOps> {
  trace = []
  return buildBackupOps({
    db,
    sanitizeSnapshot: async () => {},
    // This sequence test writes a non-SQLite sentinel. Real snapshot/blob
    // protection is exercised with SQLite by backup-blobs.test.ts.
    artifactProtection: {
      prepare: async () => {},
      begin: async () => ({ pinSnapshot: async () => {}, finish: async () => {} }),
      forget: async () => {},
      close: async () => {
        trace.push('protection-close')
      }
    },
    dataRoot,
    dbPath,
    latestVersion: 300,
    restart: {
      available: () => canRestart,
      respawner: () => respawner,
      request: () => {
        trace.push('restart')
      },
      delayMs: 0
    },
    shellOpenPath: (p: string) => {
      trace.push(`reveal:${p}`)
    }
  })
}

/** Replace a listed backup's bytes with a real SQLite database. */
function realBackup(filename: string, opts: { version?: number; marker?: string } = {}): void {
  const file = path.join(dataRoot, 'backups', filename)
  fs.rmSync(file, { force: true })
  const b = new Database(file)
  b.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
  b.prepare('INSERT INTO settings VALUES (?, ?)').run('marker', opts.marker ?? 'restored')
  b.pragma(`user_version = ${opts.version ?? 200}`)
  b.close()
}

const marker = () => path.join(dataRoot, RESTORE_MARKER_FILE)
const flush = () => new Promise((r) => setTimeout(r, 20))

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

test('restore stages: pre-restore backup, marker, restart AFTER the reply; live file untouched', async () => {
  canRestart = true
  respawner = 'systemd'
  const o = ops()
  const made = await o.create('ToRestore')
  realBackup(made.filename)
  fs.writeFileSync(dbPath, 'LIVE-DB')

  const result = await o.restore(made.filename)
  expect(result).toMatchObject({ restarting: true, respawner: 'systemd' })
  // The reply goes out before the hub stops.
  expect(trace).not.toContain('restart')
  await flush()
  expect(trace).toContain('restart')
  // Staged, not swapped: the live file is only replaced at the next boot.
  expect(fs.readFileSync(dbPath, 'utf8')).toBe('LIVE-DB')
  expect(JSON.parse(fs.readFileSync(marker(), 'utf8'))).toMatchObject({ backup: made.filename })
  // A pre-restore backup of the current data, listed like any other.
  const pre = (await o.list()).find((b) => b.type === 'restore')
  expect(pre?.filename, 'pre-restore backup').toBeDefined()
  expect(result.preRestoreBackup).toBe(pre?.filename)
  // Fenced: no backup can start while the hub is going down.
  await expect(o.create('during')).rejects.toThrow(/restore/i)
  await expect(o.restore(made.filename)).rejects.toThrow(/restore/i)
  fs.rmSync(marker(), { force: true })
  for (const b of await o.list()) fs.rmSync(path.join(dataRoot, 'backups', b.filename))
})

test('a hub with nothing to restart it still stages, and says so (D6)', async () => {
  canRestart = true
  respawner = null
  const o = ops()
  const made = await o.create('Manual')
  realBackup(made.filename)
  expect(await o.restore(made.filename)).toMatchObject({ restarting: true, respawner: null })
  await flush()
  expect(trace).toContain('restart')
  fs.rmSync(marker(), { force: true })
  for (const b of await o.list()) fs.rmSync(path.join(dataRoot, 'backups', b.filename))
})

test('an embedded hub (no restart handler): staged, restarting=false, no restart', async () => {
  canRestart = false
  const o = ops()
  const made = await o.create('Embedded')
  realBackup(made.filename)
  expect(await o.restore(made.filename)).toMatchObject({ restarting: false })
  await flush()
  expect(trace).not.toContain('restart')
  canRestart = true
  fs.rmSync(marker(), { force: true })
  for (const b of await o.list()) fs.rmSync(path.join(dataRoot, 'backups', b.filename))
})

test.each([
  ['a newer schema', { version: 301 }, /newer/],
  ['a corrupt file', null, /cannot be opened|not a database|integrity/]
])('restore of %s is REFUSED with nothing changed', async (_what, opts, message) => {
  const o = ops()
  const made = await o.create('Bad')
  if (opts) realBackup(made.filename, opts)
  else fs.writeFileSync(path.join(dataRoot, 'backups', made.filename), 'not sqlite at all')
  fs.writeFileSync(dbPath, 'UNTOUCHED')
  const before = (await o.list()).length
  await expect(o.restore(made.filename)).rejects.toThrow(message)
  await flush()
  expect(trace).not.toContain('restart')
  expect(fs.existsSync(marker())).toBe(false)
  expect((await o.list()).length, 'no pre-restore backup').toBe(before)
  expect(fs.readFileSync(dbPath, 'utf8')).toBe('UNTOUCHED')
  // Not fenced: the hub keeps working.
  const after = await o.create('still works')
  await o.delete(after.filename)
  await o.delete(made.filename)
})

test('restore is REFUSED while a move is in progress on this hub (R8)', async () => {
  const o = ops()
  const made = await o.create('MidMove')
  realBackup(made.filename)
  h.db
    .prepare(
      `INSERT INTO task_moves (id, direction, peer_hub_id, target_project_id, root_task_ids,
         include_subtasks, step, status, created_at, updated_at)
       VALUES ('m1', 'out', 'peer', 'p', '[]', 0, 'copy', 'running', 0, 0)`
    )
    .run()
  try {
    await expect(o.restore(made.filename)).rejects.toThrow(/move/)
    expect(fs.existsSync(marker())).toBe(false)
  } finally {
    h.db.prepare("DELETE FROM task_moves WHERE id = 'm1'").run()
    await o.delete(made.filename)
  }
})

test('restoreStatus: boot id, respawner, the staged restore and what this boot did', async () => {
  respawner = 'launchd'
  const o = ops()
  const idle = await o.restoreStatus()
  expect(idle).toMatchObject({ respawner: 'launchd', pending: null, lastRestore: null })
  expect(idle.bootId).toMatch(/^[0-9a-f-]{36}$/)
  const made = await o.create('Status')
  realBackup(made.filename)
  await o.restore(made.filename)
  await flush()
  expect((await o.restoreStatus()).pending).toEqual({ backup: made.filename })
  fs.rmSync(marker(), { force: true })
  for (const b of await o.list()) fs.rmSync(path.join(dataRoot, 'backups', b.filename))
  const booted = buildBackupOps({
    db,
    dataRoot,
    dbPath,
    lastRestore: { status: 'refused', backup: 'x.sqlite', error: 'corrupt' },
    restart: { available: () => true, respawner: () => null, request: () => {} },
    shellOpenPath: () => {}
  })
  expect((await booted.restoreStatus()).lastRestore).toEqual({
    status: 'refused',
    backup: 'x.sqlite',
    error: 'corrupt'
  })
  await booted.close()
})

test('L3: a SQLite file in backups/ that is not a data backup cannot be restored', async () => {
  const o = ops()
  const stray = path.join(dataRoot, 'backups', 'stray.sqlite')
  const b = new Database(stray)
  b.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
  b.close()
  const before = (await o.list()).length
  await expect(o.restore('stray.sqlite')).rejects.toThrow(/not a backup/)
  expect(fs.existsSync(marker())).toBe(false)
  expect((await o.list()).length, 'no pre-restore backup').toBe(before)
  fs.rmSync(stray)
})

test('create and list work on any hub', async () => {
  const o = ops()
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
  expect(fs.existsSync(marker())).toBe(false)
})

test('delete/restore refuse a sibling sharing the dir prefix, the dir itself and NUL', async () => {
  const o = ops()
  // `<root>/backups-x` starts with `<root>/backups`: the old startsWith check let it by.
  const sibling = path.join(dataRoot, 'backups-x')
  fs.mkdirSync(sibling, { recursive: true })
  fs.writeFileSync(path.join(sibling, 'keep.sqlite'), 'KEEP')
  for (const filename of ['../backups-x/keep.sqlite', '', '.', 'a\0b']) {
    let code: unknown
    try {
      await o.delete(filename)
    } catch (err) {
      code = (err as { code?: unknown }).code
    }
    expect(code).toBe('PATH_OUTSIDE_BASE')
    code = undefined
    try {
      await o.restore(filename)
    } catch (err) {
      code = (err as { code?: unknown }).code
    }
    expect(code).toBe('PATH_OUTSIDE_BASE')
  }
  expect(fs.readFileSync(path.join(sibling, 'keep.sqlite'), 'utf8')).toBe('KEEP')
  expect(fs.existsSync(path.join(dataRoot, 'backups'))).toBe(true)
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

// Cleanup runs in afterAll, after every test has settled. (Under the old harness a
// module-scope rmSync ran while the first test was still mid-flight and deleted the
// backups dir underneath it — vitest's hooks don't have that race.)
afterAll(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true })
})
