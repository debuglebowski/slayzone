/**
 * Review 6, #5: how `slay tasks artifacts download` writes its file.
 *  - No `--output` (`saveNew`): an existing file or symlink of the same name is never
 *    replaced or written through; the download is numbered `name (2).ext`.
 *  - `--output` (`saveReplacing`): what is there is replaced, but whole.
 *  - Either way a failed download leaves no cut file and no temp file.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest'
import { saveNew, saveReplacing, type WriteBody } from './save-file'

// The repo root, from cwd (run-all.sh and vitest run from it): the CLI package
// typechecks as CommonJS, where `import.meta` is a compile error.
const REPO_ROOT = process.env.SLZ_REPO_ROOT ?? process.cwd()
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-save-file-'))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
afterEach(() => vi.restoreAllMocks())

let n = 0
const freshDir = (): string => {
  const d = path.join(root, `d${n++}`)
  fs.mkdirSync(d)
  return d
}

const bytes =
  (data: string | Buffer): WriteBody =>
  (out) =>
    pipeline(Readable.from([Buffer.from(data)]), out)

/** Writes `head`, then the source fails — a dropped connection mid-download. */
const dropped =
  (head: string): WriteBody =>
  (out) =>
    pipeline(
      Readable.from(
        (async function* () {
          yield Buffer.from(head)
          throw new Error('connection reset')
        })()
      ),
      out
    )

