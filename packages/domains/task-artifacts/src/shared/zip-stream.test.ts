import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Deflate, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { createZipEncoder, crc32, type Deflater, mayNeedZip64 } from './zip-stream'

const enc = new TextEncoder()

/** fflate, as the web shell deflates (any raw-DEFLATE deflater does for these tests). */
function fflateDeflater(): Deflater {
  let out: Uint8Array[] = []
  const d = new Deflate({ level: 6 }, (chunk) => {
    out.push(chunk)
  })
  return {
    push(data, final) {
      d.push(data, final)
      const produced = out
      out = []
      return produced
    }
  }
}

/** The encoder's calls, made without awaiting each: it runs them in order. */
interface Calls {
  write(path: string, data: Uint8Array, size?: number): void
  mkdir(path: string): void
}

async function encode(
  build: (z: Calls) => void,
  opts: { forceZip64?: boolean } = {}
): Promise<Uint8Array> {
  const out: Uint8Array[] = []
  const z = createZipEncoder((c) => out.push(c), { deflater: fflateDeflater, ...opts })
  const calls: Promise<void>[] = []
  build({
    write: (path, data, size) => calls.push(z.write(path, data, size)),
    mkdir: (path) => calls.push(z.mkdir(path))
  })
  calls.push(z.finish())
  await Promise.all(calls)
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

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926)
  })
})

