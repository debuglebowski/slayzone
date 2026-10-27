/**
 * storage-migration — COPY-ONLY extract of our DB/artifacts/blobs/recent-backups
 * from the legacy Electron userData dir into `<ROOT>/storage`. The legacy dir is
 * treated as STRICTLY READ-ONLY: we copy out, never delete/rename the source.
 * Channel-scoped: the packaged (prod) app migrates only `slayzone.sqlite`; a dev
 * build migrates only `slayzone.dev.sqlite` — neither ever touches the other's DB
 * or the shared dir it lives in. A per-channel sentinel makes it genuinely
 * one-time. Drives ensureStorageDir against a fake old-dir via SLAYZONE_ROOT.
 *
 * Regression context: the userData dir is SHARED between a still-running
 * pre-refactor prod app and the post-refactor dev app (both `app.name='slayzone'`).
 * The old copy-then-DELETE migration, run by dev against that shared dir, deleted
 * prod's live `slayzone.sqlite` and prod's `artifacts/` working files. Copy-only +
 * channel-scope is the fix.
 *
 * Pure Node (real temp dirs, no electron/native deps).
 */
import { afterAll, describe, expect, test } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureStorageDir } from './storage-migration'

const prevRoot = process.env.SLAYZONE_ROOT

function setup(): { home: string; old: string; storage: string } {
  const base = mkdtempSync(join(tmpdir(), 'slz-storage-mig-'))
  const home = join(base, 'root')
  const old = join(base, 'userData')
  mkdirSync(home, { recursive: true })
  mkdirSync(old, { recursive: true })
  // getSlayzoneHomeDir reads SLAYZONE_ROOT; pin it to `home`.
  process.env.SLAYZONE_ROOT = home
  return { home, old, storage: join(home, 'storage') }
}

// Each describe body below runs its scenario at collection time (setup() pins
// SLAYZONE_ROOT, then ensureStorageDir reads it immediately); the tests only read
// the resulting files afterwards.
afterAll(() => {
  if (prevRoot === undefined) delete process.env.SLAYZONE_ROOT
  else process.env.SLAYZONE_ROOT = prevRoot
})

// --- packaged (prod): copies its DB + content, DELETES NOTHING from source ----
describe('packaged (prod): copies its DB + content, DELETES NOTHING from source', () => {
  const { old, storage } = setup()
  writeFileSync(join(old, 'slayzone.sqlite'), 'PRODDB')
  writeFileSync(join(old, 'slayzone.sqlite-wal'), 'WAL')
  writeFileSync(join(old, 'slayzone.sqlite-shm'), 'SHM')
  writeFileSync(join(old, 'slayzone.dev.sqlite'), 'DEVDB')
  mkdirSync(join(old, 'artifacts', 't1'), { recursive: true })
  writeFileSync(join(old, 'artifacts', 't1', 'a.md'), 'ART')
  mkdirSync(join(old, 'blobs', 'd8'), { recursive: true })
  writeFileSync(join(old, 'blobs', 'd8', '3c76abcd'), 'BLOBCONTENT')
  writeFileSync(join(old, 'slayzone.diagnostics.sqlite'), 'DIAG')

  ensureStorageDir(old, storage, /* packaged */ true)

  // Copied into new storage:
  // The legacy source keeps the old name; the copy lands under the renamed main DB.
  test('prod DB copied', () => {
    expect(readFileSync(join(storage, 'slayzone.data.sqlite'), 'utf8')).toBe('PRODDB')
  })
  test('legacy name NOT created in storage', () => {
    expect(existsSync(join(storage, 'slayzone.sqlite'))).toBe(false)
  })
  test('wal + shm copied', () => {
    expect(existsSync(join(storage, 'slayzone.data.sqlite-wal'))).toBe(true)
    expect(existsSync(join(storage, 'slayzone.data.sqlite-shm'))).toBe(true)
  })
  test('artifacts copied (recursive)', () => {
    expect(readFileSync(join(storage, 'artifacts', 't1', 'a.md'), 'utf8')).toBe('ART')
  })
  test('blobs copied (recursive)', () => {
    expect(readFileSync(join(storage, 'blobs', 'd8', '3c76abcd'), 'utf8')).toBe('BLOBCONTENT')
  })

  // SOURCE IS READ-ONLY — nothing removed from the legacy dir:
  test('source prod DB PRESERVED', () => {
    expect(readFileSync(join(old, 'slayzone.sqlite'), 'utf8')).toBe('PRODDB')
  })
  test('source wal/shm PRESERVED', () => {
    expect(existsSync(join(old, 'slayzone.sqlite-wal'))).toBe(true)
    expect(existsSync(join(old, 'slayzone.sqlite-shm'))).toBe(true)
  })
  test('source artifacts PRESERVED', () => {
    expect(readFileSync(join(old, 'artifacts', 't1', 'a.md'), 'utf8')).toBe('ART')
  })
  test('source blobs PRESERVED', () => {
    expect(readFileSync(join(old, 'blobs', 'd8', '3c76abcd'), 'utf8')).toBe('BLOBCONTENT')
  })

  // Channel scope — packaged NEVER touches the dev DB:
  test('dev DB NOT migrated by prod channel', () => {
    expect(existsSync(join(storage, 'slayzone.dev.sqlite'))).toBe(false)
    expect(existsSync(join(storage, 'slayzone.dev.data.sqlite'))).toBe(false)
  })
  test('source dev DB untouched', () => {
    expect(readFileSync(join(old, 'slayzone.dev.sqlite'), 'utf8')).toBe('DEVDB')
  })
  // Excluded sibling stays behind AND is not copied:
  test('diagnostics NOT copied', () => {
    expect(existsSync(join(storage, 'slayzone.diagnostics.sqlite'))).toBe(false)
  })
})

