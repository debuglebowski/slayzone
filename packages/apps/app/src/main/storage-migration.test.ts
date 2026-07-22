/**
 * storage-migration — COPY-ONLY extract of our DB/artifacts/blobs/recent-backups
 * from the legacy Electron userData dir into `<ROOT>/storage`. The legacy dir is
 * treated as STRICTLY READ-ONLY: we copy out, never delete/rename the source.
 * Channel-scoped: the packaged (prod) app migrates only `slayzone.sqlite`; a dev
 * build migrates only `slayzone.dev.sqlite` — neither ever touches the other's DB
 * or the shared dir it lives in. A per-channel sentinel makes it genuinely
 * one-time. Drives ensureStorageDir against a fake old-dir via SLAYZONE_HOME_DIR.
 *
 * Regression context: the userData dir is SHARED between a still-running
 * pre-refactor prod app and the post-refactor dev app (both `app.name='slayzone'`).
 * The old copy-then-DELETE migration, run by dev against that shared dir, deleted
 * prod's live `slayzone.sqlite` and prod's `artifacts/` working files. Copy-only +
 * channel-scope is the fix.
 *
 * Pure Node (real temp dirs, no electron/native deps) → runs under plain `npx tsx`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureStorageDir } from './storage-migration'

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${detail ? `\n    ${detail}` : ''}`)
  }
}

const prevHome = process.env.SLAYZONE_HOME_DIR
const prevRoot = process.env.SLAYZONE_ROOT

function setup(): { home: string; old: string; storage: string } {
  const base = mkdtempSync(join(tmpdir(), 'slz-storage-mig-'))
  const home = join(base, 'root')
  const old = join(base, 'userData')
  mkdirSync(home, { recursive: true })
  mkdirSync(old, { recursive: true })
  // getSlayzoneHomeDir reads SLAYZONE_ROOT > SLAYZONE_HOME_DIR; pin both to `home`.
  process.env.SLAYZONE_ROOT = home
  process.env.SLAYZONE_HOME_DIR = home
  return { home, old, storage: join(home, 'storage') }
}

try {
  // --- packaged (prod): copies its DB + content, DELETES NOTHING from source ----
  {
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
    check('prod DB copied', readFileSync(join(storage, 'slayzone.sqlite'), 'utf8') === 'PRODDB')
    check('wal + shm copied', existsSync(join(storage, 'slayzone.sqlite-wal')) && existsSync(join(storage, 'slayzone.sqlite-shm')))
    check('artifacts copied (recursive)', readFileSync(join(storage, 'artifacts', 't1', 'a.md'), 'utf8') === 'ART')
    check('blobs copied (recursive)', readFileSync(join(storage, 'blobs', 'd8', '3c76abcd'), 'utf8') === 'BLOBCONTENT')

    // SOURCE IS READ-ONLY — nothing removed from the legacy dir:
    check('source prod DB PRESERVED', readFileSync(join(old, 'slayzone.sqlite'), 'utf8') === 'PRODDB')
    check('source wal/shm PRESERVED', existsSync(join(old, 'slayzone.sqlite-wal')) && existsSync(join(old, 'slayzone.sqlite-shm')))
    check('source artifacts PRESERVED', readFileSync(join(old, 'artifacts', 't1', 'a.md'), 'utf8') === 'ART')
    check('source blobs PRESERVED', readFileSync(join(old, 'blobs', 'd8', '3c76abcd'), 'utf8') === 'BLOBCONTENT')

    // Channel scope — packaged NEVER touches the dev DB:
    check('dev DB NOT migrated by prod channel', !existsSync(join(storage, 'slayzone.dev.sqlite')))
    check('source dev DB untouched', readFileSync(join(old, 'slayzone.dev.sqlite'), 'utf8') === 'DEVDB')
    // Excluded sibling stays behind AND is not copied:
    check('diagnostics NOT copied', !existsSync(join(storage, 'slayzone.diagnostics.sqlite')))
  }

  // --- dev channel: migrates ONLY slayzone.dev.sqlite, never prod's DB ----------
  {
    const { old, storage } = setup()
    writeFileSync(join(old, 'slayzone.sqlite'), 'PRODDB') // prod's LIVE db — must be untouched
    writeFileSync(join(old, 'slayzone.dev.sqlite'), 'DEVDB')

    ensureStorageDir(old, storage, /* packaged */ false)

    check('dev DB copied', readFileSync(join(storage, 'slayzone.dev.sqlite'), 'utf8') === 'DEVDB')
    check('dev channel NEVER copies prod DB', !existsSync(join(storage, 'slayzone.sqlite')))
    check('dev channel NEVER touches prod DB source', readFileSync(join(old, 'slayzone.sqlite'), 'utf8') === 'PRODDB')
  }

  // --- merges MISSING content when dest dir already exists (orphan-class fix) ----
  // A post-refactor app writes NEW content into <storage>/{blobs,artifacts}, so
  // those dirs exist before migration. Copy-only must still merge legacy files not
  // already present — without clobbering the current (dest) copies.
  {
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

    check('orphan working file merged into existing dest', readFileSync(join(storage, 'artifacts', 'tX', 'a.txt'), 'utf8') === 'ORPHANWF')
    check('pre-existing dest blob untouched', readFileSync(join(storage, 'blobs', 'ab', 'newhash'), 'utf8') === 'NEW')
    check('colliding dest file NOT clobbered (dest wins)', readFileSync(join(storage, 'blobs', '77', 'orphanhash'), 'utf8') === 'CURRENT')
    check('merge leaves source intact', readFileSync(join(old, 'artifacts', 'tX', 'a.txt'), 'utf8') === 'ORPHANWF')
  }

  // --- channel-scoped backups, copy-only ----------------------------------------
  {
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
    check('prod backup migrated (copy)', existsSync(join(dstB, 'slayzone.2026-03-01T00-00-00-000Z.manual.sqlite')))
    check('dev backup NOT migrated by prod channel', !existsSync(join(dstB, 'slayzone.dev.2026-02-01T00-00-00-000Z.manual.sqlite')))
    check('source backups PRESERVED', existsSync(join(bdir, 'slayzone.2026-03-01T00-00-00-000Z.manual.sqlite')) && existsSync(join(bdir, 'slayzone.dev.2026-02-01T00-00-00-000Z.manual.sqlite')))
  }

  // --- per-channel sentinel → genuinely one-time (skips the shared dir after) ----
  {
    const { old, storage } = setup()
    writeFileSync(join(old, 'slayzone.sqlite'), 'DB')
    ensureStorageDir(old, storage, true)
    check('first run copies DB', readFileSync(join(storage, 'slayzone.sqlite'), 'utf8') === 'DB')
    // Simulate the running prod app writing a NEW blob to the shared dir afterward.
    mkdirSync(join(old, 'blobs', 'ff'), { recursive: true })
    writeFileSync(join(old, 'blobs', 'ff', 'laterblob'), 'LATER')
    ensureStorageDir(old, storage, true) // second boot
    check('sentinel makes 2nd run a no-op (does NOT re-scan shared dir)', !existsSync(join(storage, 'blobs', 'ff', 'laterblob')))
  }

  // --- no-op when there is nothing to migrate -----------------------------------
  {
    const { old, storage } = setup()
    ensureStorageDir(old, storage, true)
    check('empty source → storage dir created, no throw', existsSync(storage))
  }

  // --- never clobbers an already-populated storage DB ---------------------------
  {
    const { old, storage } = setup()
    mkdirSync(storage, { recursive: true })
    writeFileSync(join(storage, 'slayzone.sqlite'), 'EXISTING')
    writeFileSync(join(old, 'slayzone.sqlite'), 'INCOMING')
    ensureStorageDir(old, storage, true)
    check('existing storage DB not clobbered', readFileSync(join(storage, 'slayzone.sqlite'), 'utf8') === 'EXISTING')
    check('source left intact when target exists', existsSync(join(old, 'slayzone.sqlite')))
  }
} finally {
  if (prevHome === undefined) delete process.env.SLAYZONE_HOME_DIR
  else process.env.SLAYZONE_HOME_DIR = prevHome
  if (prevRoot === undefined) delete process.env.SLAYZONE_ROOT
  else process.env.SLAYZONE_ROOT = prevRoot
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
