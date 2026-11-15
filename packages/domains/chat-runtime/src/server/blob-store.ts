import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { BYTE_RANGE_MAX_CHUNK, type ByteRangePage } from '@slayzone/platform/bounded-reads'

const hashOf = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
/** Staging files of uploads in flight, process-wide (several stores may share a dir in tests). */
const activeUploads = new Set<string>()

/**
 * One range of the regular file at `path` as a {@link ByteRangePage}: `length`
 * (1..{@link BYTE_RANGE_MAX_CHUNK}) bytes from `offset`, through one fd — never
 * the whole file. `etag` names the file's content (its hash when content-addressed;
 * otherwise size + mtime): a reader refuses a source whose etag changes.
 */
export function readFileRangePage(
  path: string,
  offset: number,
  length: number,
  etag?: string
): ByteRangePage {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid range offset')
  if (!Number.isSafeInteger(length) || length < 1 || length > BYTE_RANGE_MAX_CHUNK)
    throw new Error(`Invalid range length (1..${BYTE_RANGE_MAX_CHUNK})`)
  const stat = lstatSync(path)
  if (!stat.isFile()) throw new Error('Not a regular file')
  if (offset > stat.size) throw new Error('Range offset past the end')
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(Math.min(length, stat.size - offset))
    let read = 0
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, offset + read)
      if (n === 0) break
      read += n
    }
    return {
      data: buffer.subarray(0, read).toString('base64'),
      offset,
      size: stat.size,
      eof: offset + read >= stat.size,
      etag: etag ?? `${stat.size}:${stat.mtimeMs}`
    }
  } finally {
    closeSync(fd)
  }
}

/** The empty source's one range. */
export const EMPTY_RANGE_PAGE: ByteRangePage = {
  data: '',
  offset: 0,
  size: 0,
  eof: true,
  etag: 'empty'
}

/**
 * `length` bytes from `offset` of the blob file at `path` named `hash` (fewer at the
 * end). A read of the whole blob is hash-verified. Never creates anything (archives).
 */
export function readBlobRange(
  path: string,
  hash: string,
  offset: number,
  length: number
): Uint8Array {
  const stat = lstatSync(path)
  if (!stat.isFile()) throw new Error('Blob is not a regular file')
  if (offset === 0 && length >= stat.size) {
    const bytes = readFileSync(path)
    if (hashOf(bytes) !== hash) throw new Error('Blob hash integrity failure')
    return bytes
  }
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(Math.max(0, Math.min(length, stat.size - offset)))
    let read = 0
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, offset + read)
      if (n === 0) break
      read += n
    }
    return buffer.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

/**
 * The content-addressed blob directory of one chat store (`<store>/blobs/<sha256>`):
 * immutable files named by the sha256 of their bytes, written atomically and
 * durably. Shared by user attachments and event blobs (out-of-line base64 of saved
 * events); what keeps a blob alive is its pin records (attachment / event-blob),
 * never the file itself — see `collectGarbage` in attachments.ts.
 */
export function createBlobStore(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  function blobPath(hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid blob hash')
    return join(dir, hash)
  }
  /** The whole blob, hash-verified. */
  function readBlob(hash: string): Uint8Array {
    const path = blobPath(hash)
    if (!lstatSync(path).isFile()) throw new Error('Blob is not a regular file')
    const bytes = readFileSync(path)
    if (hashOf(bytes) !== hash) throw new Error('Blob hash integrity failure')
    return bytes
  }
  /** Size of a stored blob; null when absent (or not a regular file). */
  function sizeOf(hash: string): number | null {
    try {
      const stat = lstatSync(blobPath(hash))
      return stat.isFile() ? stat.size : null
    } catch {
      return null
    }
  }
  /** `length` bytes from `offset` (fewer at the end). Hash-verified when it is the whole blob. */
  function readRange(hash: string, offset: number, length: number): Uint8Array {
    return readBlobRange(blobPath(hash), hash, offset, length)
  }
  /**
   * Store `bytes` under `hash` (the caller verified it), durably: temp file +
   * fsync + rename + directory fsync. An existing intact copy is kept; a corrupt
   * one is replaced by these verified bytes.
   */
  function writeBlob(hash: string, bytes: Uint8Array) {
    const path = blobPath(hash)
    if (existsSync(path)) {
      try {
        readBlob(hash)
        return
      } catch {
        /* Verified caller bytes repair a corrupt local copy. */
      }
    }
    const temp = join(dir, `.upload-${process.pid}-${randomUUID()}`)
    activeUploads.add(temp)
    try {
      const fd = openSync(temp, 'wx', 0o600)
      try {
        writeFileSync(fd, bytes)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(temp, path)
      if (process.platform !== 'win32') {
        const parent = openSync(dir, 'r')
        try {
          fsyncSync(parent)
        } finally {
          closeSync(parent)
        }
      }
    } finally {
      activeUploads.delete(temp)
      if (existsSync(temp)) unlinkSync(temp)
    }
  }
  /**
   * Decode `base64` and store its bytes; null when the string is not CANONICAL
   * base64 (re-encoding the bytes would not give back the same string), so a
   * reference can always reproduce the original string exactly.
   */
  function putBase64(base64: string): { sha256: string; size: number } | null {
    const bytes = Buffer.from(base64, 'base64')
    if (bytes.toString('base64') !== base64) return null
    const sha256 = hashOf(bytes)
    writeBlob(sha256, bytes)
    if (sizeOf(sha256) !== bytes.length) throw new Error('Blob write integrity failure')
    return { sha256, size: bytes.length }
  }
  /** Remove staging files no live upload (this process or another live one) still writes. */
  function collectStaging() {
    for (const name of readdirSync(dir)) {
      if (!/^\.upload-(?:\d+-)?[a-f0-9-]{36}$/.test(name)) continue
      const path = join(dir, name)
      if (activeUploads.has(path)) continue
      const pid = /^\.upload-(\d+)-/.exec(name)?.[1]
      if (pid && Number(pid) !== process.pid) {
        try {
          process.kill(Number(pid), 0)
          continue
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue
        }
      }
      if (lstatSync(path).isFile()) unlinkSync(path)
    }
  }
  /** Names of every stored blob (top-level sha256 files). */
  function list(): string[] {
    return readdirSync(dir).filter((name) => /^[a-f0-9]{64}$/.test(name))
  }
  return {
    dir,
    blobPath,
    readBlob,
    readRange,
    sizeOf,
    writeBlob,
    putBase64,
    collectStaging,
    list,
    hashOf
  }
}
export type BlobStore = ReturnType<typeof createBlobStore>
