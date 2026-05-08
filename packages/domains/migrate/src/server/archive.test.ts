/**
 * archive pack/unpack round-trip tests.
 * Run via packages/shared/test-utils/run-all.sh
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { test, expect, describe } from '../../../../shared/test-utils/ipc-harness.js'
import { packArchive, unpackArchive, readManifest, verifyManifestAgainstUnpacked } from './archive.js'

interface Fixture {
  workDir: string
  dataRoot: string
  dbPath: string
  archivePath: string
  manifestPath: string
  cleanup: () => void
}

function setup(): Fixture {
  const workDir = mkdtempSync(join(tmpdir(), 'sz-mig-'))
  const dataRoot = join(workDir, 'data')
  mkdirSync(dataRoot, { recursive: true })
  const dbPath = join(workDir, 'db.sqlite')
  const archivePath = join(workDir, 'archive.tar')
  const manifestPath = join(workDir, 'manifest.json')

  const db = new Database(dbPath)
  db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT)')
  db.prepare('INSERT INTO tasks VALUES (?, ?)').run('t1', 'Hello')
  db.close()

  mkdirSync(join(dataRoot, 'artifacts', 't1'), { recursive: true })
  writeFileSync(join(dataRoot, 'artifacts', 't1', 'note.md'), '# Hello\n')
  mkdirSync(join(dataRoot, 'project-icons'), { recursive: true })
  writeFileSync(join(dataRoot, 'project-icons', 'p1.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

  return {
    workDir,
    dataRoot,
    dbPath,
    archivePath,
    manifestPath,
    cleanup: () => { try { rmSync(workDir, { recursive: true, force: true }) } catch { /* ignore */ } },
  }
}

await describe('archive pack/unpack round-trip', () => {
  test('packs all files, computes sha256, and unpacks back to a verifiable tree', async () => {
    const fx = setup()
    try {
      const result = await packArchive({
        dbSnapshotPath: fx.dbPath,
        dataRoot: fx.dataRoot,
        outArchivePath: fx.archivePath,
        outManifestPath: fx.manifestPath,
        hostname: 'test-host',
        slayzoneVersion: '99.0.0',
        schemaUserVersion: 0,
        tables: { tasks: 1 },
      })
      expect(result.archiveBytes).toBeGreaterThan(0)
      if (!/^[0-9a-f]{64}$/.test(result.archiveSha256)) throw new Error('bad sha256 format')
      expect(result.manifest.files.length).toBeGreaterThan(0)
      expect(result.manifest.files.some((f) => f.path === 'db.sqlite')).toBe(true)
      expect(result.manifest.files.some((f) => f.path === 'artifacts/t1/note.md')).toBe(true)
      expect(result.manifest.files.some((f) => f.path === 'project-icons/p1.png')).toBe(true)
      expect(result.manifest.tables).toEqual({ tasks: 1 })

      const unpacked = join(fx.workDir, 'unpacked')
      await unpackArchive(fx.archivePath, unpacked)
      expect(existsSync(join(unpacked, 'manifest.json'))).toBe(true)
      expect(existsSync(join(unpacked, 'db.sqlite'))).toBe(true)
      expect(existsSync(join(unpacked, 'artifacts', 't1', 'note.md'))).toBe(true)
      expect(existsSync(join(unpacked, 'project-icons', 'p1.png'))).toBe(true)

      const onDisk = await readManifest(unpacked)
      expect(onDisk.files.length).toBe(result.manifest.files.length)
      const verify = await verifyManifestAgainstUnpacked(unpacked, onDisk)
      expect(verify.ok).toBe(true)
      expect(verify.missing.length).toBe(0)
      expect(verify.mismatched.length).toBe(0)
      expect(verify.extra.length).toBe(0)
    } finally {
      fx.cleanup()
    }
  })

  test('detects file tampering after unpack', async () => {
    const fx = setup()
    try {
      const result = await packArchive({
        dbSnapshotPath: fx.dbPath,
        dataRoot: fx.dataRoot,
        outArchivePath: fx.archivePath,
        outManifestPath: fx.manifestPath,
        hostname: 'test-host',
        slayzoneVersion: '99.0.0',
        schemaUserVersion: 0,
        tables: { tasks: 1 },
      })
      const unpacked = join(fx.workDir, 'unpacked')
      await unpackArchive(fx.archivePath, unpacked)
      writeFileSync(join(unpacked, 'artifacts', 't1', 'note.md'), '# Tampered\n')
      const verify = await verifyManifestAgainstUnpacked(unpacked, result.manifest)
      expect(verify.ok).toBe(false)
      expect(verify.mismatched.includes('artifacts/t1/note.md')).toBe(true)
    } finally {
      fx.cleanup()
    }
  })

  test('handles a dataRoot with no artifacts/ or project-icons/', async () => {
    const fx = setup()
    try {
      const bareRoot = join(fx.workDir, 'bare')
      mkdirSync(bareRoot, { recursive: true })
      const result = await packArchive({
        dbSnapshotPath: fx.dbPath,
        dataRoot: bareRoot,
        outArchivePath: fx.archivePath,
        outManifestPath: fx.manifestPath,
        hostname: 'test-host',
        slayzoneVersion: '99.0.0',
        schemaUserVersion: 0,
        tables: { tasks: 1 },
      })
      expect(result.manifest.files.find((f) => f.path === 'db.sqlite') !== undefined).toBe(true)
      expect(result.manifest.files.find((f) => f.path.startsWith('artifacts/')) === undefined).toBe(true)
      expect(result.manifest.files.find((f) => f.path.startsWith('project-icons/')) === undefined).toBe(true)
    } finally {
      fx.cleanup()
    }
  })
})
