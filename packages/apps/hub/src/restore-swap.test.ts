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
import {
  applyPendingRestore,
  pendingRestore,
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

describe('stage + apply', () => {
  test('no marker: nothing happens', () => {
    expect(apply()).toEqual({ status: 'none' })
    expect(liveMarker()).toBe('live')
  })

  test('applies the staged backup: live DB replaced, stale WAL/SHM gone, marker removed', () => {
    const f = makeBackup('b.sqlite', { marker: 'restored' })
    stageRestore({ dataRoot: root, backupFilename: f })
    expect(pendingRestore(root)?.backup).toBe(f)
    expect(apply()).toEqual({ status: 'applied', backup: f })
    expect(existsSync(`${dbPath}-wal`)).toBe(false)
    expect(existsSync(`${dbPath}-shm`)).toBe(false)
    expect(existsSync(join(root, RESTORE_MARKER_FILE))).toBe(false)
    expect(liveMarker()).toBe('restored')
    // The backup itself is kept.
    expect(existsSync(join(backups(), f))).toBe(true)
  })

  test.each(['copied', 'staged-recorded', 'sidecars-removed', 'renamed'])(
    'a crash after %s: the next boot finishes the swap',
    (step) => {
      const f = makeBackup('b.sqlite', { marker: 'restored' })
      stageRestore({ dataRoot: root, backupFilename: f })
      expect(() => apply(step)).toThrow(/simulated crash/)
      expect(apply()).toEqual({ status: 'applied', backup: f })
      expect(existsSync(`${dbPath}-wal`)).toBe(false)
      expect(existsSync(join(root, RESTORE_MARKER_FILE))).toBe(false)
      expect(liveMarker()).toBe('restored')
    }
  )

  test('a backup that went bad before the boot: refused, old DB kept, marker cleared', () => {
    const f = makeBackup('b.sqlite', { marker: 'restored' })
    stageRestore({ dataRoot: root, backupFilename: f })
    writeFileSync(join(backups(), f), 'truncated')
    const r = apply()
    expect(r.status).toBe('refused')
    expect(liveMarker()).toBe('live')
    expect(existsSync(`${dbPath}-wal`), 'the live WAL is untouched').toBe(true)
    expect(existsSync(join(root, RESTORE_MARKER_FILE))).toBe(false)
  })

  test('a backup deleted before the boot: refused, old DB kept', () => {
    const f = makeBackup('b.sqlite', { marker: 'restored' })
    stageRestore({ dataRoot: root, backupFilename: f })
    rmSync(join(backups(), f))
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
})
