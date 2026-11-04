/**
 * A small, strict zip extractor — Node ships zlib but no unzip, and the one archive
 * the CLI unpacks (Chrome for Testing's chrome-headless-shell, ~100 MB, a handful of
 * entries) needs nothing a dependency would add.
 *
 * Reads the central directory (authoritative for names, sizes, CRCs and unix modes;
 * local headers may defer sizes to a data descriptor), then streams each entry from
 * its local header through `inflateRaw` into place, verifying size and CRC-32.
 *
 * Supported: stored (0) and deflate (8), zip64, unix modes (exec bits), directories,
 * symlinks. Refused, as a `ZipError`: encryption, other methods, multi-disk archives,
 * any entry or symlink target that would land outside `destDir`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { Readable, Transform, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'

export class ZipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipError'
  }
}

interface Entry {
  name: string
  method: number
  flags: number
  crc32: number
  compressedSize: number
  size: number
  localHeaderOffset: number
  /** Unix st_mode when the archive was made on unix, else null. */
  mode: number | null
}

const EOCD_SIG = 0x06054b50
const ZIP64_LOCATOR_SIG = 0x07064b50
const ZIP64_EOCD_SIG = 0x06064b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const U32_MAX = 0xffffffff
const U16_MAX = 0xffff

const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000

function readAt(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.alloc(length)
  let read = 0
  while (read < length) {
    const n = fs.readSync(fd, buf, read, length - read, position + read)
    if (n === 0) throw new ZipError('Unexpected end of zip file')
    read += n
  }
  return buf
}

function u64(buf: Buffer, at: number): number {
  const v = buf.readBigUInt64LE(at)
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError('Zip offset too large')
  return Number(v)
}

function readCentralDirectory(fd: number, fileSize: number): Entry[] {
  // EOCD = 22 bytes + up to 64 KiB of comment, at the very end.
  const tailLen = Math.min(fileSize, 22 + U16_MAX)
  const tail = readAt(fd, fileSize - tailLen, tailLen)
  let eocd = -1
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new ZipError('Not a zip file (no end of central directory record)')

  const disk = tail.readUInt16LE(eocd + 4)
  const cdDisk = tail.readUInt16LE(eocd + 6)
  let count = tail.readUInt16LE(eocd + 10)
  let cdSize = tail.readUInt32LE(eocd + 12)
  let cdOffset = tail.readUInt32LE(eocd + 16)

  if (count === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX) {
    const locAt = fileSize - tailLen + eocd - 20
    if (locAt < 0) throw new ZipError('Truncated zip64 archive')
    const loc = readAt(fd, locAt, 20)
    if (loc.readUInt32LE(0) !== ZIP64_LOCATOR_SIG) throw new ZipError('Missing zip64 locator')
    const z = readAt(fd, u64(loc, 8), 56)
    if (z.readUInt32LE(0) !== ZIP64_EOCD_SIG) throw new ZipError('Bad zip64 end record')
    count = u64(z, 32)
    cdSize = u64(z, 40)
    cdOffset = u64(z, 48)
  } else if (disk !== 0 || cdDisk !== 0) {
    throw new ZipError('Multi-disk zip archives are not supported')
  }

  if (cdOffset + cdSize > fileSize) throw new ZipError('Central directory out of bounds')
  const cd = readAt(fd, cdOffset, cdSize)
  const entries: Entry[] = []
  let at = 0
  for (let i = 0; i < count; i++) {
    if (at + 46 > cd.length || cd.readUInt32LE(at) !== CENTRAL_SIG) {
      throw new ZipError('Corrupt central directory')
    }
    const madeBy = cd.readUInt16LE(at + 4)
    const flags = cd.readUInt16LE(at + 8)
    const method = cd.readUInt16LE(at + 10)
    const crc32 = cd.readUInt32LE(at + 16)
    let compressedSize = cd.readUInt32LE(at + 20)
    let size = cd.readUInt32LE(at + 24)
    const nameLen = cd.readUInt16LE(at + 28)
    const extraLen = cd.readUInt16LE(at + 30)
    const commentLen = cd.readUInt16LE(at + 32)
    const external = cd.readUInt32LE(at + 38)
    let localHeaderOffset = cd.readUInt32LE(at + 42)
    const name = cd.toString('utf8', at + 46, at + 46 + nameLen)

    // zip64 extended info: only the fields whose 32-bit slot is saturated, in order.
    let x = at + 46 + nameLen
    const extraEnd = x + extraLen
    while (x + 4 <= extraEnd) {
      const id = cd.readUInt16LE(x)
      const len = cd.readUInt16LE(x + 2)
      if (id === 0x0001) {
        let f = x + 4
        if (size === U32_MAX) {
          size = u64(cd, f)
          f += 8
        }
        if (compressedSize === U32_MAX) {
          compressedSize = u64(cd, f)
          f += 8
        }
        if (localHeaderOffset === U32_MAX) localHeaderOffset = u64(cd, f)
      }
      x += 4 + len
    }

    const isUnix = madeBy >> 8 === 3
    entries.push({
      name,
      method,
      flags,
      crc32,
      compressedSize,
      size,
      localHeaderOffset,
      mode: isUnix ? external >>> 16 : null
    })
    at = extraEnd + commentLen
  }
  return entries
}

