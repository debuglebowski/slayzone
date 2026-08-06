/**
 * The one-time move of client-scoped settings out of the shared database.
 *
 * The interesting cases are all the ways this could silently lose a user's
 * settings, because the sentinel makes a wrong "done" permanent:
 *   - it must NEVER write the sentinel when the read-back does not match;
 *   - it must NEVER clobber a value already set on this device;
 *   - it must NEVER modify the source rows (that is also the downgrade path).
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *     --experimental-loader ./packages/shared/test-utils/loader.ts \
 *     packages/apps/app/src/main/client-settings-migration.test.ts
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import Database from 'better-sqlite3'
import { test, expect } from '../../../../shared/test-utils/ipc-harness.js'
import { readClientSettings } from '@slayzone/platform/client-settings'
import { migrateClientSettings } from './client-settings-migration.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-cs-migration-'))

/** A minimal shared DB with just the settings table the migration reads. */
function makeDb(name: string, rows: Record<string, string>): string {
  const dbPath = path.join(root, `${name}.sqlite`)
  const db = new Database(dbPath)
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
  for (const [k, v] of Object.entries(rows)) stmt.run(k, v)
  db.close()
  return dbPath
}

function clientDir(name: string): string {
  const dir = path.join(root, `client-${name}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

const sentinelOf = (dir: string): string => path.join(dir, '.client-settings-migrated')

test('copies client keys and writes the sentinel', async () => {
  const dbPath = makeDb('a', {
    theme: 'light',
    labs_tests_panel: '1',
    diagnostics_retention_days: '30',
    cli_migration_dialog_shown: '1',
    floatingGlobalAgentPanelExpandedSize: JSON.stringify({ width: 500, height: 700 })
  })
  const dir = clientDir('a')
  const res = await migrateClientSettings({ clientRoot: dir, dbPath })
  expect(res.status).toBe('migrated')

  const got = readClientSettings(dir)
  expect(got.theme).toBe('light')
  expect(got.labs?.testsPanel).toBe(true)
  expect(got.diagnostics?.retentionDays).toBe(30)
  expect(got.cli?.migrationDialogShown).toBe(true)
  expect(got.floatingAgentPanel?.expandedSize?.width).toBe(500)
  expect(fs.existsSync(sentinelOf(dir))).toBe(true)
})

test('SOURCE ROWS ARE UNTOUCHED — copy-only, and the downgrade path', async () => {
  const dbPath = makeDb('b', { theme: 'dark' })
  const before = fs.readFileSync(dbPath)
  await migrateClientSettings({ clientRoot: clientDir('b'), dbPath })
  const db = new Database(dbPath, { readonly: true })
  const row = db.prepare("SELECT value FROM settings WHERE key = 'theme'").get() as {
    value: string
  }
  db.close()
  expect(row.value).toBe('dark')
  expect(Buffer.compare(before, fs.readFileSync(dbPath)) === 0).toBe(true)
})

test('second run is a no-op via the sentinel', async () => {
  const dbPath = makeDb('c', { theme: 'dark' })
  const dir = clientDir('c')
  await migrateClientSettings({ clientRoot: dir, dbPath })
  const res = await migrateClientSettings({ clientRoot: dir, dbPath })
  expect(res.status).toBe('already-migrated')
})

test('NEVER CLOBBERS a value already set on this device', async () => {
  const dbPath = makeDb('d', { theme: 'dark' })
  const dir = clientDir('d')
  // Device already has a theme (e.g. a crash between write and sentinel, then the
  // user changed it before the retry).
  fs.writeFileSync(path.join(dir, 'client-settings.json'), JSON.stringify({ theme: 'light' }))
  await migrateClientSettings({ clientRoot: dir, dbPath })
  expect(readClientSettings(dir).theme).toBe('light')
})

test('no source database → sentinel only, nothing invented', async () => {
  const dir = clientDir('e')
  const res = await migrateClientSettings({
    clientRoot: dir,
    dbPath: path.join(root, 'does-not-exist.sqlite')
  })
  expect(res.status).toBe('no-source')
  expect(Object.keys(readClientSettings(dir)).length).toBe(0)
  expect(fs.existsSync(sentinelOf(dir))).toBe(true)
})

test('REFUSES THE SENTINEL when the read-back does not match', async () => {
  const dbPath = makeDb('f', { theme: 'dark' })
  const dir = clientDir('f')
  // Make the destination unwritable so the write cannot persist. The migration
  // must surface that rather than mark itself done — a sentinel written over a
  // failed write is how settings are lost for good.
  fs.chmodSync(dir, 0o500)
  let threw = false
  try {
    await migrateClientSettings({ clientRoot: dir, dbPath })
  } catch {
    threw = true
  } finally {
    fs.chmodSync(dir, 0o700)
  }
  expect(threw).toBe(true)
  expect(fs.existsSync(sentinelOf(dir))).toBe(false)

  // And the retry on the next boot succeeds.
  const res = await migrateClientSettings({ clientRoot: dir, dbPath })
  expect(res.status).toBe('migrated')
  expect(readClientSettings(dir).theme).toBe('dark')
})
