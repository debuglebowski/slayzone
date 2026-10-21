import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync
} from 'node:fs'
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
 *
 * The second invariant, added after the data-safety audit: a COPY IS ATOMIC. "The
 * destination exists" is how every migration decides "this is already done", so a
 * half-written file at the final name is accepted forever. Everything here therefore
 * writes to `<name>.importing` and renames into place only once the bytes are all
 * there; an interrupted run leaves a temp file that the next run overwrites, never a
 * truncated file that gets blessed.
 */

/** Suffix of an in-progress copy. Never the name anything else looks for. */
const IMPORTING = '.importing'

/**
 * The database import failed. Carries the file that could not be read or written so
 * the app can NAME it in a dialog. This is the one failure a boot must not step over:
 * continuing would let the hub create an empty database beside the real one, after
 * which "destination exists" makes the real data permanently invisible.
 */
export class StorageImportError extends Error {
  readonly path: string
  constructor(message: string, path: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'StorageImportError'
    this.path = path
  }
}

/** lstat, not exists: a dangling symlink IS an entry (it just has nothing behind it). */
function entryExists(p: string): boolean {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

export function copyFileIfPresent(src: string, dst: string): void {
  if (existsSync(src)) cpSync(src, dst)
}

/** Copy bytes to `dst` and fail unless every byte arrived. Follows symlinks: a database
 *  file that is a link must be imported as data, not as a second link to the original. */
function copyVerified(src: string, dst: string): void {
  cpSync(src, dst, { dereference: true })
  const want = statSync(src).size
  const got = statSync(dst).size
  if (got !== want) throw new Error(`copied ${got} of ${want} bytes`)
}

const SIDECARS = ['-wal', '-shm'] as const

/**
 * Copy one DB triplet (main + wal + shm) old→new. COPY-ONLY — source untouched.
 * Skips when the source is absent or empty, or the target already exists (never
 * clobber a DB the app may already be using).
 *
 * ATOMIC and ORDERED. Every file is copied to a `.importing` temp and size-verified
 * first; only then are the sidecars moved into place and the MAIN FILE LAST, so the
 * main file's presence at its final name signals a complete triplet. A failure removes
 * every temp and every sidecar it placed, so nothing is left at the final name — a
 * stray `-wal` beside a missing main would replay a foreign WAL into the fresh database
 * the hub then creates there. Any failure throws {@link StorageImportError} naming the
 * file at fault.
 *
 * A 0-byte main is not a database (SQLite writes its header on first use): there is
 * nothing to import, and the hub creates a fresh one.
 */
export function copyDbTriplet(
  oldDir: string,
  newDir: string,
  base: string,
  dstBase: string = base
): void {
  // `dstBase` differs from `base` when the file was renamed between releases (the
  // legacy source keeps its old name, the copy lands under the new one).
  const srcMain = join(oldDir, base)
  const dstMain = join(newDir, dstBase)
  if (!existsSync(srcMain) || existsSync(dstMain)) return
  if (statSync(srcMain).size === 0) return

  let current = srcMain
  const temps: string[] = []
  const placed: string[] = []
  try {
    mkdirSync(newDir, { recursive: true })
    for (const s of ['', ...SIDECARS]) rmSync(`${dstMain}${s}${IMPORTING}`, { force: true })

    const present = SIDECARS.filter((s) => existsSync(`${srcMain}${s}`))
    for (const s of present) {
      current = `${srcMain}${s}`
      temps.push(`${dstMain}${s}${IMPORTING}`)
      copyVerified(current, `${dstMain}${s}${IMPORTING}`)
    }
    current = srcMain
    temps.push(`${dstMain}${IMPORTING}`)
    copyVerified(srcMain, `${dstMain}${IMPORTING}`)

    // Commit. The main file is absent at the destination (checked above), so any
    // sidecar there is an orphan of some earlier attempt and would pair with the wrong
    // database: clear them, then move ours in, main last.
    current = dstMain
    for (const s of SIDECARS) rmSync(`${dstMain}${s}`, { force: true })
    for (const s of present) {
      renameSync(`${dstMain}${s}${IMPORTING}`, `${dstMain}${s}`)
      placed.push(`${dstMain}${s}`)
    }
    renameSync(`${dstMain}${IMPORTING}`, dstMain)
  } catch (err) {
    for (const p of [...temps, ...placed]) rmSync(p, { force: true })
    const reason = err instanceof Error ? err.message : String(err)
    throw new StorageImportError(`could not copy ${current}: ${reason}`, current, err)
  }
}

/**
 * Recursively copy every file under `src` into `dst`, creating dirs as needed and
 * copying ONLY files absent from `dst`. Files already present in `dst` are the
 * current (authoritative) copies and are left untouched — content-addressed blobs
 * are immutable, so a same-path collision is a stale legacy dupe, not a conflict.
 * COPY-ONLY: the source tree is never modified.
 *
 * One bad entry never stops the rest: a file that cannot be read or written is
 * reported through `onSkip` and the walk goes on. Returns true iff every source entry
 * now has a counterpart in `dst` (so false ⇔ `onSkip` was called). Each file lands via
 * a temp name + rename, so an interrupted copy can never leave a truncated file under
 * its final name. A symlink is recreated as a symlink; a dangling one still counts as
 * present — it is the entry, and there is nothing behind it to lose.
 */
export function mergeMissingFiles(
  src: string,
  dst: string,
  onSkip: (path: string, err: unknown) => void = (path, err) =>
    console.error(
      `[copy-utils] skipped ${path}: ${err instanceof Error ? err.message : String(err)}`
    )
): boolean {
  let complete = true
  const skip = (path: string, err: unknown): void => {
    complete = false
    onSkip(path, err)
  }
  try {
    mkdirSync(dst, { recursive: true })
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      const s = join(src, entry.name)
      const d = join(dst, entry.name)
      if (entry.isDirectory()) {
        if (!mergeMissingFiles(s, d, onSkip)) complete = false
      } else if (entryExists(d)) {
        // Dest wins (current copy); source is a stale dupe. Counted as present.
      } else {
        const tmp = `${d}${IMPORTING}`
        try {
          rmSync(tmp, { force: true })
          if (entry.isSymbolicLink()) {
            // Recreated from its text, not via cpSync (which stats the target and so
            // throws on a dangling link). Verbatim: a link inside the tree keeps
            // pointing at its sibling in the new tree.
            symlinkSync(readlinkSync(s), tmp)
          } else {
            cpSync(s, tmp)
            if (statSync(tmp).size !== statSync(s).size) {
              throw new Error('copy is shorter than its source')
            }
          }
          renameSync(tmp, d)
        } catch (err) {
          rmSync(tmp, { force: true })
          skip(s, err)
        }
      }
    }
  } catch (err) {
    // The directory itself could not be listed or created.
    skip(src, err)
  }
  return complete
}
