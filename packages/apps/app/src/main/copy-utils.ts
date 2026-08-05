import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Generic COPY-ONLY primitives shared by every "migrate old state into a new
 * location" module in this app (`storage-migration.ts`, `channel-storage-
 * migration.ts`). Kept in one small file so the one invariant that matters —
 * never delete/rename/move the source — is defined once and reused, not
 * reimplemented per migration. See `storage-migration.ts`'s file header for
 * the incident that made this invariant non-negotiable: an earlier
 * copy-then-DELETE migration deleted a live production database because its
 * source directory was still being written by a different, still-running
 * process. Every migration built on these primitives inherits that safety by
 * construction — none of them ever calls `rm`/`rename`/`unlink` on a source.
 */

export function copyFileIfPresent(src: string, dst: string): void {
  if (existsSync(src)) cpSync(src, dst)
}

/**
 * Copy one DB triplet (main + wal + shm) old→new. COPY-ONLY — source untouched.
 * Skips when the source is absent or the target already exists (never clobber a DB
 * the app may already be using). Sidecars copied FIRST, main LAST so the main
 * file's presence signals a complete triplet. Verifies the copy actually landed
 * and isn't empty before returning — a silent partial copy is worse than skipping.
 */
export function copyDbTriplet(oldDir: string, newDir: string, base: string): void {
  const srcMain = join(oldDir, base)
  const dstMain = join(newDir, base)
  if (!existsSync(srcMain) || existsSync(dstMain)) return

  copyFileIfPresent(`${srcMain}-wal`, `${dstMain}-wal`)
  copyFileIfPresent(`${srcMain}-shm`, `${dstMain}-shm`)
  cpSync(srcMain, dstMain)

  if (!existsSync(dstMain) || statSync(dstMain).size === 0) {
    throw new Error(`[copy-utils] copy of ${base} failed verification`)
  }
}

/**
 * Recursively copy every file under `src` into `dst`, creating dirs as needed and
 * copying ONLY files absent from `dst`. Files already present in `dst` are the
 * current (authoritative) copies and are left untouched — content-addressed blobs
 * are immutable, so a same-path collision is a stale legacy dupe, not a conflict.
 * COPY-ONLY: the source tree is never modified. Returns true iff every source file
 * now has a counterpart in `dst`.
 */
export function mergeMissingFiles(src: string, dst: string): boolean {
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
