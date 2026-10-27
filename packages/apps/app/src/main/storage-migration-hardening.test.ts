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
 * Pure Node (real temp dirs, no electron/native deps).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
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

afterAll(() => {
  if (prevRoot === undefined) delete process.env.SLAYZONE_ROOT
  else process.env.SLAYZONE_ROOT = prevRoot
  // Every denied-read case restores its mode, so the trees are removable.
  for (const b of bases) rmSync(b, { recursive: true, force: true })
})

// --- 0-byte legacy DB: not a database, nothing to import; boot must not crash ----------
describe('0-byte legacy DB: not a database, nothing to import; boot must not crash', () => {
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
  test('0-byte legacy DB does not throw', () => {
    expect(threw, threw).toBe('')
  })
  test('0-byte legacy DB is not planted as the new DB', () => {
    expect(existsSync(join(storage, 'slayzone.data.sqlite'))).toBe(false)
  })
  test('content still imported past a 0-byte DB', () => {
    expect(existsSync(join(storage, 'blobs', 'ab', 'cd'))).toBe(true)
  })
  test('sentinel written (nothing left to retry)', () => {
    expect(existsSync(join(storage, SENTINEL))).toBe(true)
  })
})

// --- dangling symlink in artifacts/: copied as a link, never fatal, never a retry loop ---
describe('dangling symlink in artifacts/: copied as a link, never fatal, never a retry loop', () => {
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
  test('dangling symlink does not throw', () => {
    expect(threw, threw).toBe('')
  })
  test('sibling files still copied', () => {
    expect(readFileSync(join(storage, 'artifacts', 't1', 'a.md'), 'utf8')).toBe('ART')
  })
  test('DB copied', () => {
    expect(readFileSync(join(storage, 'slayzone.data.sqlite'), 'utf8')).toBe('PRODDB')
  })
  test('sentinel written (a dangling link is not an incomplete copy)', () => {
    expect(existsSync(join(storage, SENTINEL))).toBe(true)
  })
})

// --- unreadable content file: skipped, NOT fatal, sentinel withheld, next boot heals ----
describe.runIf(canDenyRead)(
  'unreadable content file: skipped, NOT fatal, sentinel withheld, next boot heals',
  () => {
    let old: string
    let storage: string
    let threw = ''
    let report: { complete: boolean; skipped: string[] } | undefined
    beforeAll(() => {
      ;({ old, storage } = setup())
      writeFileSync(join(old, 'slayzone.sqlite'), 'PRODDB')
      mkdirSync(join(old, 'blobs', 'ab'), { recursive: true })
      writeFileSync(join(old, 'blobs', 'ab', 'good'), 'GOOD')
      writeFileSync(join(old, 'blobs', 'ab', 'locked'), 'LOCKED')
      chmodSync(join(old, 'blobs', 'ab', 'locked'), 0o000)
      try {
        report = ensureStorageDir(old, storage, true) as typeof report
      } catch (e) {
        threw = String(e)
      }
    })
    // Restores the mode even if a test below fails first, so the tree is removable.
    afterAll(() => chmodSync(join(old, 'blobs', 'ab', 'locked'), 0o644))

    test('unreadable blob does not abort boot', () => {
      expect(threw, threw).toBe('')
    })
    test('the readable files and the DB still crossed over', () => {
      expect(existsSync(join(storage, 'blobs', 'ab', 'good'))).toBe(true)
      expect(existsSync(join(storage, 'slayzone.data.sqlite'))).toBe(true)
    })
    test('sentinel withheld so the next boot retries', () => {
      expect(existsSync(join(storage, SENTINEL))).toBe(false)
    })
    test('report says incomplete and names the skipped file', () => {
      expect(report?.complete, JSON.stringify(report)).toBe(false)
      expect(report?.skipped ?? []).toContainEqual(expect.stringMatching(/locked$/))
    })
    // Next boot, file readable again → heals and blesses.
    let again: { complete: boolean } | undefined
    test('retry copies the file once readable', () => {
      chmodSync(join(old, 'blobs', 'ab', 'locked'), 0o644)
      again = ensureStorageDir(old, storage, true) as { complete: boolean }
      expect(readFileSync(join(storage, 'blobs', 'ab', 'locked'), 'utf8')).toBe('LOCKED')
    })
    test('retry writes the sentinel', () => {
      expect(again?.complete).toBe(true)
      expect(existsSync(join(storage, SENTINEL))).toBe(true)
    })
  }
)

