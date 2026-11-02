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
  openSync,
  closeSync,
  fsyncSync,
  linkSync,
  createReadStream
} from 'node:fs'
import path from 'node:path'
import { containedPath } from '@slayzone/platform/safe-path'
import type { ContentHash } from '../shared/types'
import { VersionError } from './errors'

const activeStaging = new Set<string>()

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

  /** Strictly inside `rootDir` whatever `hash` holds (`UnsafePathError`): `delete` rm's it. */
  blobPath(hash: ContentHash | string): string {
    return containedPath(this.rootDir, hash.slice(0, 2), hash.slice(2))
  }

  has(hash: ContentHash | string): boolean {
    return existsSync(this.blobPath(hash))
  }

  read(hash: ContentHash | string): Buffer {
    const p = this.blobPath(hash)
    this.restoreDeleted(hash)
    if (!existsSync(p)) {
      throw new VersionError('BLOB_MISSING', `Blob not found: ${hash}`, { hash })
    }
    const bytes = readFileSync(p)
    if (createHash('sha256').update(bytes).digest('hex') !== hash)
      throw new VersionError('BLOB_HASH_MISMATCH', `Blob hash integrity check failed: ${hash}`, {
        hash
      })
    return bytes
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
    if (existsSync(finalPath) && this.verify(hash)) {
      return { hash, size: buf.length, created: false }
    }
    mkdirSync(this.dirFor(hash), { recursive: true, mode: 0o700 })
    const tmpDir = path.join(this.rootDir, '.tmp')
    mkdirSync(tmpDir, { recursive: true, mode: 0o700 })
    const tmpPath = path.join(tmpDir, `${process.pid}-${randomUUID()}`)
    activeStaging.add(tmpPath)
    try {
      const fd = openSync(tmpPath, 'wx', 0o600)
      try {
        writeFileSync(fd, buf)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(tmpPath, finalPath)
      if (process.platform !== 'win32') {
        for (const dir of [this.dirFor(hash), this.rootDir]) {
          const fd = openSync(dir, 'r')
          try {
            fsyncSync(fd)
          } finally {
            closeSync(fd)
          }
        }
      }
    } catch (err) {
      try {
        rmSync(tmpPath, { force: true })
      } catch {
        // ignore
      }
      throw err
    } finally {
      activeStaging.delete(tmpPath)
    }
    return { hash, size: buf.length, created: true }
  }

  /** Remove abandoned writes; never race a write owned by a live foreign process. */
  collectStaging(): number {
    const dir = path.join(this.rootDir, '.tmp')
    if (!existsSync(dir)) return 0
    let removed = 0
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const match = /^(?:(\d+)-)?[a-f0-9-]{36}$/.exec(entry.name)
      if (!match) continue
      const file = path.join(dir, entry.name)
      if (activeStaging.has(file)) continue
      const pid = match[1] ? Number(match[1]) : null
      if (pid && pid !== process.pid) {
        try {
          process.kill(pid, 0)
          continue
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ESRCH') continue
        }
      }
      rmSync(file, { force: true })
      removed++
    }
    return removed
  }

  delete(hash: ContentHash | string): boolean {
    const p = this.blobPath(hash)
    if (!existsSync(p)) return false
    rmSync(p, { force: true })
    return true
  }

  /** Keep a durable link until a later GC observes the committed database. */
  stageDelete(hash: ContentHash | string): void {
    const source = this.blobPath(hash)
    if (!existsSync(source)) return
    const dir = path.join(this.rootDir, '.gc')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const saved = containedPath(dir, hash)
    if (!existsSync(saved)) linkSync(source, saved)
    if (process.platform !== 'win32') {
      for (const target of [dir, this.rootDir]) {
        const fd = openSync(target, 'r')
        try {
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
      }
    }
  }

  restoreDeleted(hash: ContentHash | string): void {
    const destination = this.blobPath(hash)
    const saved = containedPath(path.join(this.rootDir, '.gc'), hash)
    if (existsSync(destination) || !existsSync(saved)) return
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
    linkSync(saved, destination)
    if (process.platform !== 'win32') {
      const fd = openSync(path.dirname(destination), 'r')
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    }
  }

  collectDeleted(referenced: ReadonlySet<string>): number {
    const dir = path.join(this.rootDir, '.gc')
    if (!existsSync(dir)) return 0
    let removed = 0
    for (const hash of readdirSync(dir)) {
      if (!/^[a-f0-9]{64}$/.test(hash)) continue
      if (referenced.has(hash)) this.restoreDeleted(hash)
      rmSync(path.join(dir, hash), { force: true })
      removed++
    }
    return removed
  }

  /** Restoring committed references is safe even while a backup leases blobs. */
  restoreReferenced(referenced: ReadonlySet<string>): void {
    const dir = path.join(this.rootDir, '.gc')
    if (!existsSync(dir)) return
    for (const hash of readdirSync(dir))
      if (/^[a-f0-9]{64}$/.test(hash) && referenced.has(hash)) this.restoreDeleted(hash)
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

  /** Path/stream consumers can verify large historical files without buffering them. */
  async verifyAsync(hash: ContentHash | string): Promise<boolean> {
    this.restoreDeleted(hash)
    const file = this.blobPath(hash)
    if (!existsSync(file)) return false
    const digest = createHash('sha256')
    for await (const chunk of createReadStream(file)) digest.update(chunk)
    return digest.digest('hex') === hash
  }
}

export function hashBytes(bytes: Buffer | string): ContentHash {
  const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf-8') : bytes
  return createHash('sha256').update(buf).digest('hex') as ContentHash
}