describe('saveNew (no --output)', () => {
  test('a free name is used as is, nothing else left in the dir', async () => {
    const dir = freshDir()
    const p = await saveNew(dir, 'a.md', bytes('hello'))
    expect(p).toBe(path.join(dir, 'a.md'))
    expect(fs.readFileSync(p, 'utf8')).toBe('hello')
    expect(fs.readdirSync(dir)).toEqual(['a.md'])
  })

  test('an existing file of that name stays byte-identical; the download is numbered', async () => {
    const dir = freshDir()
    fs.writeFileSync(path.join(dir, 'a.md'), 'precious')
    fs.writeFileSync(path.join(dir, 'a (2).md'), 'also precious')
    const p = await saveNew(dir, 'a.md', bytes('new'))
    expect(p).toBe(path.join(dir, 'a (3).md'))
    expect(fs.readFileSync(p, 'utf8')).toBe('new')
    expect(fs.readFileSync(path.join(dir, 'a.md'), 'utf8')).toBe('precious')
    expect(fs.readFileSync(path.join(dir, 'a (2).md'), 'utf8')).toBe('also precious')
    expect(fs.readdirSync(dir).sort()).toEqual(['a (2).md', 'a (3).md', 'a.md'])
  })

  test('a symlink of that name is not written through; its target stays byte-identical', async () => {
    const dir = freshDir()
    const outside = path.join(freshDir(), 'target.zshrc')
    fs.writeFileSync(outside, 'export PATH=precious')
    fs.symlinkSync(outside, path.join(dir, '.zshrc'))
    const p = await saveNew(dir, '.zshrc', bytes('attacker'))
    // No extension to keep: the number goes at the end.
    expect(p).toBe(path.join(dir, '.zshrc (2)'))
    expect(fs.readFileSync(outside, 'utf8')).toBe('export PATH=precious')
    expect(fs.readlinkSync(path.join(dir, '.zshrc'))).toBe(outside)
  })

  test('a dangling symlink of that name is not followed (its target is not created)', async () => {
    const dir = freshDir()
    const nowhere = path.join(freshDir(), 'would-be-created.md')
    fs.symlinkSync(nowhere, path.join(dir, 'a.md'))
    const p = await saveNew(dir, 'a.md', bytes('x'))
    expect(p).toBe(path.join(dir, 'a (2).md'))
    expect(fs.existsSync(nowhere)).toBe(false)
  })

  test('a directory of that name is skipped too', async () => {
    const dir = freshDir()
    fs.mkdirSync(path.join(dir, 'a.md'))
    expect(await saveNew(dir, 'a.md', bytes('x'))).toBe(path.join(dir, 'a (2).md'))
  })

  test('a download that fails mid-stream leaves nothing behind', async () => {
    const dir = freshDir()
    await expect(saveNew(dir, 'a.md', dropped('partial'))).rejects.toThrow('connection reset')
    expect(fs.readdirSync(dir)).toEqual([])
  })

  test('a writer that throws leaves nothing behind, and an existing file intact', async () => {
    const dir = freshDir()
    fs.writeFileSync(path.join(dir, 'a.md'), 'precious')
    await expect(
      saveNew(dir, 'a.md', async (out) => {
        out.write('partial')
        throw new Error('render failed')
      })
    ).rejects.toThrow('render failed')
    expect(fs.readdirSync(dir)).toEqual(['a.md'])
    expect(fs.readFileSync(path.join(dir, 'a.md'), 'utf8')).toBe('precious')
  })

  test('without hard links (FAT, some shares) it copies — still never over an existing name', async () => {
    const dir = freshDir()
    fs.writeFileSync(path.join(dir, 'a.md'), 'precious')
    const outside = path.join(freshDir(), 't')
    fs.writeFileSync(outside, 'precious too')
    fs.symlinkSync(outside, path.join(dir, 'a (2).md'))
    const link = vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' })
    })
    const p = await saveNew(dir, 'a.md', bytes('new'))
    expect(link).toHaveBeenCalled()
    expect(p).toBe(path.join(dir, 'a (3).md'))
    expect(fs.readFileSync(p, 'utf8')).toBe('new')
    expect(fs.readFileSync(path.join(dir, 'a.md'), 'utf8')).toBe('precious')
    expect(fs.readFileSync(outside, 'utf8')).toBe('precious too')
    expect(fs.readdirSync(dir).sort()).toEqual(['a (2).md', 'a (3).md', 'a.md'])
  })

  // Review 7, #8: the copy fallback creates `name` first and fills it after; a Ctrl-C
  // mid-copy must not leave it cut. Run in a child (the signal ends that process): no
  // hard links, and a copy that stalls after its first piece until interrupted.
  test.skipIf(process.platform === 'win32')(
    'without hard links, a copy interrupted by a signal leaves no cut file',
    async () => {
      const dir = freshDir()
      const script = path.join(root, `interrupted-copy-${n}.mjs`)
      fs.writeFileSync(
        script,
        `import fs from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
const { saveNew } = await import(process.argv[2])
fs.linkSync = () => {
  throw Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' })
}
const createReadStream = fs.createReadStream
fs.createReadStream = (p, ...rest) => {
  if (!String(p).endsWith('.part')) return createReadStream(p, ...rest)
  let sent = false
  return new Readable({
    read() {
      if (!sent) this.push(Buffer.from('partial'))
      sent = true
    }
  })
}
// Alive until interrupted (a stalled stream alone holds nothing open).
setInterval(() => undefined, 1_000)
await saveNew(process.argv[3], 'a.md', (out) => pipeline(Readable.from([Buffer.from('whole')]), out))
`
      )
      // tsx's loader in this very process (its CLI runs the script in a child): the
      // signal must reach the process doing the copy.
      const tsx = path.join(REPO_ROOT, 'node_modules/tsx/dist/esm/index.mjs')
      const child = spawn(
        'node',
        [
          '--import',
          pathToFileURL(tsx).href,
          script,
          path.join(REPO_ROOT, 'packages/apps/cli/src/save-file.ts'),
          dir
        ],
        {
          stdio: ['ignore', 'ignore', 'pipe']
        }
      )
      let stderr = ''
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString()
      })
      const exited = new Promise<NodeJS.Signals | number | null>((resolve) =>
        child.on('exit', (code, signal) => resolve(signal ?? code))
      )
      const dest = path.join(dir, 'a.md')
      // The copy is under way: `a.md` exists and holds its first piece.
      for (;;) {
        if (fs.existsSync(dest) && fs.statSync(dest).size > 0) break
        if (child.exitCode !== null) throw new Error(`the child ended early: ${stderr}`)
        await new Promise((r) => setTimeout(r, 20))
      }
      child.kill('SIGINT')
      expect(await exited).toBe('SIGINT')
      expect(fs.readdirSync(dir)).toEqual([])
    },
    120_000
  )

  test('a large binary download arrives byte-exact', async () => {
    const dir = freshDir()
    const data = Buffer.alloc(3 * 1024 * 1024)
    for (let i = 0; i < data.length; i++) data[i] = (i * 31) & 0xff
    const p = await saveNew(dir, 'big.bin', bytes(data))
    expect(fs.readFileSync(p).equals(data)).toBe(true)
  })
})