// --- DB copy fails: FATAL, names the source path, leaves NOTHING at the final name -------
describe.runIf(canDenyRead)(
  'DB copy fails: FATAL, names the source path, leaves NOTHING at the final name',
  () => {
    let old: string
    let storage: string
    let err: unknown
    beforeAll(() => {
      ;({ old, storage } = setup())
      writeFileSync(join(old, 'slayzone.sqlite'), 'PRODDB')
      writeFileSync(join(old, 'slayzone.sqlite-wal'), 'WALBYTES')
      chmodSync(join(old, 'slayzone.sqlite'), 0o000)
      try {
        ensureStorageDir(old, storage, true)
      } catch (e) {
        err = e
      }
    })
    // Restores the mode even if a test below fails first, so the tree is removable.
    afterAll(() => chmodSync(join(old, 'slayzone.sqlite'), 0o644))

    test('DB copy failure throws a StorageImportError', () => {
      expect(err, String(err)).toBeInstanceOf(StorageImportError)
    })
    test('error names the file that failed', () => {
      expect(err, String(err)).toBeInstanceOf(StorageImportError)
      expect((err as StorageImportError).path).toMatch(/slayzone\.sqlite$/)
    })
    test('no main DB at the final name', () => {
      expect(existsSync(join(storage, 'slayzone.data.sqlite'))).toBe(false)
    })
    test('no stray -wal beside a missing main (a foreign WAL replays into a fresh DB)', () => {
      expect(readdirSync(storage)).not.toContain('slayzone.data.sqlite-wal')
    })
    test('no sentinel', () => {
      expect(existsSync(join(storage, SENTINEL))).toBe(false)
    })
    test('source untouched', () => {
      expect(readFileSync(join(old, 'slayzone.sqlite-wal'), 'utf8')).toBe('WALBYTES')
    })
    test('retry after the cause is fixed imports the DB', () => {
      chmodSync(join(old, 'slayzone.sqlite'), 0o644)
      ensureStorageDir(old, storage, true)
      expect(readFileSync(join(storage, 'slayzone.data.sqlite'), 'utf8')).toBe('PRODDB')
    })
  }
)

// --- a crashed earlier attempt left temp files: they never block, never survive ----------
describe('a crashed earlier attempt left temp files: they never block, never survive', () => {
  const { old, storage } = setup()
  writeFileSync(join(old, 'slayzone.sqlite'), 'PRODDB')
  mkdirSync(storage, { recursive: true })
  // Stale leftovers of an interrupted import, in every shape the importer could leave.
  writeFileSync(join(storage, 'slayzone.data.sqlite.importing'), 'HALF')
  writeFileSync(join(storage, 'slayzone.data.sqlite-wal.importing'), 'HALF')
  ensureStorageDir(old, storage, true)
  test('stale temp does not block the import', () => {
    expect(readFileSync(join(storage, 'slayzone.data.sqlite'), 'utf8')).toBe('PRODDB')
  })
  test('no importing temp files remain', () => {
    expect(readdirSync(storage).filter((f) => f.endsWith('.importing'))).toEqual([])
  })
})

// --- wal travels with the DB, and a quiescent copy is byte-identical ---------------------
describe('wal travels with the DB, and a quiescent copy is byte-identical', () => {
  const { old, storage } = setup()
  writeFileSync(join(old, 'slayzone.sqlite'), 'MAIN-BYTES')
  writeFileSync(join(old, 'slayzone.sqlite-wal'), 'WAL-BYTES')
  writeFileSync(join(old, 'slayzone.sqlite-shm'), 'SHM-BYTES')
  ensureStorageDir(old, storage, true)
  test('main/wal/shm all land under the new name', () => {
    expect(readFileSync(join(storage, 'slayzone.data.sqlite'), 'utf8')).toBe('MAIN-BYTES')
    expect(readFileSync(join(storage, 'slayzone.data.sqlite-wal'), 'utf8')).toBe('WAL-BYTES')
    expect(readFileSync(join(storage, 'slayzone.data.sqlite-shm'), 'utf8')).toBe('SHM-BYTES')
  })
})
