import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import { unzipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const picked = vi.hoisted(() => ({ dir: '', file: '' as string | null }))
const revealed = vi.hoisted(() => [] as string[])

/** When set, every write(2) through a FileHandle writes at most this many bytes. */
const shortWrites = vi.hoisted(() => ({ max: 0 }))
vi.mock('fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs/promises')>()
  const open = (async (...args: Parameters<typeof real.open>) => {
    const handle = await real.open(...args)
    const write = handle.write.bind(handle) as (...a: unknown[]) => Promise<unknown>
    ;(handle as unknown as { write: unknown }).write = (
      buf: Uint8Array,
      off?: number,
      len?: number
    ) => {
      if (!shortWrites.max || !(buf instanceof Uint8Array)) return write(buf, off, len)
      const start = off ?? 0
      const want = len ?? buf.byteLength - start
      return write(buf, start, Math.min(want, shortWrites.max))
    }
    return handle
  }) as typeof real.open
  return { ...real, default: { ...real, open }, open }
})

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  BrowserWindow: {},
  dialog: {
    showOpenDialog: async () => ({ canceled: false, filePaths: [picked.dir] }),
    showSaveDialog: async () =>
      picked.file ? { canceled: false, filePath: picked.file } : { canceled: true }
  },
  shell: { showItemInFolder: (p: string) => revealed.push(p) }
}))

const { SaveTargets, abortAllSaveTargetsNow, watchSaveTargetOwner, copyInto, writeFileWhole } =
  await import('./client-save')
const { EventEmitter } = await import('node:events')

let root: string
let targets: InstanceType<typeof SaveTargets>
const SENDER = 7
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'slz-client-save-'))
  picked.dir = path.join(root, 'dest')
  fs.mkdirSync(picked.dir)
  picked.file = path.join(root, 'out.bin')
  revealed.length = 0
  targets = new SaveTargets()
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const bytes = (s: string) => new TextEncoder().encode(s)
const ignoreErr = (): void => undefined

async function openOk(req: unknown): Promise<string> {
  const r = await targets.open(SENDER, null, req)
  if (!r.ok) throw new Error(JSON.stringify(r))
  return r.targetId
}

describe('file target', () => {
  test('appends pieces to the picked file and reveals on request', async () => {
    const id = await openOk({ kind: 'file', fileName: 'a.bin', title: 't', reveal: true })
    await targets.write(SENDER, id, '', bytes('hel'))
    await targets.write(SENDER, id, '', bytes('lo'))
    // Never visible half-written: the file appears only once it is complete.
    expect(fs.existsSync(picked.file!)).toBe(false)
    expect(await targets.close(SENDER, id)).toEqual({ ok: true })
    expect(fs.readFileSync(picked.file!, 'utf8')).toBe('hello')
    expect(revealed).toEqual([picked.file])
  })

  test('a dismissed dialog is a cancel', async () => {
    picked.file = null
    expect(await targets.open(SENDER, null, { kind: 'file', fileName: 'a', title: 't' })).toEqual({
      ok: false,
      canceled: true
    })
  })

  test('abort removes the partial file', async () => {
    const id = await openOk({ kind: 'file', fileName: 'a.bin', title: 't' })
    await targets.write(SENDER, id, '', bytes('partial'))
    await targets.abort(SENDER, id)
    expect(fs.existsSync(picked.file!)).toBe(false)
    expect(fs.readdirSync(root).filter((n) => n.includes('partial'))).toEqual([])
  })

  test('another window cannot use a target it did not open', async () => {
    const id = await openOk({ kind: 'file', fileName: 'a.bin', title: 't' })
    await expect(targets.write(99, id, '', bytes('x'))).rejects.toThrow('Unknown save target')
  })
})

describe('directory target', () => {
  test('writes the tree inside the picked directory, empty folders included', async () => {
    const id = await openOk({ kind: 'directory', folderName: 'docs', title: 't' })
    await targets.mkdir(SENDER, id, 'docs/empty')
    await targets.write(SENDER, id, 'docs/a.md', bytes('A1'))
    await targets.write(SENDER, id, 'docs/a.md', bytes('A2'))
    // a.md is finished (a new path started); b.md is still being written.
    await targets.write(SENDER, id, 'docs/sub/b.md', bytes('B'))
    expect(fs.existsSync(path.join(picked.dir, 'docs', 'a.md'))).toBe(true)
    expect(fs.existsSync(path.join(picked.dir, 'docs', 'sub', 'b.md'))).toBe(false)
    expect(await targets.close(SENDER, id)).toEqual({ ok: true })
    expect(fs.readFileSync(path.join(picked.dir, 'docs', 'a.md'), 'utf8')).toBe('A1A2')
    expect(fs.readFileSync(path.join(picked.dir, 'docs', 'sub', 'b.md'), 'utf8')).toBe('B')
    expect(fs.statSync(path.join(picked.dir, 'docs', 'empty')).isDirectory()).toBe(true)
  })

  // The client's planner already strips `..`; this is the writer's own guard against a
  // request that never went through it (any renderer code can call the IPC).
  test('refuses a path that climbs out', async () => {
    const id = await openOk({ kind: 'directory', folderName: 'evil', title: 't' })
    await expect(targets.write(SENDER, id, '../../escape.md', bytes('E'))).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_BASE'
    })
    expect(fs.existsSync(path.join(root, 'escape.md'))).toBe(false)
  })

  test('abort removes the files it wrote', async () => {
    const id = await openOk({ kind: 'directory', folderName: 'docs', title: 't' })
    await targets.write(SENDER, id, 'docs/a.md', bytes('A'))
    await targets.write(SENDER, id, 'docs/b.md', bytes('B'))
    await targets.abort(SENDER, id)
    // The download made `docs`, so abort removes it too.
    expect(fs.existsSync(path.join(picked.dir, 'docs'))).toBe(false)
  })
})

