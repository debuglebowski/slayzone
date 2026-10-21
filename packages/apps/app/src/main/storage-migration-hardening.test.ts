/**
 * storage-migration hardening — what the v0.35.0 → new-minor first-launch copy does when
 * the source is NOT well-behaved. The happy path lives in `storage-migration.test.ts`;
 * this file pins the failure modes the data-safety audit reproduced (M5):
 *
 *   - a dangling symlink in `artifacts/` made the copy throw on EVERY launch, with no UI;
 *   - a 0-byte legacy DB crashed launch #1;
 *   - a failed DB copy left a half-written file at the destination, and "destination
 *     exists" then means "done" forever;
 *   - any unreadable content file aborted the whole boot.
 *
 * Policy under test: the DB import is ATOMIC (nothing at the final name until the copy is
 * complete and size-verified) and a failure there is FATAL and NAMES the path — booting
 * past it would let the hub create an empty DB beside the real one. Everything else
 * (blobs, artifacts, backups) is non-fatal: skip the bad entry, keep going, withhold the
 * sentinel so the next boot retries.
 *
 * Pure Node (real temp dirs, no electron/native deps) → runs under plain `npx tsx`.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureStorageDir } from './storage-migration'
import { StorageImportError } from './copy-utils'

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

const prevRoot = process.env.SLAYZONE_ROOT
// chmod 000 only blocks a non-root user, and means nothing on Windows.
const canDenyRead = process.platform !== 'win32' && process.getuid?.() !== 0

const bases: string[] = []

function setup(): { old: string; storage: string } {
  const base = mkdtempSync(join(tmpdir(), 'slz-storage-hard-'))
  bases.push(base)
  const home = join(base, 'root')
  const old = join(base, 'userData')
  mkdirSync(home, { recursive: true })
  mkdirSync(old, { recursive: true })
  process.env.SLAYZONE_ROOT = home
  return { old, storage: join(home, 'storage') }
}
const SENTINEL = '.storage-migrated.prod'

try {
  // --- 0-byte legacy DB: not a database, nothing to import; boot must not crash ----------
  {
    const { old, storage } = setup()
    writeFileSync(join(old, 'slayzone.sqlite'), '')
    mkdirSync(join(old, 'blobs', 'ab'), { recursive: true })
    writeFileSync(join(old, 'blobs', 'ab', 'cd'), 'BLOB')
    let threw = ''
    try {
      ensureStorageDir(old, storage, true)
    } catch (e) {
      threw = String(e)
    }
    check('0-byte legacy DB does not throw', threw === '', threw)
    check('0-byte legacy DB is not planted as the new DB', !existsSync(join(storage, 'slayzone.data.sqlite')))
    check('content still imported past a 0-byte DB', existsSync(join(storage, 'blobs', 'ab', 'cd')))
    check('sentinel written (nothing left to retry)', existsSync(join(storage, SENTINEL)))
  }

  // --- dangling symlink in artifacts/: copied as a link, never fatal, never a retry loop ---
  {
    const { old, storage } = setup()
    writeFileSync(join(old, 'slayzone.sqlite'), 'PRODDB')
    mkdirSync(join(old, 'artifacts', 't1'), { recursive: true })
    writeFileSync(join(old, 'artifacts', 't1', 'a.md'), 'ART')
    symlinkSync(join(old, 'gone', 'nowhere'), join(old, 'artifacts', 't1', 'dangling'))
    let threw = ''
    try {
      ensureStorageDir(old, storage, true)
    } catch (e) {
      threw = String(e)
    }
    check('dangling symlink does not throw', threw === '', threw)
    check('sibling files still copied', readFileSync(join(storage, 'artifacts', 't1', 'a.md'), 'utf8') === 'ART')
    check('DB copied', readFileSync(join(storage, 'slayzone.data.sqlite'), 'utf8') === 'PRODDB')
    check('sentinel written (a dangling link is not an incomplete copy)', existsSync(join(storage, SENTINEL)))
  }

  // --- unreadable content file: skipped, NOT fatal, sentinel withheld, next boot heals ----
  if (canDenyRead) {
    const { old, storage } = setup()
    writeFileSync(join(old, 'slayzone.sqlite'), 'PRODDB')
    mkdirSync(join(old, 'blobs', 'ab'), { recursive: true })
    writeFileSync(join(old, 'blobs', 'ab', 'good'), 'GOOD')
    writeFileSync(join(old, 'blobs', 'ab', 'locked'), 'LOCKED')
    chmodSync(join(old, 'blobs', 'ab', 'locked'), 0o000)
    let threw = ''
    let report: { complete: boolean; skipped: string[] } | undefined
    try {
      report = ensureStorageDir(old, storage, true) as typeof report
    } catch (e) {
      threw = String(e)
    }
    check('unreadable blob does not abort boot', threw === '', threw)
    check('the readable files and the DB still crossed over',
      existsSync(join(storage, 'blobs', 'ab', 'good')) && existsSync(join(storage, 'slayzone.data.sqlite')))
    check('sentinel withheld so the next boot retries', !existsSync(join(storage, SENTINEL)))
    check('report says incomplete and names the skipped file',
      report?.complete === false && (report?.skipped ?? []).some((p) => p.endsWith('locked')),
      JSON.stringify(report))
    // Next boot, file readable again → heals and blesses.
    chmodSync(join(old, 'blobs', 'ab', 'locked'), 0o644)
    const again = ensureStorageDir(old, storage, true) as { complete: boolean }
    check('retry copies the file once readable', readFileSync(join(storage, 'blobs', 'ab', 'locked'), 'utf8') === 'LOCKED')
    check('retry writes the sentinel', again.complete === true && existsSync(join(storage, SENTINEL)))
  }

  // --- DB copy fails: FATAL, names the source path, leaves NOTHING at the final name -------
  if (canDenyRead) {
    const { old, storage } = setup()
    writeFileSync(join(old, 'slayzone.sqlite'), 'PRODDB')
    writeFileSync(join(old, 'slayzone.sqlite-wal'), 'WALBYTES')
    chmodSync(join(old, 'slayzone.sqlite'), 0o000)
    let err: unknown
    try {
      ensureStorageDir(old, storage, true)
    } catch (e) {
      err = e
    }
    check('DB copy failure throws a StorageImportError', err instanceof StorageImportError, String(err))
    check('error names the file that failed',
      err instanceof StorageImportError && err.path.endsWith('slayzone.sqlite'), String((err as any)?.path))
    check('no main DB at the final name', !existsSync(join(storage, 'slayzone.data.sqlite')))
    check('no stray -wal beside a missing main (a foreign WAL replays into a fresh DB)',
      !existsSync(join(storage, 'slayzone.data.sqlite-wal')),
      readdirSync(storage).join(', '))
    check('no sentinel', !existsSync(join(storage, SENTINEL)))
    check('source untouched', readFileSync(join(old, 'slayzone.sqlite-wal'), 'utf8') === 'WALBYTES')
    chmodSync(join(old, 'slayzone.sqlite'), 0o644)
    ensureStorageDir(old, storage, true)
    check('retry after the cause is fixed imports the DB',
      readFileSync(join(storage, 'slayzone.data.sqlite'), 'utf8') === 'PRODDB')
  }

  // --- a crashed earlier attempt left temp files: they never block, never survive ----------
  {
    const { old, storage } = setup()
    writeFileSync(join(old, 'slayzone.sqlite'), 'PRODDB')
    mkdirSync(storage, { recursive: true })
    // Stale leftovers of an interrupted import, in every shape the importer could leave.
    writeFileSync(join(storage, 'slayzone.data.sqlite.importing'), 'HALF')
    writeFileSync(join(storage, 'slayzone.data.sqlite-wal.importing'), 'HALF')
    ensureStorageDir(old, storage, true)
    check('stale temp does not block the import', readFileSync(join(storage, 'slayzone.data.sqlite'), 'utf8') === 'PRODDB')
    check('no importing temp files remain',
      !readdirSync(storage).some((f) => f.endsWith('.importing')), readdirSync(storage).join(', '))
  }

  // --- wal travels with the DB, and a quiescent copy is byte-identical ---------------------
  {
    const { old, storage } = setup()
    writeFileSync(join(old, 'slayzone.sqlite'), 'MAIN-BYTES')
    writeFileSync(join(old, 'slayzone.sqlite-wal'), 'WAL-BYTES')
    writeFileSync(join(old, 'slayzone.sqlite-shm'), 'SHM-BYTES')
    ensureStorageDir(old, storage, true)
    check('main/wal/shm all land under the new name',
      readFileSync(join(storage, 'slayzone.data.sqlite'), 'utf8') === 'MAIN-BYTES' &&
        readFileSync(join(storage, 'slayzone.data.sqlite-wal'), 'utf8') === 'WAL-BYTES' &&
        readFileSync(join(storage, 'slayzone.data.sqlite-shm'), 'utf8') === 'SHM-BYTES')
  }
} finally {
  if (prevRoot === undefined) delete process.env.SLAYZONE_ROOT
  else process.env.SLAYZONE_ROOT = prevRoot
  // Every denied-read case restores its mode, so the trees are removable.
  for (const b of bases) rmSync(b, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
