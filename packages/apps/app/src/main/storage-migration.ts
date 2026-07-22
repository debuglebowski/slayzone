import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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
 *   - <channel DB>       (+ -wal, -shm)   — slayzone.sqlite | slayzone.dev.sqlite
 *   - blobs/     — artifact CONTENT (content-addressed; the DB only stores hashes)
 *   - artifacts/ — artifact working-copy cache
 *   - backups/ — the 2 MOST RECENT backups of THIS channel (older ones stay behind)
 */

/** Channel → DB basename + backup filename prefix. Mirrors platform getDbName(). */
function channelDbBasename(packaged: boolean): string {
  return packaged ? 'slayzone.sqlite' : 'slayzone.dev.sqlite'
}
function channelBackupPrefix(packaged: boolean): string {
  return packaged ? 'slayzone' : 'slayzone.dev'
}

/** Per-channel completion sentinel path under `<storage>`. */
function sentinelPath(storageDir: string, packaged: boolean): string {
  return join(storageDir, `.storage-migrated.${packaged ? 'prod' : 'dev'}`)
}

function copyFileIfPresent(src: string, dst: string): void {
  if (existsSync(src)) cpSync(src, dst)
}

/**
 * Copy one DB triplet (main + wal + shm) old→new. COPY-ONLY — source untouched.
 * Skips when the source is absent or the target already exists (never clobber a DB
 * the app may already be using). Sidecars copied FIRST, main LAST so the main
 * file's presence signals a complete triplet.
 */
function copyDb(oldDir: string, newDir: string, base: string): void {
  const srcMain = join(oldDir, base)
  const dstMain = join(newDir, base)
  if (!existsSync(srcMain) || existsSync(dstMain)) return

  copyFileIfPresent(`${srcMain}-wal`, `${dstMain}-wal`)
  copyFileIfPresent(`${srcMain}-shm`, `${dstMain}-shm`)
  cpSync(srcMain, dstMain)

  if (!existsSync(dstMain) || statSync(dstMain).size === 0) {
    throw new Error(`[storage-migration] copy of ${base} failed verification`)
  }
}

/**
 * Recursively copy every file under `src` into `dst`, creating dirs as needed and
 * copying ONLY files absent from `dst`. Files already present in `dst` are the
 * current (authoritative) copies and are left untouched — blobs are immutable by
 * content hash, so a same-path collision is a stale legacy dupe, not a conflict.
 * COPY-ONLY: the source tree is never modified. Returns true iff every source file
 * now has a counterpart in `dst`.
 */
function mergeMissingFiles(src: string, dst: string): boolean {
  mkdirSync(dst, { recursive: true })
  let complete = true
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name)
    const d = join(dst, entry.name)
    if (entry.isDirectory()) {
      if (!mergeMissingFiles(s, d)) complete = false
    } else if (existsSync(d)) {
      // Dest wins (current copy); source is a stale dupe. Counted as present.
    } else {
      cpSync(s, d)
      if (!existsSync(d)) complete = false
    }
  }
  return complete
}

/**
 * Copy one content dir (blobs/ or artifacts/) old→new by MERGING missing files.
 * COPY-ONLY. Heals the case where the running (post-refactor) app already created
 * `<storage>/{blobs,artifacts}` and wrote NEW content there while legacy files
 * still sit in `oldDir` — those legacy files still cross over, or their artifacts
 * render blank (DB row in the migrated DB, content stranded in the legacy dir).
 */
function copyContentDir(oldDir: string, newDir: string, name: string): void {
  const src = join(oldDir, name)
  if (!existsSync(src)) return
  const dst = join(newDir, name)
  if (!mergeMissingFiles(src, dst)) {
    throw new Error(`[storage-migration] ${name}/ merge incomplete`)
  }
}

/**
 * Copy the 2 most-recent backups OF THIS CHANNEL into `<newDir>/backups`. Backup
 * names are `<prefix>.<ISO-timestamp>.<kind>.sqlite`, so the timestamp sorts
 * lexically → the last 2 entries for this channel's prefix are newest. Each copies
 * with its `-wal`/`-shm`. COPY-ONLY; older backups + the other channel's backups
 * stay behind untouched.
 */
function copyRecentBackups(oldDir: string, newDir: string, packaged: boolean): void {
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
    const src = join(srcBackups, name)
    const dst = join(dstBackups, name)
    if (existsSync(dst)) continue // already migrated — never clobber
    copyFileIfPresent(`${src}-wal`, `${dst}-wal`)
    copyFileIfPresent(`${src}-shm`, `${dst}-shm`)
    cpSync(src, dst)
    if (!existsSync(dst) || statSync(dst).size === 0) {
      throw new Error(`[storage-migration] backup copy of ${name} failed verification`)
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
export function ensureStorageDir(oldDir: string, storageDir: string, packaged: boolean): void {
  mkdirSync(storageDir, { recursive: true })
  if (oldDir === storageDir) return // already anchored — nothing to copy

  const sentinel = sentinelPath(storageDir, packaged)
  if (existsSync(sentinel)) return // this channel already migrated — do not re-scan the shared dir

  copyDb(oldDir, storageDir, channelDbBasename(packaged))
  copyContentDir(oldDir, storageDir, 'blobs')
  copyContentDir(oldDir, storageDir, 'artifacts')
  copyRecentBackups(oldDir, storageDir, packaged)

  // Mark this channel done so future boots skip the (shared, peer-owned) legacy dir.
  writeFileSync(sentinel, new Date().toISOString())
}
