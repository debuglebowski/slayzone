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

const { SaveTargets } = await import('./client-save')

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

test('rejects a malformed request', async () => {
  expect(await targets.open(SENDER, null, { kind: 'nope' })).toEqual({
    ok: false,
    error: 'Invalid save request'
  })
})
