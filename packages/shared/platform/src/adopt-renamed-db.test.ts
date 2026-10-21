/**
 * adoptRenamedDatabase — in-place rename of a SQLite file (+ its -wal/-shm/-journal)
 * when a database is renamed between releases:
 *   slayzone.sqlite      → slayzone.data.sqlite   (dev: slayzone.dev.sqlite → slayzone.dev.data.sqlite)
 *   hub-auth.sqlite      → slayzone.auth.sqlite
 *
 * These files are the user's data and credentials, so every property below pins a way
 * the rename could silently lose or strand it:
 *   - the WAL must move WITH the main file (rows can live only there);
 *   - a target that already exists always wins and is never touched;
 *   - an interrupted rename must resume correctly on the next boot;
 *   - an ambiguous state must fail loudly rather than open a fresh empty database.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --experimental-loader ./packages/shared/test-utils/loader.ts packages/shared/platform/src/adopt-renamed-db.test.ts
 * (Electron's node because the last test opens a real better-sqlite3 database.)
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import Database from 'better-sqlite3'
import { test, expect } from '../../test-utils/ipc-harness.js'
import { adoptRenamedDatabase } from './adopt-renamed-db.js'
import { getDbName, getLegacyDbName, getDiagnosticsDbName } from './db.js'

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'slay-adopt-db-'))
}
const write = (dir: string, name: string, body: string): void =>
  fs.writeFileSync(path.join(dir, name), body)
const read = (dir: string, name: string): string => fs.readFileSync(path.join(dir, name), 'utf8')
const has = (dir: string, name: string): boolean => fs.existsSync(path.join(dir, name))

test('names: new main DB follows slayzone.<what>.sqlite; legacy and diagnostics names are pinned', () => {
  expect(getDbName(true)).toBe('slayzone.data.sqlite')
  expect(getDbName(false)).toBe('slayzone.dev.data.sqlite')
  expect(getLegacyDbName(true)).toBe('slayzone.sqlite')
  expect(getLegacyDbName(false)).toBe('slayzone.dev.sqlite')
  // The diagnostics file must keep its name (it is NOT derived from the main DB name).
  expect(getDiagnosticsDbName(true)).toBe('slayzone.diagnostics.sqlite')
  expect(getDiagnosticsDbName(false)).toBe('slayzone.dev.diagnostics.sqlite')
})

test('renames the main file when it is the only one', () => {
  const d = tmp()
  write(d, 'a.sqlite', 'MAIN')
  expect(adoptRenamedDatabase(d, 'a.sqlite', 'b.sqlite')).toBe('renamed')
  expect(read(d, 'b.sqlite')).toBe('MAIN')
  expect(has(d, 'a.sqlite')).toBe(false)
})

test('moves -wal, -shm and -journal together with the main file', () => {
  const d = tmp()
  write(d, 'a.sqlite', 'MAIN')
  write(d, 'a.sqlite-wal', 'WAL')
  write(d, 'a.sqlite-shm', 'SHM')
  write(d, 'a.sqlite-journal', 'JRN')
  adoptRenamedDatabase(d, 'a.sqlite', 'b.sqlite')
  expect(read(d, 'b.sqlite-wal')).toBe('WAL')
  expect(read(d, 'b.sqlite-shm')).toBe('SHM')
  expect(read(d, 'b.sqlite-journal')).toBe('JRN')
  expect(['a.sqlite', 'a.sqlite-wal', 'a.sqlite-shm', 'a.sqlite-journal'].some((n) => has(d, n))).toBe(false)
})

test('an existing target always wins and neither file is touched', () => {
  const d = tmp()
  write(d, 'a.sqlite', 'OLD')
  write(d, 'a.sqlite-wal', 'OLDWAL')
  write(d, 'b.sqlite', 'NEW')
  expect(adoptRenamedDatabase(d, 'a.sqlite', 'b.sqlite')).toBe('target-exists')
  expect(read(d, 'b.sqlite')).toBe('NEW')
  expect(read(d, 'a.sqlite')).toBe('OLD')
  expect(read(d, 'a.sqlite-wal')).toBe('OLDWAL')
  expect(has(d, 'b.sqlite-wal')).toBe(false)
})

test('nothing to rename is a no-op (fresh install, or already migrated)', () => {
  const d = tmp()
  expect(adoptRenamedDatabase(d, 'a.sqlite', 'b.sqlite')).toBe('no-source')
  expect(fs.readdirSync(d)).toHaveLength(0)
  expect(adoptRenamedDatabase(path.join(d, 'does-not-exist'), 'a.sqlite', 'b.sqlite')).toBe('no-source')
})

test('is idempotent: a second call changes nothing', () => {
  const d = tmp()
  write(d, 'a.sqlite', 'MAIN')
  adoptRenamedDatabase(d, 'a.sqlite', 'b.sqlite')
  expect(adoptRenamedDatabase(d, 'a.sqlite', 'b.sqlite')).toBe('target-exists')
  expect(read(d, 'b.sqlite')).toBe('MAIN')
})

test('resumes an interrupted rename: sidecars already moved, main not yet', () => {
  const d = tmp()
  // State after a crash between the -wal rename and the main rename.
  write(d, 'a.sqlite', 'MAIN')
  write(d, 'b.sqlite-wal', 'WAL')
  expect(adoptRenamedDatabase(d, 'a.sqlite', 'b.sqlite')).toBe('renamed')
  expect(read(d, 'b.sqlite')).toBe('MAIN')
  expect(read(d, 'b.sqlite-wal')).toBe('WAL')
  expect(has(d, 'a.sqlite')).toBe(false)
})

test('an ambiguous state throws and moves nothing (never opens a fresh empty DB)', () => {
  const d = tmp()
  // Both a source -wal and a stranded target -wal, with no target main file.
  write(d, 'a.sqlite', 'MAIN')
  write(d, 'a.sqlite-wal', 'OLDWAL')
  write(d, 'b.sqlite-wal', 'STRANDED')
  let msg = ''
  try {
    adoptRenamedDatabase(d, 'a.sqlite', 'b.sqlite')
  } catch (e) {
    msg = String(e)
  }
  expect(msg.includes('b.sqlite-wal')).toBe(true)
  expect(read(d, 'a.sqlite')).toBe('MAIN')
  expect(read(d, 'a.sqlite-wal')).toBe('OLDWAL')
  expect(read(d, 'b.sqlite-wal')).toBe('STRANDED')
  expect(has(d, 'b.sqlite')).toBe(false)
})

test('REAL SQLITE: rows that exist only in the WAL survive the rename', () => {
  const src = tmp()
  const live = new Database(path.join(src, 'a.sqlite'))
  live.pragma('journal_mode = WAL')
  live.pragma('wal_autocheckpoint = 0')
  live.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
  const ins = live.prepare('INSERT INTO t (v) VALUES (?)')
  for (let i = 0; i < 300; i++) ins.run(`row-${i}`)
  // Snapshot the on-disk state while the connection is still open: this is what a
  // crash leaves behind — the committed rows live in the -wal, not the main file.
  const d = tmp()
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(path.join(src, `a.sqlite${suffix}`))) {
      fs.copyFileSync(path.join(src, `a.sqlite${suffix}`), path.join(d, `a.sqlite${suffix}`))
    }
  }
  live.close()
  expect(fs.statSync(path.join(d, 'a.sqlite-wal')).size).toBeGreaterThan(0)

  expect(adoptRenamedDatabase(d, 'a.sqlite', 'b.sqlite')).toBe('renamed')

  const after = new Database(path.join(d, 'b.sqlite'))
  const count = (after.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n
  const ok = after.pragma('integrity_check', { simple: true })
  after.close()
  expect(count).toBe(300)
  expect(ok).toBe('ok')
})
