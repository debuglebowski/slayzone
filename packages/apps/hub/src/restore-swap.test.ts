/**
 * Restore = stage now, swap at the next boot, before anything opens the database
 * (D2). The swap is crash-safe — every step can run again after a crash at any point —
 * and a backup this build cannot open (corrupt, schema too new, mid-move) is refused
 * with nothing changed, so a restore can never leave a hub unable to boot (R1, R2, R8).
 */
import Database from 'better-sqlite3'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { readDataGeneration } from '@slayzone/platform/hub-data-generation'
import {
  applyPendingRestore,
  confirmRestore,
  pendingRestore,
  rollbackRestore,
  RESTORE_MARKER_FILE,
  stageRestore,
  validateRestoreSource
} from './restore-swap.js'

const LATEST = 300
let root: string
let dbPath: string
const backups = () => join(root, 'backups')

function makeDb(path: string, opts: { version?: number; marker: string; moves?: string[] }): void {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
  db.prepare('INSERT INTO settings VALUES (?, ?)').run('marker', opts.marker)
  if (opts.moves) {
    db.exec(`CREATE TABLE task_moves (id TEXT PRIMARY KEY, status TEXT NOT NULL)`)
    for (const [i, status] of opts.moves.entries())
      db.prepare('INSERT INTO task_moves VALUES (?, ?)').run(`m${i}`, status)
  }
  db.pragma(`user_version = ${opts.version ?? 200}`)
  db.pragma('wal_checkpoint(TRUNCATE)')
  db.close()
}

function makeBackup(name: string, opts: Parameters<typeof makeDb>[1]): string {
  mkdirSync(backups(), { recursive: true })
  const src = join(root, `src-${name}`)
  makeDb(src, opts)
  const dest = join(backups(), name)
  writeFileSync(dest, readFileSync(src))
  rmSync(src, { force: true })
  return name
}

function liveMarker(): string {
  const db = new Database(dbPath, { readonly: true })
  try {
    return (db.prepare("SELECT value FROM settings WHERE key='marker'").get() as { value: string })
      .value
  } finally {
    db.close()
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'slz-restore-swap-'))
  dbPath = join(root, 'slayzone.data.sqlite')
  makeDb(dbPath, { marker: 'live' })
  // An un-checkpointed live WAL, as a running hub leaves it.
  writeFileSync(`${dbPath}-wal`, 'stale wal')
  writeFileSync(`${dbPath}-shm`, 'stale shm')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const apply = (crashAt?: string) =>
  applyPendingRestore({
    dataRoot: root,
    dbPath,
    latestVersion: LATEST,
    crashAt: crashAt as never
  })

describe('validateRestoreSource', () => {
  test('a good backup passes', () => {
    const f = makeBackup('good.sqlite', { marker: 'b' })
    expect(() => validateRestoreSource(join(backups(), f), LATEST)).not.toThrow()
  })

  test('a newer schema than this build is refused (would never boot)', () => {
    const f = makeBackup('new.sqlite', { marker: 'b', version: LATEST + 1 })
    expect(() => validateRestoreSource(join(backups(), f), LATEST)).toThrow(
      expect.objectContaining({ code: 'too-new' })
    )
  })

  test('a corrupt file is refused', () => {
    mkdirSync(backups(), { recursive: true })
    writeFileSync(join(backups(), 'bad.sqlite'), 'not a database at all, just bytes')
    expect(() => validateRestoreSource(join(backups(), 'bad.sqlite'), LATEST)).toThrow(
      expect.objectContaining({ code: 'corrupt' })
    )
  })

  test('a missing file is refused', () => {
    expect(() => validateRestoreSource(join(backups(), 'nope.sqlite'), LATEST)).toThrow(
      expect.objectContaining({ code: 'missing' })
    )
  })

  test('a backup taken mid-move is refused (the move engine would resume it)', () => {
    const f = makeBackup('mid.sqlite', { marker: 'b', moves: ['done', 'running'] })
    expect(() => validateRestoreSource(join(backups(), f), LATEST)).toThrow(
      expect.objectContaining({ code: 'move-in-progress' })
    )
    const ok = makeBackup('after.sqlite', { marker: 'b', moves: ['done', 'canceled'] })
    expect(() => validateRestoreSource(join(backups(), ok), LATEST)).not.toThrow()
  })

  test('validating leaves the backup byte-identical', () => {
    const f = makeBackup('good.sqlite', { marker: 'b' })
    const before = readFileSync(join(backups(), f))
    validateRestoreSource(join(backups(), f), LATEST)
    expect(readFileSync(join(backups(), f)).equals(before)).toBe(true)
    expect(existsSync(join(backups(), `${f}-wal`))).toBe(false)
  })
})

