import { open } from 'node:fs/promises'
import type { ArchiveEntry, ArchiveListing } from '../shared/types'

/**
 * The entries of a zip archive, read from its central directory: only the end of
 * the file is read (the end record, then the directory it points at), never the
 * compressed data, so listing a multi-gigabyte archive costs a few reads.
 *
 * Covers what archivers write today: ZIP64 end records and per-entry extra fields,
 * the UTF-8 name flag (names without it are decoded as UTF-8 too, which is what
 * macOS and most tools write), the encrypted flag. Split (multi-disk) archives are
 * refused.
 */

/** Entries returned at most; `totalEntries` / `totalSize` still count every one. */
export const ARCHIVE_LISTING_LIMIT = 10_000
/** A central directory bigger than this is not read (a listing has no use for it). */
const MAX_CENTRAL_DIRECTORY = 64 * 1024 * 1024

const EOCD_SIG = 0x06054b50
const EOCD_SIZE = 22
const MAX_COMMENT = 0xffff
const ZIP64_LOCATOR_SIG = 0x07064b50
const ZIP64_LOCATOR_SIZE = 20
const ZIP64_EOCD_SIG = 0x06064b50
const ZIP64_EOCD_SIZE = 56
const CENTRAL_SIG = 0x02014b50
const CENTRAL_SIZE = 46
const ZIP64_EXTRA_ID = 0x0001
const U16_MAX = 0xffff
const U32_MAX = 0xffffffff

type ReadAt = (offset: number, length: number) => Promise<Uint8Array>

const notAZip = (why: string) => new Error(`Not a zip archive: ${why}`)
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength)
const u64 = (v: DataView, at: number) => Number(v.getBigUint64(at, true))
const utf8 = new TextDecoder('utf-8')

/** A DOS date/time as `YYYY-MM-DDTHH:MM:SS` (zip stores no time zone); null when unset. */
function dosDateTime(date: number, time: number): string | null {
  if (date === 0) return null
  const pad = (n: number) => String(n).padStart(2, '0')
  const year = ((date >> 9) & 0x7f) + 1980
  return `${year}-${pad((date >> 5) & 0x0f)}-${pad(date & 0x1f)}T${pad(time >> 11)}:${pad(
    (time >> 5) & 0x3f
  )}:${pad((time & 0x1f) * 2)}`
}

/** The end-of-central-directory record: the last signature whose comment length ends the file. */
async function findEnd(read: ReadAt, size: number): Promise<{ at: number; record: DataView }> {
  if (size < EOCD_SIZE) throw notAZip('too short')
  const tailLength = Math.min(size, EOCD_SIZE + MAX_COMMENT)
  const tailStart = size - tailLength
  const tail = await read(tailStart, tailLength)
  const v = view(tail)
  for (let i = tail.length - EOCD_SIZE; i >= 0; i--) {
    if (v.getUint32(i, true) !== EOCD_SIG) continue
    // A comment can hold the signature bytes; the real record's comment runs to the end.
    if (i + EOCD_SIZE + v.getUint16(i + 20, true) !== tail.length) continue
    return { at: tailStart + i, record: new DataView(tail.buffer, tail.byteOffset + i, EOCD_SIZE) }
  }
  throw notAZip('no end-of-central-directory record')
}

/** Where the central directory is and how many entries it holds, following ZIP64 when flagged. */
async function locateDirectory(
  read: ReadAt,
  size: number
): Promise<{ offset: number; length: number; count: number }> {
  const { at, record } = await findEnd(read, size)
  if (record.getUint16(4, true) !== 0 || record.getUint16(6, true) !== 0)
    throw new Error('Split (multi-disk) zip archives are not supported')
  let count = record.getUint16(10, true)
  let length = record.getUint32(12, true)
  let offset = record.getUint32(16, true)
  if (count === U16_MAX || length === U32_MAX || offset === U32_MAX) {
    if (at < ZIP64_LOCATOR_SIZE) throw notAZip('ZIP64 locator missing')
    const locator = view(await read(at - ZIP64_LOCATOR_SIZE, ZIP64_LOCATOR_SIZE))
    if (locator.getUint32(0, true) !== ZIP64_LOCATOR_SIG) throw notAZip('ZIP64 locator missing')
    const z64At = u64(locator, 8)
    if (z64At + ZIP64_EOCD_SIZE > size) throw notAZip('ZIP64 end record out of range')
    const z64 = view(await read(z64At, ZIP64_EOCD_SIZE))
    if (z64.getUint32(0, true) !== ZIP64_EOCD_SIG) throw notAZip('ZIP64 end record missing')
    count = u64(z64, 32)
    length = u64(z64, 40)
    offset = u64(z64, 48)
  }
  if (offset + length > size) throw notAZip('central directory out of range')
  if (length > MAX_CENTRAL_DIRECTORY) throw new Error('Zip archive directory is too large to list')
  return { offset, length, count }
}

