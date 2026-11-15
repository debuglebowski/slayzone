/**
 * Staged uploads (FU1 S3): a hub hands this computer a file's bytes in chunks
 * (≤ {@link BYTE_RANGE_MAX_CHUNK} each, one frame apiece) instead of one whole base64
 * frame. Keyed by the bytes' sha256 and declared size, so an upload is resumable
 * (`begin` answers how much is here), idempotent (a retry of a complete upload is
 * complete), and verified before use (`take`: complete and hashing to its name).
 * What uses the bytes (an artifact upload, an attachment) runs every check it runs
 * on inline bytes; `release` removes them after use; `sweep` removes leftovers.
 *
 * Files: `<dir>/uploads/<sha256>-<size>.part`, durable enough for a resume (the
 * hash check catches anything a crash left wrong).
 *
 * @module chat-runtime/server/upload-staging
 */
import { closeSync, mkdirSync, openSync, readdirSync, rmSync, statSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { BYTE_RANGE_MAX_CHUNK } from '@slayzone/platform/bounded-reads'
import { fileHashMatches } from './blob-store'

export interface UploadStagingOptions {
  now?: () => number
  /** An upload untouched this long is swept (default 24 h). */
  staleMs?: number
}

export function createUploadStaging(dir: string, opts: UploadStagingOptions = {}) {
  const root = join(dir, 'uploads')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const now = opts.now ?? Date.now
  const staleMs = opts.staleMs ?? 24 * 60 * 60_000
  /** Last touch per staged file (by this process); files from an earlier run use mtime. */
  const touched = new Map<string, number>()

  function pathOf(sha256: string, size: number): string {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid upload hash')
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid upload size')
    return join(root, `${sha256}-${size}.part`)
  }
  function lengthOf(path: string): number | null {
    try {
      return statSync(path).size
    } catch {
      return null
    }
  }

  function sweepOne(name: string, cutoff: number): void {
    if (!name.endsWith('.part')) return
    const path = join(root, name)
    const at =
      touched.get(path) ??
      (() => {
        try {
          return statSync(path).mtimeMs
        } catch {
          return Number.POSITIVE_INFINITY
        }
      })()
    if (at < cutoff) {
      rmSync(path, { force: true })
      touched.delete(path)
    }
  }

  return {
    /** Start (or resume) staging `size` bytes named `sha256`: how many are here already. */
    begin(sha256: string, size: number): { received: number } {
      const path = pathOf(sha256, size)
      let received = lengthOf(path)
      if (received === null) {
        closeSync(openSync(path, 'a', 0o600))
        received = 0
      }
      touched.set(path, now())
      return { received }
    },

    /** Append `bytes` at `offset` (= the bytes here so far). Answers the new total. */
    chunk(sha256: string, size: number, offset: number, bytes: Uint8Array): { received: number } {
      const path = pathOf(sha256, size)
      if (bytes.length > BYTE_RANGE_MAX_CHUNK)
        throw new Error(`Upload chunk over ${BYTE_RANGE_MAX_CHUNK} bytes`)
      const here = lengthOf(path)
      if (here === null) throw new Error('Upload not begun; begin it first')
      if (offset !== here) throw new Error(`Upload chunk at offset ${offset}, expected ${here}`)
      if (offset + bytes.length > size) throw new Error('Upload chunk past its declared size')
      const fd = openSync(path, 'a')
      try {
        let written = 0
        while (written < bytes.length)
          written += writeSync(fd, bytes, written, bytes.length - written)
      } finally {
        closeSync(fd)
      }
      touched.set(path, now())
      return { received: offset + bytes.length }
    },

    /** The complete, verified staged file (its path); refused if incomplete or not its hash. */
    take(sha256: string, size: number): { path: string; size: number } {
      const path = pathOf(sha256, size)
      const here = lengthOf(path)
      if (here === null) throw new Error('Upload not staged on this computer; send it again')
      if (here !== size) throw new Error(`Upload incomplete: ${here} of ${size} bytes`)
      if (!fileHashMatches(path, sha256)) throw new Error('Upload hash mismatch; send it again')
      touched.set(path, now())
      return { path, size }
    },

    /** Remove a staged upload (after its use). */
    release(sha256: string, size: number): void {
      const path = pathOf(sha256, size)
      rmSync(path, { force: true })
      touched.delete(path)
    },

    /** Remove uploads untouched for `staleMs`. */
    sweep(): void {
      const cutoff = now() - staleMs
      for (const name of readdirSync(root)) {
        // One leftover that cannot be removed never stops the sweep of the others.
        try {
          sweepOne(name, cutoff)
        } catch {
          /* retried on the next sweep */
        }
      }
    }
  }
}

export type UploadStaging = ReturnType<typeof createUploadStaging>