const B = 'slayzone.data.2026-01-02T03-04-05-006Z.manual.sqlite'
const exists = (p: string) => existsSync(p)
const pre = () => `${dbPath}.pre-restore`

describe('stage + apply + confirm / roll back', () => {
  test('no marker: nothing happens', () => {
    expect(apply()).toEqual({ status: 'none' })
    expect(liveMarker()).toBe('live')
    expect(readDataGeneration(root)).toBe('initial')
  })

  test('swap: restored file in place, the old one KEPT beside it (with its WAL) until confirmed', () => {
    makeBackup(B, { marker: 'restored' })
    stageRestore({ dataRoot: root, backupFilename: B })
    expect(pendingRestore(root)?.backup).toBe(B)
    expect(apply()).toEqual({ status: 'applied-unverified', backup: B })
    expect(exists(`${dbPath}-wal`)).toBe(false)
    expect(exists(pre())).toBe(true)
    expect(readFileSync(`${pre()}-wal`, 'utf8')).toBe('stale wal')
    expect(pendingRestore(root)?.phase).toBe('swapped')
    expect(readDataGeneration(root), 'not yet: the restored file has not started').toBe('initial')
    expect(liveMarker()).toBe('restored')
    expect(exists(join(backups(), B)), 'the backup itself is kept').toBe(true)
  })

  test('confirm (the restored file opened and migrated): old copy and marker go, new generation', () => {
    makeBackup(B, { marker: 'restored' })
    stageRestore({ dataRoot: root, backupFilename: B })
    apply()
    expect(confirmRestore({ dataRoot: root, dbPath })).toEqual({ status: 'applied', backup: B })
    expect(exists(pre())).toBe(false)
    expect(exists(`${pre()}-wal`)).toBe(false)
    expect(exists(join(root, RESTORE_MARKER_FILE))).toBe(false)
    expect(readDataGeneration(root)).not.toBe('initial')
    expect(liveMarker()).toBe('restored')
  })

  test('roll back (the restored file failed to open): the old data is put back, as it was', () => {
    makeBackup(B, { marker: 'restored' })
    stageRestore({ dataRoot: root, backupFilename: B })
    apply()
    const r = rollbackRestore({ dataRoot: root, dbPath, error: 'migration v227 failed' })
    expect(r).toMatchObject({ status: 'refused', backup: B })
    expect((r as { error: string }).error).toMatch(/migration v227 failed/)
    expect((r as { error: string }).error).toMatch(/previous data was put back/)
    expect(liveMarker()).toBe('live')
    expect(readFileSync(`${dbPath}-wal`, 'utf8')).toBe('stale wal')
    expect(exists(pre())).toBe(false)
    expect(exists(join(root, RESTORE_MARKER_FILE))).toBe(false)
    expect(readDataGeneration(root)).toBe('initial')
  })

  test('a boot that finds an unconfirmed swap (the last start died on it) rolls back', () => {
    makeBackup(B, { marker: 'restored' })
    stageRestore({ dataRoot: root, backupFilename: B })
    apply()
    const r = apply()
    expect(r).toMatchObject({ status: 'refused', backup: B })
    expect((r as { error: string }).error).toMatch(/did not start/)
    expect(liveMarker()).toBe('live')
    expect(exists(pre())).toBe(false)
  })

  test('an applied restore starts a new data generation; a refused one does not', () => {
    makeBackup(B, { marker: 'restored' })
    stageRestore({ dataRoot: root, backupFilename: B })
    apply()
    confirmRestore({ dataRoot: root, dbPath })
    const first = readDataGeneration(root)
    expect(first).not.toBe('initial')
    writeFileSync(join(backups(), B), 'broken')
    stageRestore({ dataRoot: root, backupFilename: B })
    expect(apply().status).toBe('refused')
    expect(readDataGeneration(root)).toBe(first)
  })

  test.each(['copied', 'staged-recorded', 'sidecars-removed', 'renamed'])(
    'a crash after %s: the next boot finishes the swap',
    (step) => {
      makeBackup(B, { marker: 'restored' })
      stageRestore({ dataRoot: root, backupFilename: B })
      expect(() => apply(step)).toThrow(/simulated crash/)
      expect(apply()).toEqual({ status: 'applied-unverified', backup: B })
      expect(exists(`${dbPath}-wal`)).toBe(false)
      expect(readFileSync(`${pre()}-wal`, 'utf8')).toBe('stale wal')
      expect(confirmRestore({ dataRoot: root, dbPath }).status).toBe('applied')
      expect(exists(join(root, RESTORE_MARKER_FILE))).toBe(false)
      expect(liveMarker()).toBe('restored')
    }
  )

  test('M2: the disk fills during the boot copy → refused once, live DB kept, no boot loop', () => {
    makeBackup(B, { marker: 'restored' })
    stageRestore({ dataRoot: root, backupFilename: B })
    const r = applyPendingRestore({
      dataRoot: root,
      dbPath,
      latestVersion: LATEST,
      copyFile: () => {
        throw Object.assign(new Error('ENOSPC: no space left on device, copyfile'), {
          code: 'ENOSPC'
        })
      }
    })
    expect(r).toMatchObject({ status: 'refused', backup: B })
    expect((r as { error: string }).error).toMatch(/space/i)
    expect(liveMarker()).toBe('live')
    expect(readFileSync(`${dbPath}-wal`, 'utf8')).toBe('stale wal')
    expect(exists(`${dbPath}.restore-tmp`)).toBe(false)
    expect(apply(), 'the next boot does not retry it').toEqual({ status: 'none' })
  })

  test('a backup that went bad before the boot: refused, old DB kept, marker cleared', () => {
    makeBackup(B, { marker: 'restored' })
    stageRestore({ dataRoot: root, backupFilename: B })
    writeFileSync(join(backups(), B), 'truncated')
    const r = apply()
    expect(r.status).toBe('refused')
    expect(liveMarker()).toBe('live')
    expect(exists(`${dbPath}-wal`), 'the live WAL is untouched').toBe(true)
    expect(exists(join(root, RESTORE_MARKER_FILE))).toBe(false)
  })

  test('a backup deleted before the boot: refused, old DB kept', () => {
    makeBackup(B, { marker: 'restored' })
    stageRestore({ dataRoot: root, backupFilename: B })
    rmSync(join(backups(), B))
    expect(apply().status).toBe('refused')
    expect(liveMarker()).toBe('live')
  })

  test('a marker naming a path outside the backups dir is refused', () => {
    writeFileSync(
      join(root, RESTORE_MARKER_FILE),
      JSON.stringify({ v: 1, backup: '../slayzone.data.sqlite', phase: 'staged' })
    )
    expect(apply().status).toBe('refused')
    expect(liveMarker()).toBe('live')
  })

  test('L3: only a data backup can be restored — not another SQLite file in backups/', () => {
    const auth = 'slayzone.auth.2026-01-02T03-04-05-006Z.manual.sqlite'
    makeBackup(auth, { marker: 'auth db' })
    makeBackup('stray.sqlite', { marker: 'stray' })
    expect(() => stageRestore({ dataRoot: root, backupFilename: auth })).toThrow(/not a backup/)
    expect(() => stageRestore({ dataRoot: root, backupFilename: 'stray.sqlite' })).toThrow(
      /not a backup/
    )
    // A marker written some other way is refused at boot too.
    writeFileSync(
      join(root, RESTORE_MARKER_FILE),
      JSON.stringify({ v: 1, backup: auth, phase: 'staged' })
    )
    expect(apply().status).toBe('refused')
    expect(liveMarker()).toBe('live')
  })
})