// --- dev channel: migrates ONLY slayzone.dev.sqlite, never prod's DB ----------
describe("dev channel: migrates ONLY slayzone.dev.sqlite, never prod's DB", () => {
  const { old, storage } = setup()
  writeFileSync(join(old, 'slayzone.sqlite'), 'PRODDB') // prod's LIVE db — must be untouched
  writeFileSync(join(old, 'slayzone.dev.sqlite'), 'DEVDB')

  ensureStorageDir(old, storage, /* packaged */ false)

  test('dev DB copied', () => {
    expect(readFileSync(join(storage, 'slayzone.dev.data.sqlite'), 'utf8')).toBe('DEVDB')
  })
  test('dev channel NEVER copies prod DB', () => {
    expect(existsSync(join(storage, 'slayzone.sqlite'))).toBe(false)
    expect(existsSync(join(storage, 'slayzone.data.sqlite'))).toBe(false)
  })
  test('dev channel NEVER touches prod DB source', () => {
    expect(readFileSync(join(old, 'slayzone.sqlite'), 'utf8')).toBe('PRODDB')
  })
})

// --- merges MISSING content when dest dir already exists (orphan-class fix) ----
// A post-refactor app writes NEW content into <storage>/{blobs,artifacts}, so
// those dirs exist before migration. Copy-only must still merge legacy files not
// already present — without clobbering the current (dest) copies.
describe('merges MISSING content when dest dir already exists (orphan-class fix)', () => {
  const { old, storage } = setup()
  writeFileSync(join(old, 'slayzone.sqlite'), 'DB')
  mkdirSync(join(old, 'blobs', '77'), { recursive: true })
  writeFileSync(join(old, 'blobs', '77', 'orphanhash'), 'ORPHAN')
  mkdirSync(join(old, 'artifacts', 'tX'), { recursive: true })
  writeFileSync(join(old, 'artifacts', 'tX', 'a.txt'), 'ORPHANWF')
  // Dest already populated by the running app (different + colliding content):
  mkdirSync(join(storage, 'blobs', 'ab'), { recursive: true })
  writeFileSync(join(storage, 'blobs', 'ab', 'newhash'), 'NEW')
  mkdirSync(join(storage, 'blobs', '77'), { recursive: true })
  writeFileSync(join(storage, 'blobs', '77', 'orphanhash'), 'CURRENT') // collision

  ensureStorageDir(old, storage, true)

  test('orphan working file merged into existing dest', () => {
    expect(readFileSync(join(storage, 'artifacts', 'tX', 'a.txt'), 'utf8')).toBe('ORPHANWF')
  })
  test('pre-existing dest blob untouched', () => {
    expect(readFileSync(join(storage, 'blobs', 'ab', 'newhash'), 'utf8')).toBe('NEW')
  })
  test('colliding dest file NOT clobbered (dest wins)', () => {
    expect(readFileSync(join(storage, 'blobs', '77', 'orphanhash'), 'utf8')).toBe('CURRENT')
  })
  test('merge leaves source intact', () => {
    expect(readFileSync(join(old, 'artifacts', 'tX', 'a.txt'), 'utf8')).toBe('ORPHANWF')
  })
})

