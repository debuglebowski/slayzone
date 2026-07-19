/**
 * storage-migration — selective extract of our DB/artifacts/recent-backups from
 * the legacy Electron userData dir into `<ROOT>/storage`, copy-verify-delete,
 * idempotent. Drives ensureStorageDir against a fake old-dir via SLAYZONE_HOME_DIR.
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
  // --- migrates DB triplet + artifacts, deletes source, is idempotent --------
  {
    const { old, storage } = setup()
    writeFileSync(join(old, 'slayzone.sqlite'), 'DB')
    writeFileSync(join(old, 'slayzone.sqlite-wal'), 'WAL')
    writeFileSync(join(old, 'slayzone.sqlite-shm'), 'SHM')
    writeFileSync(join(old, 'slayzone.dev.sqlite'), 'DEVDB')
    mkdirSync(join(old, 'artifacts', 't1'), { recursive: true })
    writeFileSync(join(old, 'artifacts', 't1', 'a.md'), 'ART')
    // blobs/ = the actual artifact CONTENT (content-addressed) — MUST migrate.
    mkdirSync(join(old, 'blobs', 'd8'), { recursive: true })
    writeFileSync(join(old, 'blobs', 'd8', '3c76abcd'), 'BLOBCONTENT')
    // Excluded siblings that MUST stay behind:
    writeFileSync(join(old, 'slayzone.diagnostics.sqlite'), 'DIAG')
    writeFileSync(join(old, 'hub-auth.sqlite'), 'AUTH')

    ensureStorageDir(old, storage)
    check('main DB copied', readFileSync(join(storage, 'slayzone.sqlite'), 'utf8') === 'DB')
    check('wal + shm copied', existsSync(join(storage, 'slayzone.sqlite-wal')) && existsSync(join(storage, 'slayzone.sqlite-shm')))
    check('dev DB copied', readFileSync(join(storage, 'slayzone.dev.sqlite'), 'utf8') === 'DEVDB')
    check('artifacts copied (recursive)', readFileSync(join(storage, 'artifacts', 't1', 'a.md'), 'utf8') === 'ART')
    check('blobs copied (recursive)', readFileSync(join(storage, 'blobs', 'd8', '3c76abcd'), 'utf8') === 'BLOBCONTENT')
    check('source DB deleted', !existsSync(join(old, 'slayzone.sqlite')))
    check('source artifacts deleted', !existsSync(join(old, 'artifacts')))
    check('source blobs deleted', !existsSync(join(old, 'blobs')))
    check('EXCLUDED diagnostics stays behind', existsSync(join(old, 'slayzone.diagnostics.sqlite')))
    check('EXCLUDED hub-auth stays behind', existsSync(join(old, 'hub-auth.sqlite')))
    check('diagnostics NOT copied', !existsSync(join(storage, 'slayzone.diagnostics.sqlite')))

    // Idempotent: re-run does nothing, doesn't throw.
    ensureStorageDir(old, storage)
    check('idempotent re-run keeps migrated DB', readFileSync(join(storage, 'slayzone.sqlite'), 'utf8') === 'DB')
  }

  // --- migrates only the 2 most-recent backups -------------------------------
  {
    const { old, storage } = setup()
    writeFileSync(join(old, 'slayzone.sqlite'), 'DB')
    const bdir = join(old, 'backups')
    mkdirSync(bdir, { recursive: true })
    // timestamp-sortable names; only the last 2 should move.
    for (const ts of ['2026-01-01', '2026-02-01', '2026-03-01']) {
      writeFileSync(join(bdir, `slayzone.${ts}T00-00-00-000Z.auto.sqlite`), ts)
    }
    ensureStorageDir(old, storage)
    const dstB = join(storage, 'backups')
    check('newest 2 backups migrated', existsSync(join(dstB, 'slayzone.2026-02-01T00-00-00-000Z.auto.sqlite')) && existsSync(join(dstB, 'slayzone.2026-03-01T00-00-00-000Z.auto.sqlite')))
    check('oldest backup left behind', !existsSync(join(dstB, 'slayzone.2026-01-01T00-00-00-000Z.auto.sqlite')) && existsSync(join(bdir, 'slayzone.2026-01-01T00-00-00-000Z.auto.sqlite')))
  }

  // --- no-op when there is nothing to migrate --------------------------------
  {
    const { old, storage } = setup()
    ensureStorageDir(old, storage)
    check('empty source → storage dir created, no throw', existsSync(storage))
  }

  // --- never clobbers an already-populated storage DB ------------------------
  {
    const { old, storage } = setup()
    mkdirSync(storage, { recursive: true })
    writeFileSync(join(storage, 'slayzone.sqlite'), 'EXISTING')
    writeFileSync(join(old, 'slayzone.sqlite'), 'INCOMING')
    ensureStorageDir(old, storage)
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
