import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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

const { saveFileOnDesktop, saveFilesOnDesktop } = await import('./client-save')

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'slz-client-save-'))
  picked.dir = path.join(root, 'dest')
  fs.mkdirSync(picked.dir)
  revealed.length = 0
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const bytes = (s: string) => new TextEncoder().encode(s)

describe('saveFilesOnDesktop', () => {
  test('writes the tree inside the picked directory, empty folders included', async () => {
    const res = await saveFilesOnDesktop(null, {
      folderName: 'docs',
      title: 't',
      dirs: ['docs', 'docs/empty'],
      files: [{ path: 'docs/a.md', data: bytes('A') }]
    })
    expect(res).toEqual({ ok: true })
    expect(fs.readFileSync(path.join(picked.dir, 'docs', 'a.md'), 'utf8')).toBe('A')
    expect(fs.statSync(path.join(picked.dir, 'docs', 'empty')).isDirectory()).toBe(true)
  })

  // The client's planner already strips `..`; this is the writer's own guard against a
  // request that never went through it (any renderer code can call the IPC).
  test('refuses a path that climbs out, writing nothing', async () => {
    await expect(
      saveFilesOnDesktop(null, {
        folderName: 'evil',
        title: 't',
        files: [
          { path: 'evil/ok.md', data: bytes('ok') },
          { path: '../../escape.md', data: bytes('E') }
        ]
      })
    ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_BASE' })
    expect(fs.existsSync(path.join(root, 'escape.md'))).toBe(false)
    expect(fs.existsSync(path.join(picked.dir, 'evil', 'ok.md'))).toBe(false)
  })

  test('rejects a malformed request', async () => {
    expect(await saveFilesOnDesktop(null, { folderName: 'x', title: 't', files: [{}] })).toEqual({
      ok: false,
      error: 'Invalid save request'
    })
  })
})

describe('saveFileOnDesktop', () => {
  test('writes the bytes where the person picked and reveals on request', async () => {
    picked.file = path.join(root, 'out.zip')
    const res = await saveFileOnDesktop(null, {
      fileName: 'artifacts.zip',
      title: 't',
      data: new Uint8Array([80, 75]),
      reveal: true
    })
    expect(res).toEqual({ ok: true })
    expect(Array.from(fs.readFileSync(picked.file))).toEqual([80, 75])
    expect(revealed).toEqual([picked.file])
  })

  test('a dismissed dialog is a cancel', async () => {
    picked.file = null
    expect(
      await saveFileOnDesktop(null, { fileName: 'a.md', title: 't', data: bytes('a') })
    ).toEqual({ ok: false, canceled: true })
  })
})
