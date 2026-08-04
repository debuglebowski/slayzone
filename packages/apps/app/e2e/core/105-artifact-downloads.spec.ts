import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import type { ElectronApplication, Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Artifact downloads cross three processes: renderer → side-car tRPC → capability
// bridge → Electron host (save dialog + offscreen PDF/PNG render) → side-car writes
// the file. Every one of the 6 procedures was silently dead after the slice-9 cutover
// because the router reached for Electron via a catch-guarded dynamic `import()` that
// cannot work in the plain-node side-car.
//
// These tests stub only the *native dialog* (in the main process, via
// electronApp.evaluate) and let the whole rest of the chain run for real. A test-only
// "write straight to this path" op would route around the bridge and pass against the
// broken build, which is exactly the regression that shipped.
//
// Destinations live under $HOME, not tmpdir — the slz-file:// home guard rejects paths
// outside $HOME and has tripped fixtures here before.

const DEST_DIR = path.join(os.homedir(), '.slayzone-e2e-downloads')

/** Replace the native save/open dialogs with ones driven by main-process globals. */
async function installDialogStubs(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ dialog }) => {
    const g = globalThis as unknown as {
      __e2eSavePath?: string | null
      __e2eOpenDir?: string | null
    }
    g.__e2eSavePath = null
    g.__e2eOpenDir = null
    dialog.showSaveDialog = (async () =>
      g.__e2eSavePath
        ? { canceled: false, filePath: g.__e2eSavePath }
        : { canceled: true }) as typeof dialog.showSaveDialog
    dialog.showOpenDialog = (async () =>
      g.__e2eOpenDir
        ? { canceled: false, filePaths: [g.__e2eOpenDir] }
        : { canceled: true, filePaths: [] }) as typeof dialog.showOpenDialog
  })
}

/** Point the stubbed save dialog at `dest` for the next download. */
async function nextSavePath(electronApp: ElectronApplication, dest: string | null): Promise<void> {
  await electronApp.evaluate((_electron, p) => {
    ;(globalThis as unknown as { __e2eSavePath?: string | null }).__e2eSavePath = p
  }, dest)
}

/** Point the stubbed directory picker at `dir` for the next folder download. */
async function nextOpenDir(electronApp: ElectronApplication, dir: string | null): Promise<void> {
  await electronApp.evaluate((_electron, d) => {
    ;(globalThis as unknown as { __e2eOpenDir?: string | null }).__e2eOpenDir = d
  }, dir)
}

const download = (page: Page, proc: string, input: unknown) =>
  page.evaluate(
    ([p, i]) =>
      (
        window.getTrpcVanillaClient().artifacts as unknown as Record<
          string,
          { mutate: (arg: unknown) => Promise<boolean> }
        >
      )[p as string].mutate(i),
    [proc, input] as const
  )

test.describe('Artifact downloads', () => {
  let taskId: string
  let mdArtifactId: string
  let folderId: string

  test.beforeAll(async ({ mainWindow, electronApp }) => {
    await resetApp(mainWindow)
    fs.rmSync(DEST_DIR, { recursive: true, force: true })
    fs.mkdirSync(DEST_DIR, { recursive: true })
    await installDialogStubs(electronApp)

    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Downloads Test',
      color: '#10b981',
      path: TEST_PROJECT_PATH
    })
    const t = await s.createTask({ projectId: p.id, title: 'Downloads task', status: 'todo' })
    taskId = t.id

    const md = (await s.createArtifact({
      taskId,
      title: 'report.md',
      content: '# Heading\n\nSome **bold** body text.\n'
    })) as { id: string }
    mdArtifactId = md.id

    const folder = (await s.createArtifactFolder({ taskId, name: 'nested' })) as { id: string }
    folderId = folder.id
    await s.createArtifact({
      taskId,
      title: 'inner.txt',
      content: 'inner file contents',
      folderId
    })
  })

  test.afterAll(async () => {
    fs.rmSync(DEST_DIR, { recursive: true, force: true })
  })

  test('downloadFile writes the artifact to the chosen path', async ({
    mainWindow,
    electronApp
  }) => {
    const dest = path.join(DEST_DIR, 'report-copy.md')
    await nextSavePath(electronApp, dest)

    const ok = await download(mainWindow, 'downloadFile', { id: mdArtifactId })

    expect(ok).toBe(true)
    expect(fs.existsSync(dest)).toBe(true)
    expect(fs.readFileSync(dest, 'utf-8')).toContain('Some **bold** body text.')
  })

  test('downloadFile returns false when the dialog is cancelled', async ({
    mainWindow,
    electronApp
  }) => {
    await nextSavePath(electronApp, null)
    expect(await download(mainWindow, 'downloadFile', { id: mdArtifactId })).toBe(false)
  })

  test('downloadAllAsZip writes a zip archive', async ({ mainWindow, electronApp }) => {
    const dest = path.join(DEST_DIR, 'all.zip')
    await nextSavePath(electronApp, dest)

    const ok = await download(mainWindow, 'downloadAllAsZip', { taskId })

    expect(ok).toBe(true)
    expect(fs.existsSync(dest)).toBe(true)
    const bytes = fs.readFileSync(dest)
    expect(bytes.length).toBeGreaterThan(0)
    // Local file header magic — proves archiver actually finalized.
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK')
    // Both artifacts should be named in the central directory.
    const raw = bytes.toString('latin1')
    expect(raw).toContain('report.md')
    expect(raw).toContain('inner.txt')
  })

  test('downloadFolder copies the folder tree into the chosen directory', async ({
    mainWindow,
    electronApp
  }) => {
    const destRoot = path.join(DEST_DIR, 'folder-dest')
    fs.mkdirSync(destRoot, { recursive: true })
    await nextOpenDir(electronApp, destRoot)

    const ok = await download(mainWindow, 'downloadFolder', { folderId })

    expect(ok).toBe(true)
    const inner = path.join(destRoot, 'nested', 'inner.txt')
    expect(fs.existsSync(inner)).toBe(true)
    expect(fs.readFileSync(inner, 'utf-8')).toBe('inner file contents')
  })

  test('downloadAsHtml renders markdown to a standalone HTML file', async ({
    mainWindow,
    electronApp
  }) => {
    const dest = path.join(DEST_DIR, 'report.html')
    await nextSavePath(electronApp, dest)

    const ok = await download(mainWindow, 'downloadAsHtml', { id: mdArtifactId })

    expect(ok).toBe(true)
    const html = fs.readFileSync(dest, 'utf-8')
    expect(html).toContain('<!DOCTYPE html>')
    // marked must have run host-side — raw markdown would mean the builder never fired.
    expect(html).toContain('<strong>bold</strong>')
  })

  test('downloadAsPdf renders via the offscreen host renderer', async ({
    mainWindow,
    electronApp
  }) => {
    test.setTimeout(60_000)
    const dest = path.join(DEST_DIR, 'report.pdf')
    await nextSavePath(electronApp, dest)

    const ok = await download(mainWindow, 'downloadAsPdf', { id: mdArtifactId })

    expect(ok).toBe(true)
    const bytes = fs.readFileSync(dest)
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })
})