describe('saveReplacing (--output)', () => {
  test('a new path is created', async () => {
    const dir = freshDir()
    const target = path.join(dir, 'sub', 'out.pdf')
    expect(await saveReplacing(target, bytes('%PDF'))).toBe(target)
    expect(fs.readFileSync(target, 'utf8')).toBe('%PDF')
    expect(fs.readdirSync(path.dirname(target))).toEqual(['out.pdf'])
  })

  test('an existing file is replaced whole, keeping its permission bits', async () => {
    const dir = freshDir()
    const target = path.join(dir, 'out.md')
    fs.writeFileSync(target, 'old old old old')
    fs.chmodSync(target, 0o600)
    expect(await saveReplacing(target, bytes('new'))).toBe(target)
    expect(fs.readFileSync(target, 'utf8')).toBe('new')
    expect(fs.statSync(target).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(dir)).toEqual(['out.md'])
  })

  test('a failed download leaves the existing file as it was, and no temp file', async () => {
    const dir = freshDir()
    const target = path.join(dir, 'out.md')
    fs.writeFileSync(target, 'old content')
    await expect(saveReplacing(target, dropped('partial'))).rejects.toThrow('connection reset')
    expect(fs.readFileSync(target, 'utf8')).toBe('old content')
    expect(fs.readdirSync(dir)).toEqual(['out.md'])
  })

  test('a failed download to a new path leaves nothing', async () => {
    const dir = freshDir()
    await expect(saveReplacing(path.join(dir, 'out.md'), dropped('partial'))).rejects.toThrow()
    expect(fs.readdirSync(dir)).toEqual([])
  })

  test('a symlink is followed as before: its target gets the bytes, the link stays', async () => {
    const dir = freshDir()
    const other = freshDir()
    const real = path.join(other, 'real.md')
    fs.writeFileSync(real, 'old')
    const link = path.join(dir, 'link.md')
    fs.symlinkSync(real, link)
    expect(await saveReplacing(link, bytes('new'))).toBe(link)
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(real, 'utf8')).toBe('new')
    expect(fs.readdirSync(other)).toEqual(['real.md'])
  })

  test('a file with other hard links is written in place, so every name sees the new bytes', async () => {
    const dir = freshDir()
    const target = path.join(dir, 'out.md')
    fs.writeFileSync(target, 'old')
    fs.linkSync(target, path.join(dir, 'twin.md'))
    await saveReplacing(target, bytes('new'))
    expect(fs.readFileSync(path.join(dir, 'twin.md'), 'utf8')).toBe('new')
  })

  test.skipIf(process.platform === 'win32')(
    'a device is written to directly (/dev/null)',
    async () => {
      expect(await saveReplacing('/dev/null', bytes('discarded'))).toBe('/dev/null')
    }
  )

  // Review 7, #6: no temp file can be made there because the "directory" is none.
  for (const code of ['ENOENT', 'ENOTDIR']) {
    test(`${code} creating the temp file: the file is written in place`, async () => {
      const dir = freshDir()
      const target = path.join(dir, 'out.md')
      fs.writeFileSync(target, 'old')
      const open = fs.openSync
      vi.spyOn(fs, 'openSync').mockImplementation((p, ...rest) => {
        if (String(p).endsWith('.part')) {
          throw Object.assign(new Error(`${code}: open '${String(p)}'`), { code })
        }
        return open(p, ...rest)
      })
      expect(await saveReplacing(target, bytes('new'))).toBe(target)
      expect(fs.readFileSync(target, 'utf8')).toBe('new')
      expect(fs.readdirSync(dir)).toEqual(['out.md'])
    })
  }

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a directory that refuses the temp file: the file is written in place, as before',
    async () => {
      const dir = freshDir()
      const target = path.join(dir, 'out.md')
      fs.writeFileSync(target, 'old')
      fs.chmodSync(dir, 0o555)
      try {
        await saveReplacing(target, bytes('new'))
      } finally {
        fs.chmodSync(dir, 0o755)
      }
      expect(fs.readFileSync(target, 'utf8')).toBe('new')
      expect(fs.readdirSync(dir)).toEqual(['out.md'])
    }
  )
})
