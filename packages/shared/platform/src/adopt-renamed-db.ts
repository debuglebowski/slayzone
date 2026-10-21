import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Rename a SQLite database file, and the files SQLite keeps beside it, in place.
 *
 * Used when a database is renamed between releases (`slayzone.sqlite` →
 * `slayzone.data.sqlite`, `hub-auth.sqlite` → `slayzone.auth.sqlite`). The file is the
 * user's data or credentials, so this is deliberately small and conservative:
 *
 *  - PURE fs, no SQLite handle. The `-wal` is the part that matters: committed rows
 *    can live ONLY there after an unclean shutdown, and SQLite pairs a WAL with its
 *    database by FILENAME. So the sidecars move with the main file, never alone.
 *  - A target that already exists WINS and nothing is touched. The new name is the
 *    one in use; a leftover old file is stale, never merged and never deleted.
 *  - Same directory, so each `rename` is atomic. Sidecars move FIRST and the main file
 *    LAST: a crash in between leaves `old main + new-named sidecars`, which the next
 *    call completes (the per-suffix existence checks make the retry safe), whereas the
 *    reverse order would strand the WAL and silently lose its rows.
 *  - An ambiguous state THROWS instead of guessing. If a sidecar exists under BOTH
 *    names while the new main file is absent, opening the new name would pair a stale
 *    WAL with an empty database. Failing loudly is the lesser harm.
 *
 * The caller must be the only process using the file. Both call sites are: the desktop
 * app main runs it before it spawns the hub, and the hub runs it before it opens the
 * database.
 */
const SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const

export type AdoptRenamedDbResult = 'renamed' | 'no-source' | 'target-exists'

export function adoptRenamedDatabase(
  dir: string,
  oldBase: string,
  newBase: string
): AdoptRenamedDbResult {
  const oldMain = join(dir, oldBase)
  const newMain = join(dir, newBase)
  if (existsSync(newMain)) return 'target-exists'
  if (!existsSync(oldMain)) return 'no-source'

  // Validate the whole move before making any of it.
  for (const suffix of SIDECAR_SUFFIXES) {
    if (existsSync(oldMain + suffix) && existsSync(newMain + suffix)) {
      throw new Error(
        `[adoptRenamedDatabase] cannot rename ${oldBase} to ${newBase}: both ` +
          `${oldBase}${suffix} and ${newBase}${suffix} exist in ${dir} and ${newBase} does not. ` +
          `Refusing to guess which holds the live data; nothing was moved.`
      )
    }
  }

  for (const suffix of SIDECAR_SUFFIXES) {
    if (existsSync(oldMain + suffix)) renameSync(oldMain + suffix, newMain + suffix)
  }
  renameSync(oldMain, newMain)
  return 'renamed'
}
