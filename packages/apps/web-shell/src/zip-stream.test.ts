import { execFileSync } from 'node:child_process'
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
})
