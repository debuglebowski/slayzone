import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDbName, getLegacyDbName } from '@slayzone/platform'
import { copyDbTriplet, mergeMissingFiles, StorageImportError } from './copy-utils'

/** What a run of {@link ensureStorageDir} left undone. `complete` is false iff something
 *  was skipped; the sentinel is withheld then, so the next boot retries just that. */
export interface StorageMigrationReport {
  complete: boolean
  /** Source paths that could not be copied (unreadable file, full disk, ...). */
  skipped: string[]
}

/**
 * One-time COPY of the app's SQLite DB + artifacts + blobs + recent backups from
 * the legacy Electron userData dir into `<ROOT>/storage`.
 *
 * Historically the desktop app kept its state in Electron's userData
 * (`~/Library/Application Support/slayzone`), separate from `<ROOT>` (`~/.slayzone`,
 * config + hooks). We now nest state under `<ROOT>/storage` so the layout is the
 * same on every machine. Electron's OWN profile data (Partitions, Cache, IndexedDB,
 * Local Storage, Cookies, …) stays in userData — Electron owns that dir — so this
 * is a selective COPY of the files WE created, not a whole-dir move.
 *
 * ── The legacy dir is treated as STRICTLY READ-ONLY. ────────────────────────────
 * We copy OUT and NEVER delete, rename, or move the source. Reason: that userData
 * dir (`app.name='slayzone'`) is SHARED with a still-installed PRE-REFACTOR prod
 * app that lives entirely there. An earlier copy-then-DELETE version of this
 * migration — run by the dev build against that shared dir — deleted prod's live
 * `slayzone.sqlite` (→ ghost inode) and prod's `artifacts/` working files. Copying
 * is safe (content-addressed blobs dedupe; DB copy is idempotent); deleting another
 * app's data is not. So: no `rmSync`/`unlink`/`rename` on `oldDir`, ever.
 *
 * ── Channel-scoped. ──────────────────────────────────────────────────────────────
 * `packaged` selects the ONE DB basename + backup prefix this channel owns
 * (`getDbName`/prefix): the packaged prod app migrates `slayzone.sqlite`; a dev
 * build migrates `slayzone.dev.sqlite`. Neither reads or copies the other's DB, so
 * the dev app can never act on prod's database (or vice-versa).
 *
 * ── Genuinely one-time. ──────────────────────────────────────────────────────────
 * A per-channel sentinel file under `<storage>` records completion. Once set, boots
 * skip the whole pass — so the running peer app can add new files to the shared dir
 * afterward without this migration re-scanning (and partially re-copying) it.
 *
 * Scope (explicit — NOT a glob, so diagnostics/chromium/hub-auth are left):
 *   - <channel DB>       (+ -wal, -shm)   — copied FROM slayzone.sqlite | slayzone.dev.sqlite
 *                                          TO slayzone.data.sqlite | slayzone.dev.data.sqlite
 *   - blobs/     — artifact CONTENT (content-addressed; the DB only stores hashes)
 *   - artifacts/ — artifact working-copy cache
 *   - backups/ — the 2 MOST RECENT backups of THIS channel (older ones stay behind)
 */

/** Channel → backup filename prefix. The legacy SOURCE's DB keeps the pre-rename name
 *  (`getLegacyDbName`); the copy lands under the renamed one (`getDbName`). Backups in
 *  the source are named from the old DB name, so the prefix stays the old one too. */
function channelBackupPrefix(packaged: boolean): string {
  return packaged ? 'slayzone' : 'slayzone.dev'
}

/** Per-channel completion sentinel path under `<storage>`. */
function sentinelPath(storageDir: string, packaged: boolean): string {
  return join(storageDir, `.storage-migrated.${packaged ? 'prod' : 'dev'}`)
}

/**
 * Copy one content dir (blobs/ or artifacts/) old→new by MERGING missing files.
 * COPY-ONLY. Heals the case where the running (post-refactor) app already created
 * `<storage>/{blobs,artifacts}` and wrote NEW content there while legacy files
 * still sit in `oldDir` — those legacy files still cross over, or their artifacts
 * render blank (DB row in the migrated DB, content stranded in the legacy dir).
 */
