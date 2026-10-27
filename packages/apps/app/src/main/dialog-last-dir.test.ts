/**
 * Tests for the remembered dialog folder. Electron 43 opens a dialog with no
 * `defaultPath` in Downloads and the OS stopped remembering the last folder, so the
 * app remembers it: a dialog without `defaultPath` starts where the user last picked.
 */
import { afterAll, describe, expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLastDirStore, createRememberingDialog } from './dialog-last-dir'

type Opts = { defaultPath?: string; properties?: string[] }

/** A dialog that records the options it was opened with and answers with `answer`. */
function fakeDialog(answer: { open?: string[]; save?: string; canceled?: boolean }) {
  const seen: Opts[] = []
  return {
    seen,
    port: {
      showOpenDialog: async (_w: null, o: Opts) => {
        seen.push(o)
        return { canceled: !!answer.canceled, filePaths: answer.open ?? [] }
      },
      showSaveDialog: async (_w: null, o: Opts) => {
        seen.push(o)
        return { canceled: !!answer.canceled, filePath: answer.save }
      }
    }
  }
}

const root = mkdtempSync(join(tmpdir(), 'slz-dialog-dir-'))
const projects = join(root, 'projects')
const repo = join(projects, 'repo')
mkdirSync(repo, { recursive: true })
writeFileSync(join(repo, 'notes.md'), '')

describe('dialog-last-dir', () => {
  test('first dialog with no defaultPath gets none (OS default)', async () => {
    const d = fakeDialog({ canceled: true })
    const dlg = createRememberingDialog(d.port, createLastDirStore(join(root, 'a.json')))
    await dlg.showOpenDialog(null, { properties: ['openFile'] })
    expect(d.seen[0].defaultPath).toBeUndefined()
  })

  test('picked file → next dialog opens in its folder', async () => {
    const store = createLastDirStore(join(root, 'b.json'))
    await createRememberingDialog(
      fakeDialog({ open: [join(repo, 'notes.md')] }).port,
      store
    ).showOpenDialog(null, { properties: ['openFile'] })
    const d = fakeDialog({ canceled: true })
    await createRememberingDialog(d.port, store).showOpenDialog(null, {})
    expect(d.seen[0].defaultPath).toEqual(repo)
  })

  test('picked folder → next dialog opens in that folder, not its parent', async () => {
    const store = createLastDirStore(join(root, 'c.json'))
    await createRememberingDialog(fakeDialog({ open: [repo] }).port, store).showOpenDialog(null, {
      properties: ['openDirectory']
    })
    expect(store.get()).toEqual(repo)
  })

  test('saved file → next dialog opens in its folder', async () => {
    const store = createLastDirStore(join(root, 'd.json'))
    await createRememberingDialog(
      fakeDialog({ save: join(projects, 'out.pdf') }).port,
      store
    ).showSaveDialog(null, { defaultPath: join(root, 'x.pdf') })
    expect(store.get()).toEqual(projects)
  })

  test('an explicit defaultPath is never overridden', async () => {
    const store = createLastDirStore(join(root, 'e.json'))
    store.set(repo)
    const d = fakeDialog({ canceled: true })
    await createRememberingDialog(d.port, store).showSaveDialog(null, {
      defaultPath: join(root, 'report.pdf')
    })
    expect(d.seen[0].defaultPath).toEqual(join(root, 'report.pdf'))
  })

  test('cancel does not change the remembered folder', async () => {
    const store = createLastDirStore(join(root, 'f.json'))
    store.set(repo)
    await createRememberingDialog(
      fakeDialog({ canceled: true, open: [projects] }).port,
      store
    ).showOpenDialog(null, { properties: ['openDirectory'] })
    expect(store.get()).toEqual(repo)
  })

  test('remembered folder survives a restart (new store, same file)', async () => {
    const file = join(root, 'g.json')
    createLastDirStore(file).set(repo)
    expect(createLastDirStore(file).get()).toEqual(repo)
  })

  test('a remembered folder that no longer exists is ignored', async () => {
    const file = join(root, 'h.json')
    createLastDirStore(file).set(join(root, 'gone'))
    expect(createLastDirStore(file).get()).toBeNull()
  })

  test('a corrupt store file reads as no folder', async () => {
    const file = join(root, 'i.json')
    writeFileSync(file, '{not json')
    expect(createLastDirStore(file).get()).toBeNull()
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })
})