describe('zip target', () => {
  test('streams entries into one archive, empty folders included', async () => {
    picked.file = path.join(root, 'all.zip')
    const id = await openOk({ kind: 'zip', fileName: 'artifacts.zip', title: 't', reveal: true })
    await targets.mkdir(SENDER, id, 'empty')
    await targets.write(SENDER, id, 'docs/a.md', bytes('first '))
    await targets.write(SENDER, id, 'docs/a.md', bytes('second'))
    await targets.write(SENDER, id, 'pic.png', new Uint8Array([137, 80, 78, 71]))
    await targets.write(SENDER, id, 'empty.txt', new Uint8Array(0))
    expect(await targets.close(SENDER, id)).toEqual({ ok: true })
    const out = unzipSync(new Uint8Array(fs.readFileSync(picked.file)))
    expect(new TextDecoder().decode(out['docs/a.md'])).toBe('first second')
    expect(Array.from(out['pic.png'])).toEqual([137, 80, 78, 71])
    expect(out['empty.txt']).toHaveLength(0)
    expect(Object.keys(out)).toContain('empty/')
    expect(revealed).toEqual([picked.file])
  })

  test('streams a large entry without holding it (32 MB through 1 MB pieces)', async () => {
    picked.file = path.join(root, 'big.zip')
    const id = await openOk({ kind: 'zip', fileName: 'big.zip', title: 't' })
    const piece = new Uint8Array(1024 * 1024).map((_, i) => i & 255)
    for (let i = 0; i < 32; i++) await targets.write(SENDER, id, 'big.bin', piece)
    expect(await targets.close(SENDER, id)).toEqual({ ok: true })
    const out = unzipSync(new Uint8Array(fs.readFileSync(picked.file)))
    expect(out['big.bin'].byteLength).toBe(32 * 1024 * 1024)
  })

  test('abort leaves no archive behind', async () => {
    picked.file = path.join(root, 'gone.zip')
    const id = await openOk({ kind: 'zip', fileName: 'gone.zip', title: 't' })
    await targets.write(SENDER, id, 'a.md', bytes('A'))
    await targets.abort(SENDER, id)
    expect(fs.existsSync(picked.file)).toBe(false)
  })
})

// Review 2, M2: a path already written and finished is never continued by another
// entry — the planner makes paths unique; the host refuses rather than append.
describe('a repeated path is refused, never appended to', () => {
  test('directory target', async () => {
    const id = await openOk({ kind: 'directory', folderName: 'docs', title: 't' })
    await targets.write(SENDER, id, 'docs/a.md', bytes('first'))
    await targets.write(SENDER, id, 'docs/b.md', bytes('other'))
    await expect(targets.write(SENDER, id, 'docs/A.md', bytes('second'))).rejects.toThrow(
      'already written'
    )
  })

  test('zip target', async () => {
    picked.file = path.join(root, 'dup.zip')
    const id = await openOk({ kind: 'zip', fileName: 'dup.zip', title: 't' })
    await targets.write(SENDER, id, 'a.md', bytes('first'))
    await targets.write(SENDER, id, 'b.md', bytes('other'))
    await expect(targets.write(SENDER, id, 'a.md', bytes('second'))).rejects.toThrow(
      'already written'
    )
  })
})

test('rejects a malformed request', async () => {
  expect(await targets.open(SENDER, null, { kind: 'nope' })).toEqual({
    ok: false,
    error: 'Invalid save request'
  })
})

const partials = (dir: string): string[] =>
  fs
    .readdirSync(dir, { recursive: true })
    .map(String)
    .filter((n) => n.includes('partial'))

// Review 2, L3: an abort while a write is still opening its file must not leave that
// file (or its handle) behind. Operations on a target run one at a time; abort waits
// for the one in flight, then cleans up — and refuses anything after it.
describe('abort racing a write', () => {
  test('directory: abort issued mid-write leaves no partial and no file', async () => {
    const id = await openOk({ kind: 'directory', folderName: 'docs', title: 't' })
    await targets.write(SENDER, id, 'docs/a.md', bytes('A'))
    const writing = targets.write(SENDER, id, 'docs/b.md', bytes('B'))
    const aborting = targets.abort(SENDER, id)
    await Promise.allSettled([writing, aborting])
    // The download made `docs`, so abort removes it too.
    expect(fs.existsSync(path.join(picked.dir, 'docs'))).toBe(false)
    expect(partials(picked.dir)).toEqual([])
  })

  test('zip: abort issued mid-write leaves nothing', async () => {
    picked.file = path.join(root, 'race.zip')
    const id = await openOk({ kind: 'zip', fileName: 'race.zip', title: 't' })
    const writing = targets.write(SENDER, id, 'a.md', bytes('A'))
    const aborting = targets.abort(SENDER, id)
    await Promise.allSettled([writing, aborting])
    expect(fs.existsSync(picked.file)).toBe(false)
    expect(partials(root)).toEqual([])
  })
})

