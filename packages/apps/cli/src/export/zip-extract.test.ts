/**
 * The in-house zip reader that unpacks Chrome for Testing's headless-shell archive
 * (Node has no unzip). Archives come from `archiver` (already a CLI dependency, the
 * writer `download --type zip` uses) for the formats real zips use — deflate, stored,
 * unix modes, symlinks, zip64 — and from a hand-rolled writer for the hostile cases
 * archiver refuses to produce (path traversal, a bad CRC).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { ZipArchive } from 'archiver'
import { afterAll, describe, expect, test } from 'vitest'
import { extractZip, ZipError } from './zip-extract'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-zip-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))
let n = 0
const fresh = (label: string) => {
  const d = path.join(tmp, `${label}-${n++}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}

async function archiverZip(
  build: (a: ZipArchive) => void,
  opts: Record<string, unknown> = {}
): Promise<string> {
  const out = path.join(fresh('src'), 'a.zip')
  const ws = fs.createWriteStream(out)
  const a = new ZipArchive({ zlib: { level: 9 }, ...opts })
  a.pipe(ws)
  build(a)
  await a.finalize()
  await new Promise<void>((resolve, reject) => {
    ws.on('close', resolve)
    ws.on('error', reject)
  })
  return out
}

/** Stored entries, written by hand: lets a test put any name / CRC in the archive. */
function handZip(entries: Array<{ name: string; data: Buffer; crc?: number }>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name)
    const crc = e.crc ?? zlib.crc32(e.data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(e.data.length, 18)
    lh.writeUInt32LE(e.data.length, 22)
    lh.writeUInt16LE(name.length, 26)
    locals.push(lh, name, e.data)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(e.data.length, 20)
    ch.writeUInt32LE(e.data.length, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt32LE(offset, 42)
    centrals.push(ch, name)
    offset += 30 + name.length + e.data.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

function writeTmp(buf: Buffer): string {
  const p = path.join(fresh('hand'), 'h.zip')
  fs.writeFileSync(p, buf)
  return p
}

const big = Buffer.from(
  Array.from({ length: 20000 }, (_, i) => `line ${i} ${'x'.repeat(i % 50)}`).join('\n')
)

describe('extractZip', () => {
  test('deflated + stored files, nested dirs, unix modes', async () => {
    const zip = await archiverZip((a) => {
      a.append(big, { name: 'pkg/data/big.txt', mode: 0o644 })
      a.append(Buffer.from('#!/bin/sh\necho hi\n'), { name: 'pkg/run', mode: 0o755 })
      a.append(Buffer.from(''), { name: 'pkg/empty', mode: 0o644 })
      a.append(Buffer.from('stored'), { name: 'pkg/stored.bin', store: true })
    })
    const dest = fresh('out')
    await extractZip(zip, dest)
    expect(fs.readFileSync(path.join(dest, 'pkg/data/big.txt')).equals(big)).toBe(true)
    expect(fs.readFileSync(path.join(dest, 'pkg/stored.bin'), 'utf8')).toBe('stored')
    expect(fs.readFileSync(path.join(dest, 'pkg/empty')).length).toBe(0)
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(dest, 'pkg/run')).mode & 0o777).toBe(0o755)
      expect(fs.statSync(path.join(dest, 'pkg/data/big.txt')).mode & 0o111).toBe(0)
    }
  })

  test('explicit directory entries and symlinks inside the archive', async () => {
    const zip = await archiverZip((a) => {
      a.append(null as unknown as Buffer, { name: 'pkg/dir/' })
      a.append(Buffer.from('target'), { name: 'pkg/real.txt' })
      a.symlink('pkg/link.txt', 'real.txt')
    })
    const dest = fresh('out')
    await extractZip(zip, dest)
    expect(fs.statSync(path.join(dest, 'pkg/dir')).isDirectory()).toBe(true)
    if (process.platform !== 'win32') {
      expect(fs.lstatSync(path.join(dest, 'pkg/link.txt')).isSymbolicLink()).toBe(true)
      expect(fs.readFileSync(path.join(dest, 'pkg/link.txt'), 'utf8')).toBe('target')
    }
  })

  test('zip64 archives', async () => {
    const zip = await archiverZip(
      (a) => {
        a.append(big, { name: 'z/big.txt' })
        a.append(Buffer.from('two'), { name: 'z/two.txt' })
      },
      { forceZip64: true }
    )
    const dest = fresh('out')
    await extractZip(zip, dest)
    expect(fs.readFileSync(path.join(dest, 'z/big.txt')).equals(big)).toBe(true)
    expect(fs.readFileSync(path.join(dest, 'z/two.txt'), 'utf8')).toBe('two')
  })

  test.each([
    '../evil.txt',
    'ok/../../evil.txt',
    '/abs/evil.txt',
    'C:/evil.txt',
    'ok\\..\\..\\evil.txt'
  ])('refuses an entry escaping the destination: %s', async (name) => {
    const dest = fresh('out')
    const zip = writeTmp(handZip([{ name, data: Buffer.from('pwned') }]))
    await expect(extractZip(zip, dest)).rejects.toBeInstanceOf(ZipError)
    expect(fs.existsSync(path.join(path.dirname(dest), 'evil.txt'))).toBe(false)
  })

  test('refuses a symlink pointing outside the destination', async () => {
    const zip = await archiverZip((a) => {
      a.symlink('pkg/escape', '../../../../etc/passwd')
    })
    await expect(extractZip(zip, fresh('out'))).rejects.toBeInstanceOf(ZipError)
  })

  // Review 1, M2: a lexical check passes every link here (`t` "points" at dest/a), yet
  // `k/m/s` → `..` makes `k/m/s/t` really `k/t` → `../../../a` = outside dest, and
  // the file lands there. Checked against the real filesystem, the chain is refused.
  test.skipIf(process.platform === 'win32')(
    'refuses a symlink CHAIN that escapes the destination (PoC shape)',
    async () => {
      const zip = await archiverZip((a) => {
        a.append(null as unknown as Buffer, { name: 'k/m/' })
        a.symlink('k/m/s', '..')
        a.symlink('k/m/s/t', '../../../a')
        a.append(Buffer.from('pwned'), { name: 'k/m/s/t/pwned.txt' })
      })
      const root = fresh('chain')
      const dest = path.join(root, 'dest')
      await expect(extractZip(zip, dest)).rejects.toBeInstanceOf(ZipError)
      for (const p of [path.join(root, 'pwned.txt'), path.join(root, 'a', 'pwned.txt')])
        expect(fs.existsSync(p), p).toBe(false)
    }
  )

  test.skipIf(process.platform === 'win32')(
    'refuses a link whose target walks through another link and then up',
    async () => {
      // Lexically `k/m/L` → `s/../../..` is dest/k; really it follows s → .. (dest/k)
      // first, then climbs two more levels: outside.
      const zip = await archiverZip((a) => {
        a.append(null as unknown as Buffer, { name: 'k/m/' })
        a.symlink('k/m/s', '..')
        a.symlink('k/m/L', 's/../../..')
      })
      await expect(extractZip(zip, fresh('out'))).rejects.toBeInstanceOf(ZipError)
    }
  )

  // Review 2, L1 (PoC on APFS): `S` is `s` on a case-blind filesystem, so `L` walks
  // through the link `s` → .. and lands outside. Refused on every platform: a name
  // that differs from a link only in case is treated as that link.
  test.skipIf(process.platform === 'win32')(
    'refuses a link that walks through another link spelled in a different case',
    async () => {
      const zip = await archiverZip((a) => {
        a.append(null as unknown as Buffer, { name: 'a/b/' })
        a.symlink('a/b/s', '..')
        a.symlink('a/b/L', 'S/../../x')
      })
      const root = fresh('case')
      const dest = path.join(root, 'dest')
      await expect(extractZip(zip, dest)).rejects.toBeInstanceOf(ZipError)
      expect(fs.existsSync(path.join(dest, 'a/b/L'))).toBe(false)
    }
  )

  test.skipIf(process.platform === 'win32')(
    'refuses an entry under a link spelled in a different case',
    async () => {
      const zip = await archiverZip((a) => {
        a.append(Buffer.from('x'), { name: 'pkg/real/keep.txt' })
        a.symlink('pkg/alias', 'real')
        a.append(Buffer.from('via link'), { name: 'pkg/ALIAS/sneaky.txt' })
      })
      await expect(extractZip(zip, fresh('out'))).rejects.toBeInstanceOf(ZipError)
    }
  )

  test.skipIf(process.platform === 'win32')(
    'refuses writing THROUGH any symlink the archive created',
    async () => {
      const zip = await archiverZip((a) => {
        a.append(Buffer.from('x'), { name: 'pkg/real/keep.txt' })
        a.symlink('pkg/alias', 'real')
        a.append(Buffer.from('via link'), { name: 'pkg/alias/sneaky.txt' })
      })
      await expect(extractZip(zip, fresh('out'))).rejects.toBeInstanceOf(ZipError)
    }
  )

  test('a CRC mismatch is an error, not a silently corrupt binary', async () => {
    const zip = writeTmp(handZip([{ name: 'a.txt', data: Buffer.from('hello'), crc: 1234 }]))
    await expect(extractZip(zip, fresh('out'))).rejects.toThrow(/CRC/)
  })

  test('not a zip → ZipError', async () => {
    const p = path.join(fresh('bad'), 'x.zip')
    fs.writeFileSync(p, 'this is not a zip file at all')
    await expect(extractZip(p, fresh('out'))).rejects.toBeInstanceOf(ZipError)
  })
})