/** `destDir`-relative path for an entry name, or a ZipError if it would escape. */
function safeTarget(destDir: string, name: string): string {
  const normalized = name.replace(/\\/g, '/')
  if (
    normalized.startsWith('/') ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.split('/').includes('..')
  ) {
    throw new ZipError(`Refusing zip entry outside the destination: ${name}`)
  }
  const target = path.resolve(destDir, normalized)
  if (target !== destDir && !target.startsWith(destDir + path.sep)) {
    throw new ZipError(`Refusing zip entry outside the destination: ${name}`)
  }
  return target
}

class Crc32Check extends Transform {
  private crc = 0
  private bytes = 0
  constructor(private readonly entry: Entry) {
    super()
  }
  _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.crc = zlib.crc32(chunk, this.crc)
    this.bytes += chunk.length
    cb(null, chunk)
  }
  _flush(cb: TransformCallback): void {
    if (this.bytes !== this.entry.size) {
      cb(new ZipError(`Size mismatch for ${this.entry.name}`))
    } else if (this.crc >>> 0 !== this.entry.crc32 >>> 0) {
      cb(new ZipError(`CRC mismatch for ${this.entry.name}`))
    } else cb()
  }
}

function entryDataStart(fd: number, e: Entry): number {
  const lh = readAt(fd, e.localHeaderOffset, 30)
  if (lh.readUInt32LE(0) !== LOCAL_SIG) throw new ZipError(`Bad local header for ${e.name}`)
  return e.localHeaderOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28)
}

function entrySource(zipPath: string, fd: number, e: Entry): NodeJS.ReadableStream[] {
  if (e.flags & 0x1) throw new ZipError(`Encrypted zip entries are not supported: ${e.name}`)
  if (e.method !== 0 && e.method !== 8) {
    throw new ZipError(`Unsupported compression method ${e.method} for ${e.name}`)
  }
  const start = entryDataStart(fd, e)
  if (e.compressedSize === 0) return [Readable.from([])]
  const raw = fs.createReadStream(zipPath, { start, end: start + e.compressedSize - 1 })
  return e.method === 8 ? [raw, zlib.createInflateRaw()] : [raw]
}

async function readEntry(zipPath: string, fd: number, e: Entry): Promise<Buffer> {
  const chunks: Buffer[] = []
  const sink = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      chunks.push(chunk)
      cb()
    }
  })
  await pipeline([...entrySource(zipPath, fd, e), new Crc32Check(e), sink])
  return Buffer.concat(chunks)
}

/** Unpack every entry of `zipPath` under `destDir` (created if missing). */
export async function extractZip(zipPath: string, destDir: string): Promise<void> {
  const dest = path.resolve(destDir)
  fs.mkdirSync(dest, { recursive: true })
  const fd = fs.openSync(zipPath, 'r')
  try {
    const entries = readCentralDirectory(fd, fs.fstatSync(fd).size)
    // Validate every name before writing anything.
    const targets = entries.map((e) => safeTarget(dest, e.name))

    for (const [i, e] of entries.entries()) {
      const target = targets[i]
      const type = e.mode === null ? 0 : e.mode & S_IFMT
      if (e.name.endsWith('/') || type === S_IFDIR) {
        fs.mkdirSync(target, { recursive: true })
        continue
      }
      fs.mkdirSync(path.dirname(target), { recursive: true })

      if (type === S_IFLNK) {
        const linkTarget = (await readEntry(zipPath, fd, e)).toString('utf8')
        const resolved = path.resolve(path.dirname(target), linkTarget)
        if (path.isAbsolute(linkTarget) || !resolved.startsWith(dest + path.sep)) {
          throw new ZipError(`Refusing symlink outside the destination: ${e.name} -> ${linkTarget}`)
        }
        fs.rmSync(target, { force: true })
        fs.symlinkSync(linkTarget, target)
        continue
      }

      const perm = e.mode !== null && e.mode & 0o777 ? e.mode & 0o777 : 0o644
      await pipeline([
        ...entrySource(zipPath, fd, e),
        new Crc32Check(e),
        fs.createWriteStream(target, { mode: perm })
      ])
      // createWriteStream's mode is filtered by the umask and ignored for an existing file.
      if (process.platform !== 'win32') fs.chmodSync(target, perm)
    }
  } finally {
    fs.closeSync(fd)
  }
}
