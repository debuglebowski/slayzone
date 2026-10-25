/**
 * Tests for the remembered dialog folder. Electron 43 opens a dialog with no
 * `defaultPath` in Downloads and the OS stopped remembering the last folder, so the
 * app remembers it: a dialog without `defaultPath` starts where the user last picked.
 *
 * Run with: npx tsx packages/apps/app/src/main/dialog-last-dir.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLastDirStore, createRememberingDialog } from './dialog-last-dir'

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? e.message : e}`)
    failed++
  }
}

function eq<T>(actual: T, expected: T, label?: string): void {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${label ? `${label}: ` : ''}expected ${b}, got ${a}`)
}

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

async function main(): Promise<void> {
  console.log('dialog-last-dir')

  await test('first dialog with no defaultPath gets none (OS default)', async () => {
    const d = fakeDialog({ canceled: true })
    const dlg = createRememberingDialog(d.port, createLastDirStore(join(root, 'a.json')))
    await dlg.showOpenDialog(null, { properties: ['openFile'] })
    eq(d.seen[0].defaultPath, undefined)
  })

  await test('picked file → next dialog opens in its folder', async () => {
    const store = createLastDirStore(join(root, 'b.json'))
    await createRememberingDialog(
      fakeDialog({ open: [join(repo, 'notes.md')] }).port,
      store
    ).showOpenDialog(null, { properties: ['openFile'] })
    const d = fakeDialog({ canceled: true })
    await createRememberingDialog(d.port, store).showOpenDialog(null, {})
    eq(d.seen[0].defaultPath, repo)
  })

  await test('picked folder → next dialog opens in that folder, not its parent', async () => {
    const store = createLastDirStore(join(root, 'c.json'))
    await createRememberingDialog(fakeDialog({ open: [repo] }).port, store).showOpenDialog(null, {
      properties: ['openDirectory']
    })
    eq(store.get(), repo)
  })

  await test('saved file → next dialog opens in its folder', async () => {
    const store = createLastDirStore(join(root, 'd.json'))
    await createRememberingDialog(
      fakeDialog({ save: join(projects, 'out.pdf') }).port,
      store
    ).showSaveDialog(null, { defaultPath: join(root, 'x.pdf') })
    eq(store.get(), projects)
  })

  await test('an explicit defaultPath is never overridden', async () => {
    const store = createLastDirStore(join(root, 'e.json'))
    store.set(repo)
    const d = fakeDialog({ canceled: true })
    await createRememberingDialog(d.port, store).showSaveDialog(null, {
      defaultPath: join(root, 'report.pdf')
    })
    eq(d.seen[0].defaultPath, join(root, 'report.pdf'))
  })

  await test('cancel does not change the remembered folder', async () => {
    const store = createLastDirStore(join(root, 'f.json'))
    store.set(repo)
    await createRememberingDialog(
      fakeDialog({ canceled: true, open: [projects] }).port,
      store
    ).showOpenDialog(null, { properties: ['openDirectory'] })
    eq(store.get(), repo)
  })

  await test('remembered folder survives a restart (new store, same file)', async () => {
    const file = join(root, 'g.json')
    createLastDirStore(file).set(repo)
    eq(createLastDirStore(file).get(), repo)
  })

  await test('a remembered folder that no longer exists is ignored', async () => {
    const file = join(root, 'h.json')
    createLastDirStore(file).set(join(root, 'gone'))
    eq(createLastDirStore(file).get(), null)
  })

  await test('a corrupt store file reads as no folder', async () => {
    const file = join(root, 'i.json')
    writeFileSync(file, '{not json')
    eq(createLastDirStore(file).get(), null)
  })

  rmSync(root, { recursive: true, force: true })
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
