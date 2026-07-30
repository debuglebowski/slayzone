/**
 * Retention for payload blobs written by `payload-blobs.ts`.
 *
 * The event-row retention in `retention.ts` prunes `diagnostics_events` by age and
 * a hard row cap. It knows nothing about files on disk — so offloading screenshots
 * to `<storage>/diagnostics/` (which is what made them usable at all; see
 * `payload-blobs.ts`) introduced an unbounded leak: the row referencing a blob is
 * deleted after `retentionDays`, and the blob itself stays forever. Measured on a
 * real diagnostics DB: 32 canary downgrades in 7 days at 175-390 KB each, so
 * roughly 10 MB/week that nothing ever reclaimed.
 *
 * Two independent bounds, because either alone fails:
 *   - AGE, sharing `retentionDays` with the rows. Past the cutoff a blob is
 *     unreferenced by construction, so keeping it is pure waste.
 *   - TOTAL SIZE, oldest-first. Age alone is unbounded in the burst case — a
 *     GPU-driver fault that fires the canary hundreds of times in an hour writes
 *     hundreds of megabytes that are all "recent".
 *
 * The filesystem is injected so the policy is unit-testable without touching disk.
 */

/** One blob file as the pruner needs to see it. */
export interface BlobFileInfo {
  name: string
  sizeBytes: number
  mtimeMs: number
}

export interface BlobFileSystem {
  /** Blob files present, in any order. Returns [] when the dir does not exist. */
  list(): BlobFileInfo[]
  /** Delete one file by name. May throw; the pruner isolates per-file failures. */
  remove(name: string): void
}

export interface PruneBlobsOptions {
  /** Blobs with `mtimeMs` older than this are unreferenced and removed. */
  cutoffMs: number
  /** Ceiling on total bytes retained; excess is removed oldest-first. */
  maxTotalBytes: number
}

export interface PruneBlobsResult {
  deleted: number
  freedBytes: number
  /** Files that could not be deleted (locked / already gone / permissions). */
  failed: number
}

/**
 * Default ceiling on retained blob bytes: 200 MB. Comfortably holds weeks of
 * normal capture (~10 MB/week measured) while bounding the pathological burst
 * case, and is small next to any disk this app runs on.
 */
export const DEFAULT_MAX_BLOB_BYTES = 200 * 1024 * 1024

/** Directory under the storage dir that `payload-blobs.ts` writes into. */
export const BLOB_DIR_NAME = 'diagnostics'

/**
 * The real filesystem, bound to `<storage>/diagnostics/`. Node built-ins are
 * required lazily for the same reason as in `payload-blobs.ts`: this package is
 * imported by graphs that never touch disk.
 */
export function createFilesystemBlobFs(): BlobFileSystem {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getStorageDir } = require('@slayzone/platform') as typeof import('@slayzone/platform')
  const dir = join(getStorageDir(), BLOB_DIR_NAME)
  return {
    list(): BlobFileInfo[] {
      const out: BlobFileInfo[] = []
      // `withFileTypes` avoids a stat per entry just to skip subdirectories.
      for (const entry of nodeFs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue
        try {
          const stat = nodeFs.statSync(join(dir, entry.name))
          out.push({ name: entry.name, sizeBytes: stat.size, mtimeMs: stat.mtimeMs })
        } catch {
          // Vanished between readdir and stat — nothing to prune.
        }
      }
      return out
    },
    remove(name: string): void {
      nodeFs.unlinkSync(join(dir, name))
    }
  }
}

/**
 * Remove blobs that are older than the cutoff, then — if still over budget —
 * the oldest remaining until the total fits.
 *
 * Never throws: a blob that cannot be deleted is counted in `failed` and skipped,
 * because diagnostics housekeeping must not break the caller's tick.
 */
export function pruneBlobs(fs: BlobFileSystem, opts: PruneBlobsOptions): PruneBlobsResult {
  let files: BlobFileInfo[]
  try {
    files = fs.list()
  } catch {
    // Missing / unreadable dir is the normal case before the first blob is written.
    return { deleted: 0, freedBytes: 0, failed: 0 }
  }

  let deleted = 0
  let freedBytes = 0
  let failed = 0

  const drop = (file: BlobFileInfo): boolean => {
    try {
      fs.remove(file.name)
      deleted++
      freedBytes += file.sizeBytes
      return true
    } catch {
      failed++
      return false
    }
  }

  // Oldest first, so both passes and the size accounting agree on ordering.
  const sorted = [...files].sort((a, b) => a.mtimeMs - b.mtimeMs)

  // Files still on disk after the age pass, and which of them already refused a
  // delete. A stuck file still occupies its bytes, so it must count against the
  // size budget — but it must not be retried, or one stuck file would be tallied
  // in `failed` once per pass.
  const survivors: BlobFileInfo[] = []
  const undeletable = new Set<string>()
  for (const file of sorted) {
    if (file.mtimeMs < opts.cutoffMs && !drop(file)) {
      undeletable.add(file.name)
      survivors.push(file)
      continue
    }
    if (file.mtimeMs >= opts.cutoffMs) survivors.push(file)
  }

  let total = survivors.reduce((sum, f) => sum + f.sizeBytes, 0)
  for (const file of survivors) {
    if (total <= opts.maxTotalBytes) break
    if (undeletable.has(file.name)) continue
    if (drop(file)) total -= file.sizeBytes
  }

  return { deleted, freedBytes, failed }
}