/** The ZIP64 extra field's values, present only for the fields saturated at 0xFFFFFFFF. */
function zip64Sizes(
  extra: DataView,
  wantSize: boolean,
  wantCompressed: boolean
): { size?: number; compressedSize?: number } {
  let at = 0
  while (at + 4 <= extra.byteLength) {
    const id = extra.getUint16(at, true)
    const len = extra.getUint16(at + 2, true)
    if (id === ZIP64_EXTRA_ID) {
      const out: { size?: number; compressedSize?: number } = {}
      let field = at + 4
      if (wantSize && field + 8 <= at + 4 + len) {
        out.size = u64(extra, field)
        field += 8
      }
      if (wantCompressed && field + 8 <= at + 4 + len) out.compressedSize = u64(extra, field)
      return out
    }
    at += 4 + len
  }
  return {}
}

export async function listZip(
  read: ReadAt,
  size: number,
  limit = ARCHIVE_LISTING_LIMIT
): Promise<ArchiveListing> {
  const { offset, length, count } = await locateDirectory(read, size)
  const dir = await read(offset, length)
  const v = view(dir)
  const entries: ArchiveEntry[] = []
  let totalEntries = 0
  let totalSize = 0
  let at = 0
  while (totalEntries < count && at + CENTRAL_SIZE <= dir.length) {
    if (v.getUint32(at, true) !== CENTRAL_SIG) throw notAZip('corrupt central directory')
    const flags = v.getUint16(at + 8, true)
    const time = v.getUint16(at + 12, true)
    const date = v.getUint16(at + 14, true)
    let compressedSize = v.getUint32(at + 20, true)
    let entrySize = v.getUint32(at + 24, true)
    const nameLength = v.getUint16(at + 28, true)
    const extraLength = v.getUint16(at + 30, true)
    const commentLength = v.getUint16(at + 32, true)
    const nameAt = at + CENTRAL_SIZE
    if (nameAt + nameLength + extraLength > dir.length) throw notAZip('corrupt central directory')
    if (entrySize === U32_MAX || compressedSize === U32_MAX) {
      const z64 = zip64Sizes(
        new DataView(dir.buffer, dir.byteOffset + nameAt + nameLength, extraLength),
        entrySize === U32_MAX,
        compressedSize === U32_MAX
      )
      entrySize = z64.size ?? entrySize
      compressedSize = z64.compressedSize ?? compressedSize
    }
    const path = utf8.decode(dir.subarray(nameAt, nameAt + nameLength))
    totalEntries++
    totalSize += entrySize
    if (entries.length < limit)
      entries.push({
        path,
        isDirectory: path.endsWith('/'),
        size: entrySize,
        compressedSize,
        modified: dosDateTime(date, time),
        encrypted: (flags & 0x0001) !== 0
      })
    at = nameAt + nameLength + extraLength + commentLength
  }
  return { entries, totalEntries, totalSize }
}

/** List an archive held in memory (an artifact a computer holds arrives as bytes). */
export function listZipBytes(bytes: Uint8Array, limit?: number): Promise<ArchiveListing> {
  return listZip(
    async (offset, length) => bytes.subarray(offset, offset + length),
    bytes.byteLength,
    limit
  )
}

/** List an archive on disk, reading only its end record and central directory. */
export async function listZipFile(path: string, limit?: number): Promise<ArchiveListing> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    return await listZip(
      async (offset, length) => {
        const buffer = new Uint8Array(length)
        const { bytesRead } = await handle.read(buffer, 0, length, offset)
        return buffer.subarray(0, bytesRead)
      },
      size,
      limit
    )
  } finally {
    await handle.close()
  }
}
