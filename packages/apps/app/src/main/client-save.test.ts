import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { unzipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const picked = vi.hoisted(() => ({ dir: '', file: '' as string | null }))
const revealed = vi.hoisted(() => [] as string[])

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

const { SaveTargets, watchSaveTargetOwner } = await import('./client-save')
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
    expect(fs.readdirSync(path.join(picked.dir, 'docs'))).toEqual([])
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
    expect(fs.readdirSync(path.join(picked.dir, 'docs'))).toEqual([])
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
        expect(fs.readdirSync(path.join(picked.dir, 'docs'))).toEqual([])
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
    expect(fs.readdirSync(path.join(picked.dir, 'docs'))).toEqual([])
  })
})