// Review 2, L2: a renderer that crashes, reloads or navigates keeps its webContents, so
// 'destroyed' never fires; its open targets are aborted on those events too. On quit,
// every partial is removed synchronously.
describe('targets of a window that goes away', () => {
  async function openDir(): Promise<string> {
    const id = await openOk({ kind: 'directory', folderName: 'docs', title: 't' })
    await targets.write(SENDER, id, 'docs/a.md', bytes('A'))
    await targets.write(SENDER, id, 'docs/b.md', bytes('B'))
    return id
  }

  for (const [event, args, aborted] of [
    ['render-process-gone', [{}, { reason: 'oom' }], true],
    ['did-start-navigation', [{ isMainFrame: true, isSameDocument: false }], true],
    ['did-start-navigation', [{ isMainFrame: false, isSameDocument: false }], false],
    ['did-start-navigation', [{ isMainFrame: true, isSameDocument: true }], false],
    ['destroyed', [], true]
  ] as const) {
    test(`${event} ${JSON.stringify(args[0] ?? {})} → ${aborted ? 'aborted' : 'kept'}`, async () => {
      const sender = Object.assign(new EventEmitter(), { id: SENDER })
      watchSaveTargetOwner(sender, targets)
      const id = await openDir()
      sender.emit(event, ...args)
      await new Promise((r) => setTimeout(r, 50))
      if (aborted) {
        // The download made `docs`, so abort removes it too.
        expect(fs.existsSync(path.join(picked.dir, 'docs'))).toBe(false)
        expect(partials(picked.dir)).toEqual([])
        await expect(targets.write(SENDER, id, 'docs/c.md', bytes('C'))).rejects.toThrow()
      } else {
        expect(await targets.close(SENDER, id)).toEqual({ ok: true })
      }
    })
  }

  test('quit removes every partial synchronously', async () => {
    picked.file = path.join(root, 'quit.zip')
    await openOk({ kind: 'zip', fileName: 'quit.zip', title: 't' }).then((id) =>
      targets.write(SENDER, id, 'a.md', bytes('A'))
    )
    picked.file = path.join(root, 'quit.bin')
    await openOk({ kind: 'file', fileName: 'quit.bin', title: 't' }).then((id) =>
      targets.write(SENDER, id, '', bytes('B'))
    )
    await openDir()
    expect(partials(root).length).toBeGreaterThan(0)
    targets.abortAllNow()
    expect(partials(root)).toEqual([])
    // The download made `docs`, so abort removes it too.
    expect(fs.existsSync(path.join(picked.dir, 'docs'))).toBe(false)
  })
})

// ── Review 3 ────────────────────────────────────────────────────────────────────
/** A zip output on disk whose `failAt`-th write fails like a full disk. */
function failingOutput(failAt: number) {
  return (file: string) => {
    let writes = 0
    const disk = fs.createWriteStream(file)
    disk.on('error', ignoreErr)
    return new Writable({
      write(chunk, _enc, cb) {
        if (++writes >= failAt) {
          const err = Object.assign(new Error('ENOSPC: no space left on device'), {
            code: 'ENOSPC'
          })
          cb(err)
          return
        }
        disk.write(chunk, cb)
      },
      destroy(err, cb) {
        // Closed only once the file is: a late open must not outlive the wrapper.
        if (disk.closed) cb(err)
        else {
          disk.once('close', () => cb(err))
          disk.destroy()
        }
      },
      final(cb) {
        disk.end(cb)
      }
    })
  }
}

/**
 * Random bytes in the client's 4 MiB pieces: the shape that, with the output failing on
 * its third write, left the entry waiting for a drain that never came (reproduced).
 */
const noise = (n: number) => crypto.randomBytes(n)

