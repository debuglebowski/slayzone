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