// Review 4, C4: an entry is cut off the moment it inflates past its declared size —
// not after writing everything first — and an archive declaring more than the cap is
// refused before anything is written.
describe('size limits', () => {
  /** One deflated entry whose header declares `declared` bytes. */
  function bombZip(name: string, real: Buffer, declared: number): Buffer {
    const deflated = zlib.deflateRawSync(real)
    const nameB = Buffer.from(name)
    const crc = zlib.crc32(real)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(8, 8)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(deflated.length, 18)
    lh.writeUInt32LE(declared, 22)
    lh.writeUInt16LE(nameB.length, 26)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(8, 10)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(deflated.length, 20)
    ch.writeUInt32LE(declared, 24)
    ch.writeUInt16LE(nameB.length, 28)
    const cd = Buffer.concat([ch, nameB])
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(1, 8)
    eocd.writeUInt16LE(1, 10)
    eocd.writeUInt32LE(cd.length, 12)
    eocd.writeUInt32LE(30 + nameB.length + deflated.length, 16)
    return Buffer.concat([lh, nameB, deflated, cd, eocd])
  }

  test('an entry inflating past its declared size stops at once', async () => {
    const dest = fresh('bomb')
    const zip = writeTmp(bombZip('b.bin', Buffer.alloc(64 * 1024 * 1024), 10))
    await expect(extractZip(zip, dest)).rejects.toThrow(/Size mismatch|larger than/)
    const written = fs.existsSync(path.join(dest, 'b.bin'))
      ? fs.statSync(path.join(dest, 'b.bin')).size
      : 0
    // At most one inflate chunk past the declared size reaches the disk.
    expect(written).toBeLessThan(1024 * 1024)
  })

  test('an archive declaring more than the cap is refused before anything is written', async () => {
    const dest = fresh('cap')
    const zip = writeTmp(bombZip('big.bin', Buffer.alloc(1000), 1000))
    await expect(extractZip(zip, dest, { maxTotalBytes: 999 })).rejects.toThrow(/too large/)
    expect(fs.readdirSync(dest)).toEqual([])
  })
})