// --- channel-scoped backups, copy-only ----------------------------------------
describe('channel-scoped backups, copy-only', () => {
  const { old, storage } = setup()
  writeFileSync(join(old, 'slayzone.sqlite'), 'DB')
  const bdir = join(old, 'backups')
  mkdirSync(bdir, { recursive: true })
  // prod-named + dev-named backups intermixed:
  writeFileSync(join(bdir, 'slayzone.2026-01-01T00-00-00-000Z.manual.sqlite'), 'P1')
  writeFileSync(join(bdir, 'slayzone.2026-03-01T00-00-00-000Z.manual.sqlite'), 'P3')
  writeFileSync(join(bdir, 'slayzone.dev.2026-02-01T00-00-00-000Z.manual.sqlite'), 'D2')

  ensureStorageDir(old, storage, /* packaged */ true)
  const dstB = join(storage, 'backups')
  test('prod backup migrated (copy)', () => {
    expect(existsSync(join(dstB, 'slayzone.2026-03-01T00-00-00-000Z.manual.sqlite'))).toBe(true)
  })
  test('dev backup NOT migrated by prod channel', () => {
    expect(existsSync(join(dstB, 'slayzone.dev.2026-02-01T00-00-00-000Z.manual.sqlite'))).toBe(
      false
    )
  })
  test('source backups PRESERVED', () => {
    expect(existsSync(join(bdir, 'slayzone.2026-03-01T00-00-00-000Z.manual.sqlite'))).toBe(true)
    expect(existsSync(join(bdir, 'slayzone.dev.2026-02-01T00-00-00-000Z.manual.sqlite'))).toBe(true)
  })
})

// --- per-channel sentinel → genuinely one-time (skips the shared dir after) ----
describe('per-channel sentinel → genuinely one-time (skips the shared dir after)', () => {
  const { old, storage } = setup()
  writeFileSync(join(old, 'slayzone.sqlite'), 'DB')
  ensureStorageDir(old, storage, true)
  test('first run copies DB', () => {
    expect(readFileSync(join(storage, 'slayzone.data.sqlite'), 'utf8')).toBe('DB')
  })
  // Simulate the running prod app writing a NEW blob to the shared dir afterward.
  mkdirSync(join(old, 'blobs', 'ff'), { recursive: true })
  writeFileSync(join(old, 'blobs', 'ff', 'laterblob'), 'LATER')
  ensureStorageDir(old, storage, true) // second boot
  test('sentinel makes 2nd run a no-op (does NOT re-scan shared dir)', () => {
    expect(existsSync(join(storage, 'blobs', 'ff', 'laterblob'))).toBe(false)
  })
})

// --- no-op when there is nothing to migrate -----------------------------------
describe('no-op when there is nothing to migrate', () => {
  const { old, storage } = setup()
  ensureStorageDir(old, storage, true)
  test('empty source → storage dir created, no throw', () => {
    expect(existsSync(storage)).toBe(true)
  })
})

// --- never clobbers an already-populated storage DB ---------------------------
describe('never clobbers an already-populated storage DB', () => {
  const { old, storage } = setup()
  mkdirSync(storage, { recursive: true })
  writeFileSync(join(storage, 'slayzone.data.sqlite'), 'EXISTING')
  writeFileSync(join(old, 'slayzone.sqlite'), 'INCOMING')
  ensureStorageDir(old, storage, true)
  test('existing storage DB not clobbered', () => {
    expect(readFileSync(join(storage, 'slayzone.data.sqlite'), 'utf8')).toBe('EXISTING')
  })
  test('source left intact when target exists', () => {
    expect(existsSync(join(old, 'slayzone.sqlite'))).toBe(true)
  })
})