const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what}: still pending`)), ms))
  ])

// M1: a zip whose output fails (disk full, drive gone) rejects the write in flight
// instead of hanging on a drain that never comes, and leaves no partial behind.
describe('a zip whose output fails', () => {
  test('the pending write rejects, abort settles, no partial remains', async () => {
    const t = new SaveTargets({ openZipOutput: failingOutput(3) })
    picked.file = path.join(root, 'full.zip')
    const opened = await t.open(SENDER, null, { kind: 'zip', fileName: 'full.zip', title: 't' })
    if (!opened.ok) throw new Error('not opened')
    const id = opened.targetId
    let failed: unknown = null
    for (let i = 0; i < 64 && !failed; i++)
      await within(t.write(SENDER, id, 'notes.md', noise(4 * 1024 * 1024)), 5_000, 'write').catch(
        (e: unknown) => {
          failed = e
        }
      )
    expect(String(failed)).toMatch(/ENOSPC/)
    await within(t.dropOwner(SENDER), 5_000, 'dropOwner')
    expect(partials(root)).toEqual([])
    expect(fs.existsSync(picked.file)).toBe(false)
  })

  test('quitting while a write is stuck on the failed output leaves no partial', async () => {
    const t = new SaveTargets({ openZipOutput: failingOutput(3) })
    picked.file = path.join(root, 'quit-full.zip')
    const opened = await t.open(SENDER, null, { kind: 'zip', fileName: 'q.zip', title: 't' })
    if (!opened.ok) throw new Error('not opened')
    const writes = Array.from({ length: 8 }, () =>
      t.write(SENDER, opened.targetId, 'notes.md', noise(4 * 1024 * 1024)).catch(ignoreErr)
    )
    void t.dropOwner(SENDER)
    t.abortAllNow()
    await within(Promise.all(writes), 5_000, 'writes')
    expect(partials(root)).toEqual([])
  })
})

// L1: a target that is closing (a long zip finalize) is still removed on quit.
test('quitting during a zip close leaves no partial', async () => {
  picked.file = path.join(root, 'closing.zip')
  const id = await openOk({ kind: 'zip', fileName: 'closing.zip', title: 't' })
  await targets.write(SENDER, id, 'big.md', noise(8 * 1024 * 1024))
  const closing = targets.close(SENDER, id)
  targets.abortAllNow()
  await within(closing, 10_000, 'close')
  expect(partials(root)).toEqual([])
  expect(fs.existsSync(picked.file)).toBe(false)
})

// M2: a folder download never overwrites or deletes a file the person already had.
describe('a folder download into a folder that already has these files', () => {
  const seed = () => {
    fs.mkdirSync(path.join(picked.dir, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(picked.dir, 'docs', 'a.md'), 'MINE a')
    fs.writeFileSync(path.join(picked.dir, 'docs', 'b.md'), 'MINE b')
  }
  const listing = () => fs.readdirSync(path.join(picked.dir, 'docs')).sort()

  test('completed: the originals stay, the downloads arrive beside them', async () => {
    seed()
    const id = await openOk({ kind: 'directory', folderName: 'docs', title: 't' })
    await targets.write(SENDER, id, 'docs/a.md', bytes('NEW a'))
    await targets.write(SENDER, id, 'docs/b.md', bytes('NEW b'))
    expect(await targets.close(SENDER, id)).toEqual({ ok: true })
    expect(fs.readFileSync(path.join(picked.dir, 'docs', 'a.md'), 'utf8')).toBe('MINE a')
    expect(fs.readFileSync(path.join(picked.dir, 'docs', 'b.md'), 'utf8')).toBe('MINE b')
    expect(fs.readFileSync(path.join(picked.dir, 'docs', 'a (2).md'), 'utf8')).toBe('NEW a')
    expect(fs.readFileSync(path.join(picked.dir, 'docs', 'b (2).md'), 'utf8')).toBe('NEW b')
  })

  for (const point of ['before any file is placed', 'after one is placed', 'during close'] as const)
    test(`aborted ${point}: the originals are intact, nothing of the download remains`, async () => {
      seed()
      const id = await openOk({ kind: 'directory', folderName: 'docs', title: 't' })
      await targets.write(SENDER, id, 'docs/a.md', bytes('NEW a'))
      if (point !== 'before any file is placed')
        await targets.write(SENDER, id, 'docs/b.md', bytes('NEW b'))
      if (point === 'during close') {
        const closing = targets.close(SENDER, id)
        targets.abortAllNow()
        await closing
      } else await targets.abort(SENDER, id)
      expect(fs.readFileSync(path.join(picked.dir, 'docs', 'a.md'), 'utf8')).toBe('MINE a')
      expect(fs.readFileSync(path.join(picked.dir, 'docs', 'b.md'), 'utf8')).toBe('MINE b')
      expect(listing()).toEqual(['a.md', 'b.md'])
    })

  test('aborted: folders the download created are removed, folders that existed stay', async () => {
    fs.mkdirSync(path.join(picked.dir, 'keep'), { recursive: true })
    const id = await openOk({ kind: 'directory', folderName: 'x', title: 't' })
    await targets.mkdir(SENDER, id, 'keep/new-empty')
    await targets.write(SENDER, id, 'fresh/sub/a.md', bytes('A'))
    await targets.write(SENDER, id, 'fresh/sub/b.md', bytes('B'))
    await targets.abort(SENDER, id)
    expect(fs.readdirSync(picked.dir).sort()).toEqual(['keep'])
    expect(fs.readdirSync(path.join(picked.dir, 'keep'))).toEqual([])
  })
})

// ── Review 4 ────────────────────────────────────────────────────────────────────
const leftovers = (dir: string): string[] =>
  fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).sort() : []
const ticks = async (n: number) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r))
}
const realCopyTo = async (src: string, dest: import('node:fs/promises').FileHandle) => {
  await dest.write(await fs.promises.readFile(src))
}
const enospc = () => Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })

// D1: a file whose commit is in flight or failed stays tracked until it settles; a
// failed commit or a quit mid-commit leaves neither its partial nor the folder.
describe('a folder download whose file commit fails or is cut short', () => {
  test('commit fails (no hard links, copy hits a full disk): nothing remains', async () => {
    const t = new SaveTargets({
      commitFs: {
        link: async () => {
          throw Object.assign(new Error('ENOTSUP'), { code: 'ENOTSUP' })
        },
        copyTo: async (src, dest) => {
          await dest.write(await fs.promises.readFile(src))
          throw enospc()
        }
      }
    })
    const opened = await t.open(SENDER, null, { kind: 'directory', folderName: 'docs', title: 't' })
    if (!opened.ok) throw new Error('not opened')
    await t.write(SENDER, opened.targetId, 'docs/a.md', bytes('A'))
    await expect(t.write(SENDER, opened.targetId, 'docs/b.md', bytes('B'))).rejects.toThrow(
      'ENOSPC'
    )
    await t.abort(SENDER, opened.targetId)
    expect(leftovers(picked.dir)).toEqual([])
  })

  for (const n of [0, 1, 3, 6, 12])
    test(`quit ${n} ticks into the next file (previous one committing): nothing remains`, async () => {
      const t = new SaveTargets({
        commitFs: {
          link: async (a, b) => {
            await new Promise((r) => setTimeout(r, 20))
            await fs.promises.link(a, b)
          },
          copyTo: realCopyTo
        }
      })
      const opened = await t.open(SENDER, null, {
        kind: 'directory',
        folderName: 'docs',
        title: 't'
      })
      if (!opened.ok) throw new Error('not opened')
      await t.write(SENDER, opened.targetId, 'docs/a.md', bytes('A'))
      const next = t.write(SENDER, opened.targetId, 'docs/b.md', bytes('B'))
      await ticks(n)
      t.abortAllNow()
      await expect(next).rejects.toThrow()
      await new Promise((r) => setTimeout(r, 60))
      expect(leftovers(picked.dir)).toEqual([])
    })
})

// D2: the partial's name never makes a valid file name too long (main wrote names up
// to the 255-byte limit straight to their destination).
describe('names at the filesystem limit', () => {
  const long = (ext: string) => `${'n'.repeat(250 - ext.length)}${ext}`
  test('file target: a 250-byte name saves', async () => {
    picked.file = path.join(root, long('.md'))
    const id = await openOk({ kind: 'file', fileName: long('.md'), title: 't' })
    await targets.write(SENDER, id, '', bytes('x'))
    expect(await targets.close(SENDER, id)).toEqual({ ok: true })
    expect(fs.readFileSync(picked.file, 'utf8')).toBe('x')
  })

  test('folder target: a 250-byte name saves, and a second copy beside it still fits', async () => {
    const name = long('.md')
    fs.mkdirSync(path.join(picked.dir, 'docs'))
    fs.writeFileSync(path.join(picked.dir, 'docs', name), 'MINE')
    const id = await openOk({ kind: 'directory', folderName: 'docs', title: 't' })
    await targets.write(SENDER, id, `docs/${name}`, bytes('NEW'))
    expect(await targets.close(SENDER, id)).toEqual({ ok: true })
    const names = fs.readdirSync(path.join(picked.dir, 'docs'))
    expect(names).toHaveLength(2)
    for (const n of names) expect(Buffer.byteLength(n)).toBeLessThanOrEqual(255)
    const copy = names.find((n) => n !== name)!
    expect(copy.endsWith(' (2).md')).toBe(true)
    expect(fs.readFileSync(path.join(picked.dir, 'docs', copy), 'utf8')).toBe('NEW')
  })

  test('zip target: a 250-byte archive name saves', async () => {
    picked.file = path.join(root, long('.zip'))
    const id = await openOk({ kind: 'zip', fileName: long('.zip'), title: 't' })
    await targets.write(SENDER, id, 'a.md', bytes('A'))
    expect(await targets.close(SENDER, id)).toEqual({ ok: true })
    expect(fs.existsSync(picked.file)).toBe(true)
  })
})

// D3: an output that fails only while the archive is finalized fails the close
// cleanly — and leaves no unhandled rejection behind.
test('a zip that fails during finalize: close reports it, no unhandled rejection', async () => {
  const unhandled: unknown[] = []
  const onUnhandled = (e: unknown) => unhandled.push(e)
  process.on('unhandledRejection', onUnhandled)
  let finalizing = false
  try {
    const t = new SaveTargets({
      openZipOutput: (file) => {
        const disk = fs.createWriteStream(file)
        disk.on('error', ignoreErr)
        return new Writable({
          // The disk fills while the archive is being finalized (its last bytes and
          // central directory): every write after close starts fails.
          write(chunk, _enc, cb) {
            if (finalizing) cb(enospc())
            else disk.write(chunk, cb)
          },
          destroy(err, cb) {
            if (disk.closed) cb(err)
            else {
              disk.once('close', () => cb(err))
              disk.destroy()
            }
          }
        })
      }
    })
    picked.file = path.join(root, 'final.zip')
    const opened = await t.open(SENDER, null, { kind: 'zip', fileName: 'final.zip', title: 't' })
    if (!opened.ok) throw new Error('not opened')
    await t.write(SENDER, opened.targetId, 'a.md', noise(512 * 1024))
    finalizing = true
    expect(await t.close(SENDER, opened.targetId)).toMatchObject({ ok: false })
    await new Promise((r) => setTimeout(r, 100))
    expect(unhandled).toEqual([])
    expect(partials(root)).toEqual([])
    expect(fs.existsSync(picked.file)).toBe(false)
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

// Review 4 (quit watchdog note): a forced exit (`app.exit`: the quit watchdog, a
// relaunch) skips will-quit, so it removes every open download's partial itself.
test('abortAllSaveTargetsNow reaches every SaveTargets, as a forced exit needs', async () => {
  const other = new SaveTargets()
  picked.file = path.join(root, 'forced.bin')
  const opened = await other.open(SENDER, null, { kind: 'file', fileName: 'f.bin', title: 't' })
  if (!opened.ok) throw new Error('not opened')
  await other.write(SENDER, opened.targetId, '', bytes('x'))
  expect(partials(root).length).toBe(1)
  abortAllSaveTargetsNow()
  expect(partials(root)).toEqual([])
})

// ── Review 5 ────────────────────────────────────────────────────────────────────
// #1: cleanup only ever removes a path this download provably created. A commit beside
// the person's own same-name file, cut short at any step, leaves that file as it was.
describe('commits beside a file the person already has', () => {
  const seedMine = () => {
    fs.mkdirSync(path.join(picked.dir, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(picked.dir, 'docs', 'a.md'), 'MINE')
  }
  const mine = () => fs.readFileSync(path.join(picked.dir, 'docs', 'a.md'), 'utf8')
  const eisdir = () => Object.assign(new Error('EISDIR: illegal operation'), { code: 'EISDIR' })

  async function startDownload(t: InstanceType<typeof SaveTargets>) {
    const opened = await t.open(SENDER, null, { kind: 'directory', folderName: 'docs', title: 't' })
    if (!opened.ok) throw new Error('not opened')
    await t.write(SENDER, opened.targetId, 'docs/a.md', bytes('NEW'))
    return opened.targetId
  }

  for (const ms of [0, 5, 25, 45, 80])
    test(`slow hard link, quit ${ms} ms into the commit: the original is byte-identical`, async () => {
      seedMine()
      const t = new SaveTargets({
        commitFs: {
          link: async (a, b) => {
            await new Promise((r) => setTimeout(r, 30))
            await fs.promises.link(a, b)
          },
          copyTo: realCopyTo
        }
      })
      const id = await startDownload(t)
      const closing = t.close(SENDER, id)
      await new Promise((r) => setTimeout(r, ms))
      t.abortAllNow()
      await closing
      await new Promise((r) => setTimeout(r, 120))
      expect(mine()).toBe('MINE')
      expect(leftovers(picked.dir).filter((n) => n.includes('partial'))).toEqual([])
    })

  test('a link error other than EEXIST (FAT: EISDIR) falls back to an exclusive copy', async () => {
    seedMine()
    const t = new SaveTargets({
      commitFs: {
        link: async () => {
          throw eisdir()
        },
        copyTo: realCopyTo
      }
    })
    const id = await startDownload(t)
    expect(await t.close(SENDER, id)).toEqual({ ok: true })
    expect(mine()).toBe('MINE')
    expect(fs.readFileSync(path.join(picked.dir, 'docs', 'a (2).md'), 'utf8')).toBe('NEW')
  })

  for (const when of ['abort', 'quit'] as const)
    test(`${when} during the copy fallback: the original stays, the copy and partial go`, async () => {
      seedMine()
      let copying: () => void = () => undefined
      const inCopy = new Promise<void>((r) => (copying = r))
      const t = new SaveTargets({
        commitFs: {
          link: async () => {
            throw eisdir()
          },
          copyTo: async (src, dest) => {
            copying()
            await new Promise((r) => setTimeout(r, 60))
            await dest.write(await fs.promises.readFile(src))
          }
        }
      })
      const id = await startDownload(t)
      const closing = t.close(SENDER, id)
      await inCopy
      if (when === 'abort') await t.abort(SENDER, id)
      else t.abortAllNow()
      const result = await closing
      await new Promise((r) => setTimeout(r, 120))
      expect(mine()).toBe('MINE')
      // An abort waits for the operation in flight: if the copy finished first the
      // download is complete and stays; otherwise nothing of it remains.
      expect(leftovers(path.join(picked.dir, 'docs'))).toEqual(
        result.ok ? ['a (2).md', 'a.md'] : ['a.md']
      )
      if (when === 'quit') expect(result.ok).toBe(false)
    })

  test('a placed file the person replaced meanwhile is never removed by abort', async () => {
    const id = await openOk({ kind: 'directory', folderName: 'docs', title: 't' })
    await targets.write(SENDER, id, 'docs/a.md', bytes('NEW'))
    await targets.write(SENDER, id, 'docs/b.md', bytes('B'))
    const placedA = path.join(picked.dir, 'docs', 'a.md')
    fs.unlinkSync(placedA)
    fs.writeFileSync(placedA, 'THEIRS NOW')
    await targets.abort(SENDER, id)
    expect(fs.readFileSync(placedA, 'utf8')).toBe('THEIRS NOW')
  })
})

// #6: a finished download is never removed — not by a window that reloads, closes or
// quits exactly as it finishes.
describe('a download that has just finished', () => {
  for (const how of ['dropOwner', 'abortAllNow'] as const)
    test(`${how} right after close: every file stays`, async () => {
      const id = await openOk({ kind: 'directory', folderName: 'docs', title: 't' })
      await targets.write(SENDER, id, 'docs/a.md', bytes('A'))
      await targets.write(SENDER, id, 'docs/b.md', bytes('B'))
      const closing = targets.close(SENDER, id)
      const result = await closing
      if (how === 'dropOwner') await targets.dropOwner(SENDER)
      else targets.abortAllNow()
      expect(result).toEqual({ ok: true })
      expect(leftovers(path.join(picked.dir, 'docs'))).toEqual(['a.md', 'b.md'])
    })

  test('a reload while the final commit runs: the download completes and stays', async () => {
    const t = new SaveTargets({
      commitFs: {
        link: async (a, b) => {
          await new Promise((r) => setTimeout(r, 30))
          await fs.promises.link(a, b)
        },
        copyTo: realCopyTo
      }
    })
    const opened = await t.open(SENDER, null, { kind: 'directory', folderName: 'docs', title: 't' })
    if (!opened.ok) throw new Error('not opened')
    await t.write(SENDER, opened.targetId, 'docs/a.md', bytes('A'))
    const closing = t.close(SENDER, opened.targetId)
    const dropping = t.dropOwner(SENDER)
    const result = await closing
    await dropping
    if (result.ok) expect(leftovers(path.join(picked.dir, 'docs'))).toEqual(['a.md'])
    else expect(leftovers(picked.dir)).toEqual([])
  })
})

// Review 6, #9: quitting closes every file a download holds open (no handle is left
// for garbage collection to close — Node warns today and will throw later).
describe.skipIf(process.platform === 'win32')('quit closes what it held open', () => {
  const openFds = (): number => fs.readdirSync('/dev/fd').length
  test('file and folder targets release their handles on abortAllNow', async () => {
    const baseline = openFds()
    picked.file = path.join(root, 'held.bin')
    await openOk({ kind: 'file', fileName: 'held.bin', title: 't' }).then((id) =>
      targets.write(SENDER, id, '', bytes('B'))
    )
    const dir = await openOk({ kind: 'directory', folderName: 'docs', title: 't' })
    await targets.write(SENDER, dir, 'docs/a.md', bytes('A'))
    expect(openFds()).toBeGreaterThanOrEqual(baseline + 2)
    targets.abortAllNow()
    await expect.poll(openFds, { timeout: 2_000 }).toBe(baseline)
    expect(partials(root)).toEqual([])
  })
})

// Review 7, #9: a write(2) may write fewer bytes than asked (a nearly full disk, some
// network filesystems). Every byte still lands, or the download fails — never a file
// committed short and reported saved.
describe('short writes', () => {
  afterEach(() => {
    shortWrites.max = 0
  })
  const big = crypto.randomBytes(64 * 1024)

  test('file target: every byte lands', async () => {
    shortWrites.max = 1000
    picked.file = path.join(root, 'short.bin')
    const id = await openOk({ kind: 'file', fileName: 'short.bin', title: 't' })
    await targets.write(SENDER, id, '', big)
    await targets.write(SENDER, id, '', bytes('tail'))
    expect(await targets.close(SENDER, id)).toEqual({ ok: true })
    expect(fs.readFileSync(picked.file)).toEqual(Buffer.concat([big, Buffer.from('tail')]))
  })

  test('folder target: every byte lands', async () => {
    shortWrites.max = 1000
    const id = await openOk({ kind: 'directory', folderName: 'docs', title: 't' })
    await targets.write(SENDER, id, 'docs/a.bin', big)
    expect(await targets.close(SENDER, id)).toEqual({ ok: true })
    expect(fs.readFileSync(path.join(picked.dir, 'docs', 'a.bin'))).toEqual(big)
  })

  test('the copy fallback: every byte lands', async () => {
    const src = path.join(root, 'src.bin')
    fs.writeFileSync(src, big)
    shortWrites.max = 1000
    const fsp = await import('fs/promises')
    const dest = await fsp.open(path.join(root, 'copy.bin'), 'wx')
    await copyInto(src, dest).finally(() => dest.close())
    expect(fs.readFileSync(path.join(root, 'copy.bin'))).toEqual(big)
  })
})

// Review 9, L6: an export replaces the chosen file only once its bytes are complete.
// A failed write (a full disk) leaves the person's old file as it was, and no partial.
describe('writeFileWhole', () => {
  test('replaces the file with the complete bytes', async () => {
    const dest = path.join(root, 'report.pdf')
    fs.writeFileSync(dest, 'OLD')
    await writeFileWhole(dest, Buffer.from('NEW CONTENT'))
    expect(fs.readFileSync(dest, 'utf8')).toBe('NEW CONTENT')
    expect(partials(root)).toEqual([])
  })

  test('a failed write leaves the old file intact and no partial', async () => {
    const dest = path.join(root, 'report.pdf')
    fs.writeFileSync(dest, 'OLD')
    shortWrites.max = 0
    const failing = Buffer.from('x'.repeat(100_000))
    await expect(
      writeFileWhole(dest, failing, {
        write: async (handle, data) => {
          await handle.write(data, 0, 10)
          throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
        }
      })
    ).rejects.toThrow('ENOSPC')
    expect(fs.readFileSync(dest, 'utf8')).toBe('OLD')
    expect(partials(root)).toEqual([])
  })

  // As main (which wrote in place): what isn't a plain file of ours is written through,
  // never replaced — a read-only file still refuses, a symlink's target and a hard
  // link's shared file get the bytes.
  // root writes read-only files anyway.
  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a read-only file is refused, as on main',
    async () => {
      const dest = path.join(root, 'locked.pdf')
      fs.writeFileSync(dest, 'OLD')
      fs.chmodSync(dest, 0o444)
      await expect(writeFileWhole(dest, Buffer.from('NEW'))).rejects.toThrow(/EACCES|EPERM/)
      expect(fs.readFileSync(dest, 'utf8')).toBe('OLD')
      expect((fs.statSync(dest).mode & 0o777).toString(8)).toBe('444')
      expect(partials(root)).toEqual([])
    }
  )

  test.skipIf(process.platform === 'win32')(
    'a symlink and a hard link are written through',
    async () => {
      const target = path.join(root, 'real.pdf')
      fs.writeFileSync(target, 'OLD')
      const link = path.join(root, 'link.pdf')
      fs.symlinkSync(target, link)
      await writeFileWhole(link, Buffer.from('VIA LINK'))
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
      expect(fs.readFileSync(target, 'utf8')).toBe('VIA LINK')
      const twin = path.join(root, 'twin.pdf')
      fs.linkSync(target, twin)
      await writeFileWhole(twin, Buffer.from('BOTH'))
      expect(fs.readFileSync(target, 'utf8')).toBe('BOTH')
      expect(partials(root)).toEqual([])
    }
  )
})

// Review 9, F3: an entry that may reach 4 GiB carries a zip64 extra in its LOCAL header
// and a 24-byte descriptor, so readers that walk local headers (macOS ditto / Archive
// Utility, streaming readers) keep every later entry. Declared sizes drive it (the
// client knows each entry's size before its first byte); the layout is checked byte for
// byte and by the real readers available here.
describe('zip64 for an entry declared ≥ 4 GiB', () => {
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
  const hasTool = (cmd: string, args: string[]): boolean => {
    try {
      execFileSync(cmd, args, { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }

  async function build(): Promise<Buffer> {
    picked.file = path.join(root, 'wide.zip')
    const id = await openOk({ kind: 'zip', fileName: 'wide.zip', title: 't' })
    // Declared wide (the layout under test); the bytes are small so the test is fast.
    await targets.write(SENDER, id, 'big.bin', bytes('BIG BYTES'), 5_000_000_000)
    await targets.write(SENDER, id, 'pic.png', new Uint8Array([1, 2, 3]), 5_000_000_000)
    await targets.mkdir(SENDER, id, 'd')
    await targets.write(SENDER, id, 'd/after.txt', bytes('after'), 5)
    expect(await targets.close(SENDER, id)).toEqual({ ok: true })
    return fs.readFileSync(picked.file)
  }

  test('local header and descriptor of a wide entry, classic for the rest', async () => {
    const zip = await build()
    for (const name of ['big.bin', 'pic.png']) {
      const at = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 3, 4]), zip.indexOf(name))
      expect(zip.readUInt32LE(at)).toBe(0x04034b50)
      expect(zip.readUInt16LE(at + 4)).toBe(45)
      expect(zip.readUInt16LE(at + 6) & 0x0008).toBe(0x0008)
      expect(zip.readUInt32LE(at + 14)).toBe(0)
      expect(zip.readUInt32LE(at + 18)).toBe(0xffffffff)
      expect(zip.readUInt32LE(at + 22)).toBe(0xffffffff)
      const nameLen = zip.readUInt16LE(at + 26)
      expect(zip.readUInt16LE(at + 28)).toBe(20)
      const extra = at + 30 + nameLen
      expect(zip.readUInt16LE(extra)).toBe(0x0001)
      expect(zip.readUInt16LE(extra + 2)).toBe(16)
      expect(zip.readBigUInt64LE(extra + 4)).toBe(0n)
      expect(zip.readBigUInt64LE(extra + 12)).toBe(0n)
    }
    const after = zip.indexOf('d/after.txt')
    const at = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 3, 4]), after)
    expect(zip.readUInt16LE(at + 4)).toBe(20)
    expect(zip.readUInt16LE(at + 28)).toBe(0)
    const out = unzipSync(new Uint8Array(zip))
    expect(new TextDecoder().decode(out['big.bin'])).toBe('BIG BYTES')
    expect(Array.from(out['pic.png'])).toEqual([1, 2, 3])
    expect(new TextDecoder().decode(out['d/after.txt'])).toBe('after')
  })

  test.skipIf(!hasTool('bsdtar', ['--version']))(
    'a streaming reader (bsdtar on a pipe) reads every entry',
    async () => {
      const file = path.join(root, 'wide.zip')
      fs.writeFileSync(file, await build())
      const list = execFileSync('/bin/sh', ['-c', 'bsdtar -tf - < "$1"', 'sh', file]).toString()
      expect(list.split('\n').filter(Boolean).sort()).toEqual([
        'big.bin',
        'd/',
        'd/after.txt',
        'pic.png'
      ])
      const after = execFileSync('/bin/sh', ['-c', 'bsdtar -xOf - d/after.txt < "$1"', 'sh', file])
      expect(after.toString()).toBe('after')
    },
    60_000
  )

  test.skipIf(process.platform !== 'darwin' || !fs.existsSync('/usr/bin/ditto'))(
    'macOS ditto keeps every entry after the wide one',
    async () => {
      const file = path.join(root, 'wide.zip')
      fs.writeFileSync(file, await build())
      const out = path.join(root, 'ditto-out')
      execFileSync('/usr/bin/ditto', ['-x', '-k', file, out])
      expect(fs.readFileSync(path.join(out, 'big.bin'), 'utf8')).toBe('BIG BYTES')
      expect(fs.readFileSync(path.join(out, 'd', 'after.txt'), 'utf8')).toBe('after')
    },
    60_000
  )

  test.skipIf(!hasTool('python3', ['--version']) || !hasTool('unzip', ['-v']))(
    'central-directory readers (Python zipfile, unzip -t) read it',
    async () => {
      const file = path.join(root, 'wide.zip')
      fs.writeFileSync(file, await build())
      execFileSync('unzip', ['-tq', file])
      const bad = execFileSync('python3', [
        '-c',
        'import sys,zipfile; print(zipfile.ZipFile(sys.argv[1]).testzip())',
        file
      ])
      expect(bad.toString().trim()).toBe('None')
    },
    60_000
  )
})
