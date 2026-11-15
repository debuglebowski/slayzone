import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, test } from 'vitest'
import { listZipBytes, listZipFile } from './zip-listing'

const FIXTURE = fileURLToPath(new URL('./__fixtures__/python-made.zip', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'zip-listing-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/**
 * A stored (uncompressed) zip, written field by field, so the edge cases an
 * archiver rarely produces on a small file (ZIP64 records, a comment holding a
 * fake end-record signature, the encrypted flag) can be tested on a few bytes.
 */
function zipOf(
  files: { name: string; data?: string; flags?: number; zip64Extra?: boolean }[],
  opts: { comment?: Buffer; zip64End?: boolean } = {}
): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf-8')
    const data = Buffer.from(f.data ?? '', 'utf-8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(f.flags ?? 0x0800, 6)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, data)

    const extra = Buffer.alloc(f.zip64Extra ? 28 : 0)
    if (f.zip64Extra) {
      extra.writeUInt16LE(0x0001, 0)
      extra.writeUInt16LE(24, 2)
      extra.writeBigUInt64LE(BigInt(data.length), 4)
      extra.writeBigUInt64LE(BigInt(data.length), 12)
      extra.writeBigUInt64LE(BigInt(offset), 20)
    }
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(f.flags ?? 0x0800, 8)
    central.writeUInt16LE((10 << 11) | (20 << 5) | 15, 12) // 10:20:30
    central.writeUInt16LE(((2026 - 1980) << 9) | (11 << 5) | 15, 14) // 2026-11-15
    central.writeUInt32LE(f.zip64Extra ? 0xffffffff : data.length, 20)
    central.writeUInt32LE(f.zip64Extra ? 0xffffffff : data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(extra.length, 30)
    central.writeUInt32LE(f.zip64Extra ? 0xffffffff : offset, 42)
    centrals.push(central, name, extra)
    offset += 30 + name.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const comment = opts.comment ?? Buffer.alloc(0)
  const tail: Buffer[] = []
  if (opts.zip64End) {
    const z64 = Buffer.alloc(56)
    z64.writeUInt32LE(0x06064b50, 0)
    z64.writeBigUInt64LE(44n, 4)
    z64.writeBigUInt64LE(BigInt(files.length), 24)
    z64.writeBigUInt64LE(BigInt(files.length), 32)
    z64.writeBigUInt64LE(BigInt(cd.length), 40)
    z64.writeBigUInt64LE(BigInt(offset), 48)
    const locator = Buffer.alloc(20)
    locator.writeUInt32LE(0x07064b50, 0)
    locator.writeBigUInt64LE(BigInt(offset + cd.length), 8)
    locator.writeUInt32LE(1, 16)
    tail.push(z64, locator)
  }
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(opts.zip64End ? 0xffff : files.length, 8)
  eocd.writeUInt16LE(opts.zip64End ? 0xffff : files.length, 10)
  eocd.writeUInt32LE(opts.zip64End ? 0xffffffff : cd.length, 12)
  eocd.writeUInt32LE(opts.zip64End ? 0xffffffff : offset, 16)
  eocd.writeUInt16LE(comment.length, 20)
  return Buffer.concat([...locals, cd, ...tail, eocd, comment])
}

describe('listing a zip archive', () => {
  test('an archive written by another tool: paths, sizes, dates, folders, UTF-8 names', async () => {
    expect(await listZipFile(FIXTURE)).toEqual({
      entries: [
        {
          path: 'docs/',
          isDirectory: true,
          size: 0,
          compressedSize: 0,
          modified: '2026-11-15T09:30:00',
          encrypted: false
        },
        {
          path: 'docs/readme.md',
          isDirectory: false,
          size: 800,
          compressedSize: 18,
          modified: '2026-11-15T09:30:10',
          encrypted: false
        },
        {
          path: 'docs/naïve café.txt',
          isDirectory: false,
          size: 10,
          compressedSize: 10,
          modified: '2025-01-02T03:04:06',
          encrypted: false
        },
        {
          path: 'big.bin',
          isDirectory: false,
          size: 5000,
          compressedSize: 22,
          modified: '2026-11-15T09:31:00',
          encrypted: false
        }
      ],
      totalEntries: 4,
      totalSize: 5810
    })
  })

  test('reading from bytes and from a file give the same listing', async () => {
    const bytes = zipOf([
      { name: 'a.txt', data: 'hello' },
      { name: 'b/c.txt', data: 'x' }
    ])
    const path = join(dir, 'same.zip')
    writeFileSync(path, bytes)
    expect(await listZipFile(path)).toEqual(await listZipBytes(bytes))
  })

  test('ZIP64: the 64-bit end records and per-entry extra fields', async () => {
    const listing = await listZipBytes(
      zipOf(
        [
          { name: 'big.dat', data: 'abcdef', zip64Extra: true },
          { name: 'small.txt', data: 'hi' }
        ],
        { zip64End: true }
      )
    )
    expect(listing.totalEntries).toBe(2)
    expect(listing.entries.map((e) => [e.path, e.size, e.compressedSize])).toEqual([
      ['big.dat', 6, 6],
      ['small.txt', 2, 2]
    ])
    expect(listing.entries[0].modified).toBe('2026-11-15T10:20:30')
  })

  test('a comment holding a fake end-record signature does not hide the real one', async () => {
    const fake = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(30, 0x41)])
    const listing = await listZipBytes(zipOf([{ name: 'real.txt', data: 'r' }], { comment: fake }))
    expect(listing.entries.map((e) => e.path)).toEqual(['real.txt'])
  })

  test('an encrypted entry is flagged', async () => {
    const listing = await listZipBytes(zipOf([{ name: 'secret.txt', data: 's', flags: 0x0801 }]))
    expect(listing.entries[0].encrypted).toBe(true)
  })

  test('a long archive is capped, with the true count and size kept', async () => {
    const files = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, data: 'xx' }))
    const listing = await listZipBytes(zipOf(files), 3)
    expect(listing.entries.map((e) => e.path)).toEqual(['f0.txt', 'f1.txt', 'f2.txt'])
    expect(listing.totalEntries).toBe(5)
    expect(listing.totalSize).toBe(10)
  })

  test('a file that is not a zip says so', async () => {
    await expect(listZipBytes(Buffer.from('just text, no archive here'))).rejects.toThrow(
      /not a zip archive/i
    )
    await expect(listZipBytes(Buffer.alloc(0))).rejects.toThrow(/not a zip archive/i)
  })
})