function copyContentDir(
  oldDir: string,
  newDir: string,
  name: string,
  skip: (path: string, err: unknown) => void
): void {
  const src = join(oldDir, name)
  if (!existsSync(src)) return
  mergeMissingFiles(src, join(newDir, name), skip)
}

/**
 * Copy the 2 most-recent backups OF THIS CHANNEL into `<newDir>/backups`. Backup
 * names are `<prefix>.<ISO-timestamp>.<kind>.sqlite`, so the timestamp sorts
 * lexically → the last 2 entries for this channel's prefix are newest. Each copies
 * with its `-wal`/`-shm`. COPY-ONLY; older backups + the other channel's backups
 * stay behind untouched.
 */
function copyRecentBackups(
  oldDir: string,
  newDir: string,
  packaged: boolean,
  skip: (path: string, err: unknown) => void
): void {
  const srcBackups = join(oldDir, 'backups')
  if (!existsSync(srcBackups)) return
  const dstBackups = join(newDir, 'backups')
  const prefix = channelBackupPrefix(packaged)
  // Dev prefix `slayzone.dev` is also a prefix of prod names, so match on the exact
  // `<prefix>.<timestamp>` shape: prod = `slayzone.NNNN-`, dev = `slayzone.dev.NNNN-`.
  const re = new RegExp(`^${prefix.replace('.', '\\.')}\\.\\d{4}-.*\\.sqlite$`)

  const recent = readdirSync(srcBackups)
    .filter((f) => re.test(f))
    .sort()
    .slice(-2)
  if (recent.length === 0) return

  mkdirSync(dstBackups, { recursive: true })
  for (const name of recent) {
    // A backup is a DB triplet like any other (atomic, size-verified, skips an existing
    // destination). It is a convenience copy, not the user's live data, so one that
    // cannot be copied is skipped and retried next boot instead of stopping the app.
    try {
      copyDbTriplet(srcBackups, dstBackups, name)
    } catch (err) {
      skip(err instanceof StorageImportError ? err.path : join(srcBackups, name), err)
    }
  }
}

/**
 * COPY (never move) this channel's DB + artifacts + blobs + recent backups from
 * `oldDir` (legacy userData) into `storageDir` (`<ROOT>/storage`). Idempotent and
 * genuinely one-time via a per-channel sentinel. `packaged` selects the channel:
 * true = prod (`slayzone.sqlite`), false = dev (`slayzone.dev.sqlite`).
 *
 * The legacy dir is READ-ONLY here — a still-installed pre-refactor app of the
 * OTHER channel may be actively using it. See file header.
 */
export function ensureStorageDir(
  oldDir: string,
  storageDir: string,
  packaged: boolean
): StorageMigrationReport {
  mkdirSync(storageDir, { recursive: true })
  const skipped: string[] = []
  if (oldDir === storageDir) return { complete: true, skipped } // already anchored — nothing to copy

  const sentinel = sentinelPath(storageDir, packaged)
  if (existsSync(sentinel)) return { complete: true, skipped } // this channel already migrated — do not re-scan the shared dir

  // The database FIRST, and its failure is FATAL (throws StorageImportError, naming the
  // file). Everything below is retried on the next boot; this cannot be, because once
  // the hub has created an empty database at the new name, "destination exists" hides
  // the real one for good.
  copyDbTriplet(oldDir, storageDir, getLegacyDbName(packaged), getDbName(packaged))

  const skip = (path: string, err: unknown): void => {
    skipped.push(path)
    console.error(
      `[storage-migration] skipped ${path}: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  copyContentDir(oldDir, storageDir, 'blobs', skip)
  copyContentDir(oldDir, storageDir, 'artifacts', skip)
  copyRecentBackups(oldDir, storageDir, packaged, skip)

  // Mark this channel done so future boots skip the (shared, peer-owned) legacy dir —
  // but only when nothing was skipped, so a transient failure heals on the next boot.
  if (skipped.length === 0) writeFileSync(sentinel, new Date().toISOString())
  return { complete: skipped.length === 0, skipped }
}
