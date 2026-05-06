import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import type { ContentHash } from '../shared/types'
import { VersionError } from './errors'

export interface BlobWriteResult {
  hash: ContentHash
  size: number
  created: boolean
}

/**
 * Content-addressed blob store on the filesystem.
 *
 * Layout: `{rootDir}/{sha[0:2]}/{sha[2:]}` — sharded for FS performance.
 *
 * Construct with the **top-level data directory**. The store creates a
 * dedicated `blobs/` subdir, kept separate from `assets/` so a user
 * inspecting `assets/{taskId}/` sees only their files, not blob noise.
 */
export class BlobStore {
  readonly rootDir: string

  constructor(dataDir: string) {
    this.rootDir = path.join(dataDir, 'blobs')
  }

  private dirFor(hash: ContentHash | string): string {
    return path.join(this.rootDir, hash.slice(0, 2))
  }

  blobPath(hash: ContentHash | string): string {
    return path.join(this.dirFor(hash), hash.slice(2))
  }

  has(hash: ContentHash | string): boolean {
    return existsSync(this.blobPath(hash))
  }

  read(hash: ContentHash | string): Buffer {
    const p = this.blobPath(hash)
    if (!existsSync(p)) {
      throw new VersionError('BLOB_MISSING', `Blob not found: ${hash}`, { hash })
    }
    return readFileSync(p)
  }

  /** Returns 0 if the blob is missing — caller must guard if that matters. */
  size(hash: ContentHash | string): number {
    const p = this.blobPath(hash)
    if (!existsSync(p)) return 0
    return statSync(p).size
  }

  /**
   * Hashes bytes, writes blob if absent (temp + rename for atomicity),
   * returns hash + whether a new file was created.
   */
  write(bytes: Buffer | string): BlobWriteResult {
    const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf-8') : bytes
    const hash = createHash('sha256').update(buf).digest('hex') as ContentHash
    const finalPath = this.blobPath(hash)
    if (existsSync(finalPath)) {
      return { hash, size: buf.length, created: false }
    }
    mkdirSync(this.dirFor(hash), { recursive: true })
    const tmpDir = path.join(this.rootDir, '.tmp')
    mkdirSync(tmpDir, { recursive: true })
    const tmpPath = path.join(tmpDir, randomUUID())
    writeFileSync(tmpPath, buf)
    try {
      renameSync(tmpPath, finalPath)
    } catch (err) {
      try {
        rmSync(tmpPath, { force: true })
      } catch {
        // ignore
      }
      throw err
    }
    return { hash, size: buf.length, created: true }
  }

  delete(hash: ContentHash | string): boolean {
    const p = this.blobPath(hash)
    if (!existsSync(p)) return false
    rmSync(p, { force: true })
    return true
  }

  /**
   * Walks the blob root, yielding every stored hash. Used for GC scans
   * and integrity checks. Skips the `.tmp/` staging dir.
   */
  listAllHashes(): ContentHash[] {
    if (!existsSync(this.rootDir)) return []
    const hashes: ContentHash[] = []
    for (const shard of readdirSync(this.rootDir)) {
      if (shard === '.tmp' || shard.length !== 2) continue
      const shardDir = path.join(this.rootDir, shard)
      for (const rest of readdirSync(shardDir)) {
        hashes.push((shard + rest) as ContentHash)
      }
    }
    return hashes
  }

  /**
   * Verifies a blob's bytes hash to its claimed name. Returns false on
   * mismatch (corruption) or missing file.
   */
  verify(hash: ContentHash | string): boolean {
    const p = this.blobPath(hash)
    if (!existsSync(p)) return false
    const actual = createHash('sha256').update(readFileSync(p)).digest('hex')
    return actual === hash
  }
}

export function hashBytes(bytes: Buffer | string): ContentHash {
  const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf-8') : bytes
  return createHash('sha256').update(buf).digest('hex') as ContentHash
}
