import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { createZipEncoder, crc32, fflateDeflater } from './zip-stream'

const enc = new TextEncoder()

function encode(
  build: (z: ReturnType<typeof createZipEncoder>) => void,
  opts: { forceZip64?: boolean } = {}
): Uint8Array {
  const out: Uint8Array[] = []
  const z = createZipEncoder((c) => out.push(c), { deflater: fflateDeflater, ...opts })
  build(z)
  z.finish()
  const total = out.reduce((n, c) => n + c.byteLength, 0)
  const all = new Uint8Array(total)
  let at = 0
  for (const c of out) {
    all.set(c, at)
    at += c.byteLength
  }
  return all
}

const hasTool = (cmd: string, args: string[]): boolean => {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926)
  })
})

describe('createZipEncoder', () => {
  it('streams entries piece by piece into a valid archive', () => {
    const zip = encode((z) => {
      z.mkdir('docs/empty')
      z.write('docs/a.md', enc.encode('first '))
      z.write('docs/a.md', enc.encode('second'))
      z.write('pic.png', new Uint8Array([137, 80, 78, 71]))
      z.write('none.txt', new Uint8Array(0))
      z.write('ünï.md', enc.encode('utf-8 name'))
    })
    const out = unzipSync(zip)
    expect(new TextDecoder().decode(out['docs/a.md'])).toBe('first second')
    expect(Array.from(out['pic.png'])).toEqual([137, 80, 78, 71])
    expect(out['none.txt']).toHaveLength(0)
    expect(new TextDecoder().decode(out['ünï.md'])).toBe('utf-8 name')
    expect(Object.keys(out)).toContain('docs/empty/')
  })

  // Review 2, M2: a finished entry is never continued — the archive would merge two
  // artifacts into one entry, or hold two entries of the same name.
  it('refuses a path that was already written (case-insensitively)', () => {
    expect(() =>
      encode((z) => {
        z.write('a.md', enc.encode('first'))
        z.write('b.md', enc.encode('other'))
        z.write('A.md', enc.encode('second'))
      })
    ).toThrow('already written')
  })

  it('deflates text and stores what is already compressed', () => {
    const text = enc.encode('a'.repeat(100_000))
    const zip = encode((z) => {
      z.write('t.txt', text)
      z.write('p.png', text)
    })
    // The stored copy is in the archive at full size; the deflated one is tiny.
    expect(zip.byteLength).toBeGreaterThan(100_000)
    expect(zip.byteLength).toBeLessThan(110_000)
  })

  it.skipIf(!hasTool('python3', ['--version']))(
    'zip64 structures (as used past 4 GB) read back in a standard reader',
    () => {
      const zip = encode(
        (z) => {
          z.mkdir('d')
          z.write('d/a.txt', enc.encode('hello zip64'))
          z.write(
            'b.bin',
            new Uint8Array(70_000).map((_, i) => i & 255)
          )
        },
        { forceZip64: true }
      )
      const dir = mkdtempSync(join(tmpdir(), 'zip64-'))
      try {
        const file = join(dir, 'x.zip')
        writeFileSync(file, zip)
        const report = execFileSync('python3', [
          '-I',
          '-c',
          [
            'import sys, zipfile',
            'z = zipfile.ZipFile(sys.argv[1])',
            'assert z.testzip() is None',
            'print(z.read("d/a.txt").decode(), len(z.read("b.bin")), sorted(z.namelist()))'
          ].join('\n'),
          file
        ]).toString()
        expect(report.trim()).toBe("hello zip64 70000 ['b.bin', 'd/', 'd/a.txt']")
        if (hasTool('unzip', ['-v'])) execFileSync('unzip', ['-tq', file], { stdio: 'ignore' })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )

  // Review 5, #10 asked for a zip64 extra field in EVERY file's local header (and so an
  // 8-byte-size data descriptor on every file), so that a streaming reader expects the
  // wide descriptor an entry past 4 GB gets. Measured instead (2026-11-14, a real
  // 4 GiB + 123 B entry): Java 11's ZipInputStream and libarchive (bsdtar on a pipe)
  // both read this layout correctly — Java sizes the descriptor by the bytes it
  // inflated, libarchive by what follows it — and the proposed layout breaks Java < 21
  // on EVERY archive ("invalid entry size (expected 0 but got 5 bytes)"). So a small
  // entry keeps the classic layout; these pin it and the readers that depend on it.
  const files: Record<string, Uint8Array> = {
    'd/a.txt': enc.encode('hello streaming reader'),
    'b.bin': new Uint8Array(70_000).map((_, i) => (i * 13) & 255),
    'p.png': new Uint8Array([137, 80, 78, 71, 1, 2, 3]),
    'none.txt': new Uint8Array(0)
  }
  const names = ['b.bin', 'd/', 'd/a.txt', 'none.txt', 'p.png']
  const build = (opts: { forceZip64?: boolean } = {}) =>
    encode((z) => {
      z.mkdir('d')
      for (const [path, data] of Object.entries(files)) z.write(path, data)
    }, opts)

  it('a file under 4 GB: no zip64 extra in its local header, a 4-byte-size descriptor', () => {
    const zip = build()
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
    let at = 0
    const seen: string[] = []
    while (view.getUint32(at, true) === 0x04034b50) {
      const flags = view.getUint16(at + 6, true)
      const nameLen = view.getUint16(at + 26, true)
      const extraLen = view.getUint16(at + 28, true)
      const name = new TextDecoder().decode(zip.subarray(at + 30, at + 30 + nameLen))
      seen.push(name)
      expect(view.getUint16(at + 4, true), `${name}: version needed`).toBe(20)
      expect(extraLen, `${name}: no extra field`).toBe(0)
      const dataAt = at + 30 + nameLen
      if (name.endsWith('/')) {
        expect(flags & 8, `${name}: no descriptor`).toBe(0)
        at = dataAt
        continue
      }
      expect(flags & 8, `${name}: descriptor`).toBe(8)
      const comp = centralCompressed(zip, name)
      const desc = dataAt + comp
      expect(view.getUint32(desc, true), `${name}: descriptor signature`).toBe(0x08074b50)
      expect(view.getUint32(desc + 8, true), `${name}: descriptor compressed`).toBe(comp)
      expect(view.getUint32(desc + 12, true), `${name}: descriptor size`).toBe(
        files[name].byteLength
      )
      at = desc + 16
    }
    expect(seen.sort()).toEqual(names)
  })

  /** Run `reader` on `zip` written to a temp file; the file is removed after. */
  const withFile = <T>(zip: Uint8Array, reader: (file: string, dir: string) => T): T => {
    const dir = mkdtempSync(join(tmpdir(), 'zip-stream-'))
    try {
      const file = join(dir, 'x.zip')
      writeFileSync(file, zip)
      return reader(file, dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex').slice(0, 12)

  it.each([
    ['default', {}],
    ['zip64', { forceZip64: true }]
  ] as const)(
    'a streaming reader (libarchive: bsdtar on a pipe) reads every entry of the %s archive',
    (_label, opts) => {
      if (!hasTool('bsdtar', ['--version'])) return
      withFile(build(opts), (file) => {
        // The archive on stdin: libarchive cannot seek, so it reads front to back
        // from the local headers alone, never the central directory.
        const list = execFileSync('/bin/sh', ['-c', 'bsdtar -tf - < "$1"', 'sh', file])
          .toString()
          .trim()
          .split('\n')
          .sort()
        expect(list).toEqual(names)
        for (const [name, data] of Object.entries(files)) {
          const out = execFileSync('/bin/sh', ['-c', 'bsdtar -xOf - "$2" < "$1"', 'sh', file, name])
          expect(sha(out), `${name} content`).toBe(sha(data))
        }
      })
    },
    // Spawns an external reader: generous under a loaded machine.
    60_000
  )

  // Not on the forced-zip64 archive: Java sizes a descriptor by the bytes it inflated,
  // and forceZip64 gives small entries the wide descriptor only a 4 GB entry gets.
  // Deflated entries only: ZipInputStream refuses any STORED entry with a descriptor
  // ("only DEFLATED entries can have EXT descriptor"), which p.png is.
  it.skipIf(!hasTool('java', ['-version']))(
    "a streaming reader (Java's ZipInputStream) reads every deflated entry",
    () => {
      const deflated = names.filter((n) => n !== 'p.png')
      const zip = encode((z) => {
        z.mkdir('d')
        for (const n of deflated) if (!n.endsWith('/')) z.write(n, files[n])
      })
      const report = withFile(zip, (file, dir) => {
        const src = join(dir, 'Read.java')
        writeFileSync(
          src,
          [
            'import java.util.zip.*; import java.io.*; import java.security.*;',
            'public class Read { public static void main(String[] a) throws Exception {',
            '  ZipInputStream z = new ZipInputStream(new BufferedInputStream(System.in)); ZipEntry e;',
            '  while ((e = z.getNextEntry()) != null) {',
            '    MessageDigest md = MessageDigest.getInstance("SHA-256"); byte[] b = new byte[65536]; int n;',
            '    while ((n = z.read(b)) > 0) md.update(b, 0, n);',
            '    StringBuilder h = new StringBuilder(); for (byte x : md.digest()) h.append(String.format("%02x", x));',
            '    System.out.println(e.getName() + ":" + h.substring(0, 12)); } } }'
          ].join('\n')
        )
        return execFileSync('/bin/sh', ['-c', 'java "$1" < "$2"', 'sh', src, file]).toString()
      })
      const expected = deflated.map((n) => `${n}:${sha(files[n] ?? new Uint8Array(0))}`)
      expect(report.trim().split('\n').sort()).toEqual(expected)
    },
    // Spawns an external reader: generous under a loaded machine.
    60_000
  )

  it.each([
    ['default', {}],
    ['zip64', { forceZip64: true }]
  ] as const)(
    'central-directory readers (Python zipfile, unzip -t) read every entry of the %s archive',
    (_label, opts) => {
      if (!hasTool('python3', ['--version'])) return
      const report = withFile(build(opts), (file) => {
        if (hasTool('unzip', ['-v'])) execFileSync('unzip', ['-tq', file], { stdio: 'ignore' })
        return execFileSync('python3', [
          '-I',
          '-c',
          [
            'import sys, zipfile, hashlib',
            'z = zipfile.ZipFile(sys.argv[1])',
            'assert z.testzip() is None',
            'print(" ".join(f"{n}:{hashlib.sha256(z.read(n)).hexdigest()[:12]}" for n in sorted(z.namelist())))'
          ].join('\n'),
          file
        ]).toString()
      })
      expect(report.trim()).toBe(
        names.map((n) => `${n}:${sha(files[n] ?? new Uint8Array(0))}`).join(' ')
      )
    },
    // Spawns an external reader: generous under a loaded machine.
    60_000
  )
})

/** The compressed size the central directory records for `name`. */
function centralCompressed(zip: Uint8Array, name: string): number {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  for (let at = 0; at + 46 <= zip.byteLength; at++) {
    if (view.getUint32(at, true) !== 0x02014b50) continue
    const nameLen = view.getUint16(at + 28, true)
    const extraLen = view.getUint16(at + 30, true)
    if (new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLen)) !== name) continue
    const small = view.getUint32(at + 20, true)
    if (small !== 0xffffffff) return small
    // zip64 extra: size (if 0xFFFFFFFF) then compressed.
    let x = at + 46 + nameLen
    const end = x + extraLen
    while (x < end) {
      const tag = view.getUint16(x, true)
      const len = view.getUint16(x + 2, true)
      if (tag === 1) {
        const sizeWide = view.getUint32(at + 24, true) === 0xffffffff
        return Number(view.getBigUint64(x + 4 + (sizeWide ? 8 : 0), true))
      }
      x += 4 + len
    }
  }
  throw new Error(`${name} not in the central directory`)
}