describe('createZipEncoder', () => {
  it('streams entries piece by piece into a valid archive', async () => {
    const zip = await encode((z) => {
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
  it('refuses a path that was already written (case-insensitively)', async () => {
    await expect(
      encode((z) => {
        z.write('a.md', enc.encode('first'))
        z.write('b.md', enc.encode('other'))
        z.write('A.md', enc.encode('second'))
      })
    ).rejects.toThrow('already written')
  })

  it('a refused call leaves the archive usable', async () => {
    const out: Uint8Array[] = []
    const z = createZipEncoder((c) => out.push(c), { deflater: fflateDeflater })
    await z.write('a.md', enc.encode('first'))
    await expect(z.write('A.md', enc.encode('second'))).rejects.toThrow('already written')
    await z.write('c.md', enc.encode('third'))
    await z.finish()
    const files = unzipSync(new Uint8Array(Buffer.concat(out)))
    expect(Object.keys(files).sort()).toEqual(['a.md', 'c.md'])
    expect(new TextDecoder().decode(files['a.md'])).toBe('first')
  })

  it('an async deflater writes the same archive as a synchronous one', async () => {
    const later = (): Deflater => {
      const d = fflateDeflater()
      return {
        push: (data, final) =>
          new Promise((resolve) => setTimeout(() => resolve(d.push(data, final)), 1))
      }
    }
    const build = async (deflater: () => Deflater): Promise<Buffer> => {
      const out: Uint8Array[] = []
      const z = createZipEncoder((c) => out.push(c), { deflater, now: new Date(2026, 0, 2) })
      // Not awaited one by one: the encoder runs them in call order.
      const calls = [
        z.write('a.txt', enc.encode('a'.repeat(5_000))),
        z.write('a.txt', enc.encode('b'.repeat(5_000))),
        z.mkdir('d'),
        z.write('d/c.txt', enc.encode('c'.repeat(3_000)), 3_000),
        z.finish()
      ]
      await Promise.all(calls)
      return Buffer.concat(out)
    }
    const sync = await build(fflateDeflater)
    expect((await build(later)).equals(sync)).toBe(true)
    const files = unzipSync(new Uint8Array(sync))
    expect(new TextDecoder().decode(files['a.txt'])).toBe('a'.repeat(5_000) + 'b'.repeat(5_000))
  })

  it('a failure breaks the archive: that call and every later one reject with it', async () => {
    let pushes = 0
    const failing = (): Deflater => {
      const d = fflateDeflater()
      return {
        push: async (data, final) => {
          if (++pushes === 2) throw new Error('deflate failed')
          return d.push(data, final)
        }
      }
    }
    const z = createZipEncoder(() => undefined, { deflater: failing })
    await z.write('a.txt', enc.encode('one'))
    await expect(z.write('a.txt', enc.encode('two'))).rejects.toThrow('deflate failed')
    await expect(z.write('b.txt', enc.encode('three'))).rejects.toThrow('deflate failed')
    await expect(z.finish()).rejects.toThrow('deflate failed')
  })

  it('deflates text and stores what is already compressed', async () => {
    const text = enc.encode('a'.repeat(100_000))
    const zip = await encode((z) => {
      z.write('t.txt', text)
      z.write('p.png', text)
    })
    // The stored copy is in the archive at full size; the deflated one is tiny.
    expect(zip.byteLength).toBeGreaterThan(100_000)
    expect(zip.byteLength).toBeLessThan(110_000)
  })

  it.skipIf(!hasTool('python3', ['--version']))(
    'zip64 structures (as used past 4 GB) read back in a standard reader',
    async () => {
      const zip = await encode(
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
  // Every caller knows each file's size up front (artifact-downloads.ts `pieces()`).
  const build = (opts: { forceZip64?: boolean } = {}) =>
    encode((z) => {
      z.mkdir('d')
      for (const [path, data] of Object.entries(files)) z.write(path, data, data.byteLength)
    }, opts)

  it('a file under 4 GB: no zip64 extra in its local header, a 4-byte-size descriptor', async () => {
    const zip = await build()
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

  it.each([
    ['default', {}],
    ['zip64', { forceZip64: true }]
  ] as const)(
    'a streaming reader (libarchive: bsdtar on a pipe) reads every entry of the %s archive',
    async (_label, opts) => {
      if (!hasTool('bsdtar', ['--version'])) return
      withFile(await build(opts), (file) => {
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
    async () => {
      const deflated = names.filter((n) => n !== 'p.png')
      const zip = await encode((z) => {
        z.mkdir('d')
        for (const n of deflated) if (!n.endsWith('/')) z.write(n, files[n], files[n].byteLength)
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
    async (_label, opts) => {
      if (!hasTool('python3', ['--version'])) return
      const report = withFile(await build(opts), (file) => {
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

// Review 9, F3: an entry of 4 GiB or more got the 24-byte descriptor but no zip64 extra
// in its LOCAL header. A reader that walks the local headers (macOS ditto / Archive
// Utility) then misreads the descriptor and drops every later entry ("Couldn't read
// pkzip signature"). The size is known up front, so such an entry is zip64 from its
// local header on. Measured once on a real 4,609,540,219-byte entry followed by more
// entries (deflated: ditto, unzip -t, bsdtar on a pipe, Python, Java 11 all read every
// entry; stored: the same, Java aside — it refuses any stored entry with a descriptor).
// Here the layout is pinned with an entry DECLARED past 4 GiB, which is laid out the
// same way, and run through the same readers.
describe('an entry of 4 GiB or more', () => {
  const FOUR_GIB = 2 ** 32
  const after = {
    'a.txt': enc.encode('before the big one'),
    'big.txt': enc.encode('pretend I am past 4 GiB '.repeat(40)),
    'big.png': new Uint8Array([137, 80, 78, 71, 9, 9, 9]),
    'd/after.txt': enc.encode('after the big one'),
    'z.md': enc.encode('last')
  } as Record<string, Uint8Array>
  const declared = (name: string, data: Uint8Array) =>
    name.startsWith('big.') ? FOUR_GIB + 123 : data.byteLength
  const build = () =>
    encode((z) => {
      for (const [name, data] of Object.entries(after)) {
        if (name === 'd/after.txt') z.mkdir('d')
        z.write(name, data, declared(name, data))
      }
    })
  const names = ['a.txt', 'big.png', 'big.txt', 'd/', 'd/after.txt', 'z.md']

  /** Each local header in order: name, version needed, flags, sizes, extra. */
  function localHeaders(zip: Uint8Array) {
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
    const out: {
      name: string
      version: number
      flags: number
      comp32: number
      size32: number
      extra: Uint8Array
      descriptor: number
    }[] = []
    let at = 0
    while (view.getUint32(at, true) === 0x04034b50) {
      const nameLen = view.getUint16(at + 26, true)
      const extraLen = view.getUint16(at + 28, true)
      const name = new TextDecoder().decode(zip.subarray(at + 30, at + 30 + nameLen))
      const extra = zip.subarray(at + 30 + nameLen, at + 30 + nameLen + extraLen)
      const dataAt = at + 30 + nameLen + extraLen
      const comp = name.endsWith('/') ? 0 : centralCompressed(zip, name)
      let next = dataAt + comp
      let descriptor = 0
      if (view.getUint16(at + 6, true) & 8) {
        expect(view.getUint32(next, true), `${name}: descriptor signature`).toBe(0x08074b50)
        descriptor =
          view.getUint32(next + 16, true) === 0x04034b50 ||
          view.getUint32(next + 16, true) === 0x02014b50
            ? 16
            : 24
        next += descriptor
      }
      out.push({
        name,
        version: view.getUint16(at + 4, true),
        flags: view.getUint16(at + 6, true),
        comp32: view.getUint32(at + 18, true),
        size32: view.getUint32(at + 22, true),
        extra,
        descriptor
      })
      at = next
    }
    return out
  }

  it('is zip64 from its local header on; the entries around it stay classic', async () => {
    const headers = localHeaders(await build())
    expect(headers.map((h) => h.name).sort()).toEqual(names)
    for (const h of headers) {
      if (h.name.startsWith('big.')) {
        expect(h.version, `${h.name}: version needed`).toBe(45)
        expect(h.flags, `${h.name}: flags`).toBe(0x0808)
        expect([h.comp32, h.size32], `${h.name}: sizes in the zip64 extra`).toEqual([
          0xffffffff, 0xffffffff
        ])
        // id 0x0001, 16 bytes: original size, compressed size (zero: bit 3).
        expect(Array.from(h.extra), `${h.name}: zip64 extra`).toEqual([
          1,
          0,
          16,
          0,
          ...new Array(16).fill(0)
        ])
        expect(h.descriptor, `${h.name}: 8-byte-size descriptor`).toBe(24)
      } else {
        expect(h.version, `${h.name}: version needed`).toBe(20)
        expect(h.extra.byteLength, `${h.name}: no extra`).toBe(0)
        expect(h.descriptor, `${h.name}: 4-byte-size descriptor`).toBe(
          h.name.endsWith('/') ? 0 : 16
        )
      }
    }
  })

  it('an entry of unknown size is laid out for any size', async () => {
    const zip = await encode((z) => {
      z.write('u.txt', enc.encode('size not given'))
      z.write('k.txt', enc.encode('size given'), 10)
    })
    const [u, k] = localHeaders(zip)
    expect([u.name, u.version, u.extra.byteLength, u.descriptor]).toEqual(['u.txt', 45, 20, 24])
    expect([k.name, k.version, k.extra.byteLength, k.descriptor]).toEqual(['k.txt', 20, 0, 16])
    expect(new TextDecoder().decode(unzipSync(zip)['u.txt'])).toBe('size not given')
  })

  it('may need zip64: past 4 GiB, or a deflated entry that can grow past it', () => {
    expect(mayNeedZip64(undefined, 8)).toBe(true)
    expect(mayNeedZip64(0xffffffff, 0)).toBe(true)
    expect(mayNeedZip64(0xfffffffe, 0)).toBe(false)
    // Incompressible data deflates into stored blocks: 5 bytes more per 16 KiB at most.
    expect(mayNeedZip64(0xffffffff - 1_000_000, 8)).toBe(true)
    expect(mayNeedZip64(0xffffffff - 2_000_000, 8)).toBe(false)
    expect(mayNeedZip64(1_000_000_000, 8)).toBe(false)
  })

  const run = (cmd: string, ...args: string[]) =>
    execFileSync('/bin/sh', ['-c', cmd, 'sh', ...args]).toString()

  it.skipIf(process.platform !== 'darwin')(
    'macOS ditto (Archive Utility) extracts every entry, the ones after it included',
    async () => {
      withFile(await build(), (file, dir) => {
        const out = join(dir, 'x')
        run('ditto -x -k "$1" "$2"', file, out)
        const got = run('cd "$1" && find . -type f | sort', out).trim().split('\n')
        expect(got).toEqual(names.filter((n) => !n.endsWith('/')).map((n) => `./${n}`))
        for (const [name, data] of Object.entries(after))
          expect(sha(new Uint8Array(readFileSync(join(out, name)))), name).toBe(sha(data))
      })
    },
    60_000
  )

  it('a streaming reader (libarchive: bsdtar on a pipe) reads every entry', async () => {
    if (!hasTool('bsdtar', ['--version'])) return
    withFile(await build(), (file) => {
      expect(run('bsdtar -tf - < "$1"', file).trim().split('\n').sort()).toEqual(names)
      for (const [name, data] of Object.entries(after))
        expect(
          sha(execFileSync('/bin/sh', ['-c', 'bsdtar -xOf - "$2" < "$1"', 'sh', file, name])),
          name
        ).toBe(sha(data))
    })
  }, 60_000)

  it('central-directory readers (Python zipfile, unzip -t) read every entry', async () => {
    if (!hasTool('python3', ['--version'])) return
    const report = withFile(await build(), (file) => {
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
      names.map((n) => `${n}:${sha(after[n] ?? new Uint8Array(0))}`).join(' ')
    )
  }, 60_000)
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
