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
import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

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

/** Directory, beside the diagnostics DB, that `payload-blobs.ts` writes into. */
export const BLOB_DIR_NAME = 'diagnostics'

/**
 * Where the payload blobs of the diagnostics DB at `diagnosticsDbPath` live: a
 * `diagnostics/` dir beside it. Every host derives its blob dir from the DB file it
 * opened, so all processes writing one diagnostics DB write — and prune — one set
 * of blobs. Hosts pass the result to `bindDiagnosticsDbs({ blobDir })`.
 */
export function diagnosticsBlobDirBeside(diagnosticsDbPath: string): string {
  return join(dirname(diagnosticsDbPath), BLOB_DIR_NAME)
}

/** The real filesystem, bound to `dir` (see {@link diagnosticsBlobDirBeside}). */
export function createFilesystemBlobFs(dir: string): BlobFileSystem {
  return {
    list(): BlobFileInfo[] {
      const out: BlobFileInfo[] = []
      // `withFileTypes` avoids a stat per entry just to skip subdirectories.
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue
        try {
          const stat = statSync(join(dir, entry.name))
          out.push({ name: entry.name, sizeBytes: stat.size, mtimeMs: stat.mtimeMs })
        } catch {
          // Vanished between readdir and stat — nothing to prune.
        }
      }
      return out
    },
    remove(name: string): void {
      unlinkSync(join(dir, name))
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
