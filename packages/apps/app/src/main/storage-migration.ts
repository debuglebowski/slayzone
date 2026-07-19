import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * One-time migration of the app's SQLite DB + artifacts into `<ROOT>/storage`.
 *
 * Historically the desktop app kept its state in Electron's userData
 * (`~/Library/Application Support/slayzone`), separate from `<ROOT>` (`~/.slayzone`,
 * config + hooks). We now nest state under `<ROOT>/storage` so the layout is the
 * same on every machine. Electron's OWN profile data (Partitions, Cache, IndexedDB,
 * Local Storage, Cookies, …) MUST stay in userData — Electron owns that dir — so
 * this is a selective extract of the files WE created, not a whole-dir move.
 *
 * Scope (explicit — NOT a glob, so diagnostics/chromium/hub-auth are left):
 *   - slayzone.sqlite      (+ -wal, -shm)
 *   - slayzone.dev.sqlite  (+ -wal, -shm)
 *   - blobs/     — artifact CONTENT (content-addressed; the DB only stores hashes)
 *   - artifacts/ — artifact working-copy cache
 *   - backups/ — the 2 MOST RECENT backup files only (older ones stay behind)
 *
 * Safety: copy → (main-db present) → delete originals. The source is untouched
 * until its copy completes, so a crash mid-migration never loses data — the next
 * boot re-runs (idempotent: a DB already present in `<storage>` is skipped, never
 * clobbered). The main `.sqlite` is copied LAST so its presence means the whole
 * triplet copied; `-wal`/`-shm` carry un-checkpointed commits and move with it.
 */

/** DB basenames to migrate; each with its `-wal`/`-shm` sidecars (when present). */
const DB_BASENAMES = ['slayzone.sqlite', 'slayzone.dev.sqlite'] as const

function copyFileIfPresent(src: string, dst: string): void {
  if (existsSync(src)) cpSync(src, dst)
}

function removeIfPresent(p: string): void {
  rmSync(p, { force: true })
}

/** Migrate one DB triplet (main + wal + shm) old→new, copy-verify-delete. */
function migrateDb(oldDir: string, newDir: string, base: string): void {
  const srcMain = join(oldDir, base)
  const dstMain = join(newDir, base)
  // Nothing to move, or already migrated (never clobber an existing target).
  if (!existsSync(srcMain) || existsSync(dstMain)) return

  // Copy sidecars FIRST, main LAST — dstMain's existence then means "complete".
  copyFileIfPresent(`${srcMain}-wal`, `${dstMain}-wal`)
  copyFileIfPresent(`${srcMain}-shm`, `${dstMain}-shm`)
  cpSync(srcMain, dstMain)

  // Verify the main copy is non-empty before deleting the source.
  if (!existsSync(dstMain) || statSync(dstMain).size === 0) {
    throw new Error(`[storage-migration] copy of ${base} failed verification; leaving source intact`)
  }

  removeIfPresent(`${srcMain}-wal`)
  removeIfPresent(`${srcMain}-shm`)
  removeIfPresent(srcMain)
}

/** Migrate one content dir old→new (recursive copy-verify-delete), once. */
function migrateContentDir(oldDir: string, newDir: string, name: string): void {
  const src = join(oldDir, name)
  const dst = join(newDir, name)
  if (!existsSync(src) || existsSync(dst)) return
  cpSync(src, dst, { recursive: true })
  if (!existsSync(dst)) {
    throw new Error(`[storage-migration] ${name}/ copy failed verification; leaving source intact`)
  }
  rmSync(src, { recursive: true, force: true })
}

/**
 * Migrate the 2 most-recent backup files into `<newDir>/backups`. Backup names are
 * `slayzone[.dev].<ISO-timestamp>.<kind>.sqlite`, so the timestamp sorts lexically
 * → the last 2 `.sqlite` entries are newest. Each moves with its `-wal`/`-shm`.
 * Older backups are intentionally left behind in the old dir.
 */
function migrateRecentBackups(oldDir: string, newDir: string): void {
  const srcBackups = join(oldDir, 'backups')
  if (!existsSync(srcBackups)) return
  const dstBackups = join(newDir, 'backups')

  const recent = readdirSync(srcBackups)
    .filter((f) => f.endsWith('.sqlite'))
    .sort()
    .slice(-2)
  if (recent.length === 0) return

  mkdirSync(dstBackups, { recursive: true })
  for (const name of recent) {
    const src = join(srcBackups, name)
    const dst = join(dstBackups, name)
    if (existsSync(dst)) continue // already migrated — never clobber
    copyFileIfPresent(`${src}-wal`, `${dst}-wal`)
    copyFileIfPresent(`${src}-shm`, `${dst}-shm`)
    cpSync(src, dst)
    if (!existsSync(dst) || statSync(dst).size === 0) {
      throw new Error(`[storage-migration] backup copy of ${name} failed verification`)
    }
    removeIfPresent(`${src}-wal`)
    removeIfPresent(`${src}-shm`)
    removeIfPresent(src)
  }
}

/**
 * Migrate the DB + artifacts + blobs + recent backups from `oldDir` (the legacy
 * userData location) into `storageDir` (`<ROOT>/storage`, resolved by the caller
 * via the shared platform derivation) if needed. Idempotent; never throws for an
 * empty source, only if a copy half-completes (source kept intact).
 *
 * NB: `blobs/` holds the actual artifact CONTENT (content-addressed by hash — the
 * DB only stores hashes; `artifacts/` is just a working-copy cache). Omitting it
 * strands every artifact's content, so it MUST migrate alongside the DB.
 */
export function ensureStorageDir(oldDir: string, storageDir: string): void {
  mkdirSync(storageDir, { recursive: true })
  // A no-op when oldDir === storageDir (already anchored) or nothing to move.
  if (oldDir !== storageDir) {
    for (const base of DB_BASENAMES) migrateDb(oldDir, storageDir, base)
    migrateContentDir(oldDir, storageDir, 'blobs')
    migrateContentDir(oldDir, storageDir, 'artifacts')
    migrateRecentBackups(oldDir, storageDir)
  }
}
