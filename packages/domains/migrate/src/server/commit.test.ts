/**
 * commitMigration tests.
 * Run via packages/shared/test-utils/run-all.sh
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { test, expect, describe } from '../../../../shared/test-utils/ipc-harness.js'
import { commitMigration } from './commit.js'
import { isEmptyServer } from './health.js'
import type { Manifest } from '../shared/index.js'

interface Fixture {
  workDir: string
  dataRoot: string
  unpackedDir: string
  dstDb: Database.Database
  cleanup: () => void
}

function setupSourceDb(path: string): void {
  const db = new Database(path)
  db.pragma('user_version = 0')
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, worktree_path TEXT);
    CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  `)
  db.prepare('INSERT INTO tasks VALUES (?, ?, ?)').run('t1', 'first', '/some/local/wt')
  db.prepare('INSERT INTO tasks VALUES (?, ?, ?)').run('t2', 'second', null)
  db.prepare('INSERT INTO projects VALUES (?, ?)').run('p1', '/local/repo')
  db.prepare('INSERT INTO settings VALUES (?, ?)').run('slayzone_server_port', '7800')
  db.prepare('INSERT INTO settings VALUES (?, ?)').run('theme', 'dark')
  db.close()
}

function setupDestinationDb(path: string): Database.Database {
  const db = new Database(path)
  db.pragma('user_version = 0')
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, worktree_path TEXT);
    CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  `)
  return db
}

function setup(): Fixture {
  const workDir = mkdtempSync(join(tmpdir(), 'sz-mig-commit-'))
  const dataRoot = join(workDir, 'data')
  mkdirSync(dataRoot, { recursive: true })
  const unpackedDir = join(workDir, 'unpacked')
  mkdirSync(unpackedDir, { recursive: true })
  const dstDbPath = join(workDir, 'dst.sqlite')

  const srcDbPath = join(unpackedDir, 'db.sqlite')
  setupSourceDb(srcDbPath)

  mkdirSync(join(unpackedDir, 'artifacts', 't1'), { recursive: true })
  writeFileSync(join(unpackedDir, 'artifacts', 't1', 'note.md'), '# Hi\n')
  mkdirSync(join(unpackedDir, 'project-icons'), { recursive: true })
  writeFileSync(join(unpackedDir, 'project-icons', 'p1.png'), Buffer.from([1, 2, 3]))

  const dstDb = setupDestinationDb(dstDbPath)
  return {
    workDir,
    dataRoot,
    unpackedDir,
    dstDb,
    cleanup: () => {
      try { dstDb.close() } catch { /* ignore */ }
      try { rmSync(workDir, { recursive: true, force: true }) } catch { /* ignore */ }
    },
  }
}

const dummyManifest: Manifest = {
  protocolVersion: 1,
  source: { hostname: 'h', slayzoneVersion: '0', schemaUserVersion: 0, exportedAt: '' },
  tables: { tasks: 2, projects: 1, settings: 2 },
  files: [],
  totalContentBytes: 0,
}

await describe('commitMigration', () => {
  test('imports tables, nulls worktree_path, prunes server-process settings, moves files', () => {
    const fx = setup()
    try {
      const result = commitMigration({
        db: fx.dstDb,
        dataRoot: fx.dataRoot,
        unpackedDir: fx.unpackedDir,
        manifest: dummyManifest,
        dryRun: false,
      })

      expect(result.ok).toBe(true)
      expect(result.committed).toBe(true)
      expect(result.tables.tasks).toEqual({ expected: 2, actual: 2 })
      expect(result.tables.projects).toEqual({ expected: 1, actual: 1 })
      expect(result.worktreeRowsRewritten).toBe(1)

      const t1 = fx.dstDb.prepare('SELECT worktree_path FROM tasks WHERE id = ?').get('t1') as { worktree_path: string | null }
      expect(t1.worktree_path).toBeNull()

      const theme = fx.dstDb.prepare('SELECT value FROM settings WHERE key = ?').get('theme') as { value: string } | undefined
      expect(theme?.value).toBe('dark')
      const port = fx.dstDb.prepare('SELECT value FROM settings WHERE key = ?').get('slayzone_server_port')
      expect(port).toBeUndefined()

      expect(existsSync(join(fx.dataRoot, 'artifacts', 't1', 'note.md'))).toBe(true)
      expect(existsSync(join(fx.dataRoot, 'project-icons', 'p1.png'))).toBe(true)
    } finally {
      fx.cleanup()
    }
  })

  test('refuses commit if destination is non-empty (race-safe re-check)', () => {
    const fx = setup()
    try {
      fx.dstDb.prepare('INSERT INTO tasks VALUES (?, ?, ?)').run('preexisting', 'oops', null)
      expect(isEmptyServer(fx.dstDb)).toBe(false)
      let threw = false
      try {
        commitMigration({
          db: fx.dstDb,
          dataRoot: fx.dataRoot,
          unpackedDir: fx.unpackedDir,
          manifest: dummyManifest,
          dryRun: false,
        })
      } catch (err) {
        threw = true
        if (!(err instanceof Error) || !/no longer empty/.test(err.message)) {
          throw new Error(`Expected "no longer empty" error, got: ${err}`)
        }
      }
      expect(threw).toBe(true)
    } finally {
      fx.cleanup()
    }
  })

  test('returns counts without writing on dry-run', () => {
    const fx = setup()
    try {
      const result = commitMigration({
        db: fx.dstDb,
        dataRoot: fx.dataRoot,
        unpackedDir: fx.unpackedDir,
        manifest: dummyManifest,
        dryRun: true,
      })
      expect(result.ok).toBe(true)
      expect(result.committed).toBe(false)
      expect(result.dryRun).toBe(true)
      expect(result.tables.tasks.expected).toBe(2)
      const cnt = fx.dstDb.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }
      expect(cnt.n).toBe(0)
      expect(existsSync(join(fx.dataRoot, 'artifacts'))).toBe(false)
    } finally {
      fx.cleanup()
    }
  })
})
