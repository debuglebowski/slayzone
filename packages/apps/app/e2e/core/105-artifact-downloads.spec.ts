import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import type { ElectronApplication, Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Artifact downloads cross three processes: renderer → side-car tRPC → capability
// bridge → Electron host (save dialog) → side-car writes the file. Every one of the
// procedures was silently dead after the slice-9 cutover because the router reached
// for Electron via a catch-guarded dynamic `import()` that cannot work in the
// plain-node side-car.
//
// PDF/PNG/HTML EXPORT is different: it never touches the hub. The renderer reads the
// content over tRPC, then hands it to its OWN host (`window.api.app.exportArtifact` →
// preload → main's `app:export-artifact`), which shows the save dialog and renders in
// an offscreen window — so export works the same against a remote hub.
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

/**
 * Export the way the renderer does (`exportArtifactOnThisDevice`): content from the hub
 * over tRPC, then the host's `exportArtifact`. Returns the host's result.
 */
const exportOnDevice = (
  page: Page,
  input: { id: string; title: string; mode: string; format: 'pdf' | 'png' | 'html' }
) =>
  page.evaluate(async ({ id, title, mode, format }) => {
    const client = window.getTrpcVanillaClient().artifacts as unknown as {
      readContent: { query: (arg: { id: string }) => Promise<string | null> }
    }
    const content = await client.readContent.query({ id })
    if (content === null) throw new Error('no content')
    const api = (
      window as unknown as {
        api: { app: { exportArtifact: (req: unknown) => Promise<unknown> } }
      }
    ).api
    return api.app.exportArtifact({ format, content, mode, title })
  }, input)

test.describe('Artifact downloads', () => {
  let taskId: string
  let mdArtifactId: string
  let folderId: string
  let mermaidArtifactId: string

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

    const mmd = (await s.createArtifact({
      taskId,
      title: 'diagram.mmd',
      content: 'graph TD\n  A[Start] --> B[End]\n'
    })) as { id: string }
    mermaidArtifactId = mmd.id

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

  test('export: markdown → standalone HTML file, rendered by the client', async ({
    mainWindow,
    electronApp
  }) => {
    const dest = path.join(DEST_DIR, 'report.html')
    await nextSavePath(electronApp, dest)

    const res = await exportOnDevice(mainWindow, {
      id: mdArtifactId,
      title: 'report.md',
      mode: 'markdown',
      format: 'html'
    })

    expect(res).toEqual({ ok: true })
    const html = fs.readFileSync(dest, 'utf-8')
    expect(html).toContain('<!DOCTYPE html>')
    // marked must have run — raw markdown would mean the builder never fired.
    expect(html).toContain('<strong>bold</strong>')
  })

  test('export: a dismissed save dialog is a cancel, not an error', async ({
    mainWindow,
    electronApp
  }) => {
    await nextSavePath(electronApp, null)
    const res = await exportOnDevice(mainWindow, {
      id: mdArtifactId,
      title: 'report.md',
      mode: 'markdown',
      format: 'pdf'
    })
    expect(res).toEqual({ ok: false, canceled: true })
  })

  test('export: markdown → PDF via the offscreen renderer', async ({ mainWindow, electronApp }) => {
    test.setTimeout(60_000)
    const dest = path.join(DEST_DIR, 'report.pdf')
    await nextSavePath(electronApp, dest)

    const res = await exportOnDevice(mainWindow, {
      id: mdArtifactId,
      title: 'report.md',
      mode: 'markdown',
      format: 'pdf'
    })

    expect(res).toEqual({ ok: true })
    const bytes = fs.readFileSync(dest)
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })

  // Mermaid exports inline the standalone mermaid bundle the host build ships
  // (mermaid/dist/mermaid.min.js). A missing bundle never errors: the HTML/PDF path
  // silently degrades to plain code and the PNG path declines, so assert the bundle
  // actually landed in the document and that the offscreen PNG render ran.
  test('export: mermaid → HTML inlines the mermaid bundle', async ({ mainWindow, electronApp }) => {
    const dest = path.join(DEST_DIR, 'diagram.html')
    await nextSavePath(electronApp, dest)

    const res = await exportOnDevice(mainWindow, {
      id: mermaidArtifactId,
      title: 'diagram.mmd',
      mode: 'mermaid-preview',
      format: 'html'
    })

    expect(res).toEqual({ ok: true })
    const html = fs.readFileSync(dest, 'utf-8')
    expect(html).toContain('<pre class="mermaid">')
    expect(html).toContain(
      "mermaid.initialize({ startOnLoad: false, theme: 'default', layout: 'dagre' })"
    )
    // The inlined bundle is ~3.5 MB; the plain-code fallback is a few hundred bytes.
    expect(html.length).toBeGreaterThan(1_000_000)
  })

  test('export: mermaid → PNG renders offscreen', async ({ mainWindow, electronApp }) => {
    test.setTimeout(60_000)
    const dest = path.join(DEST_DIR, 'diagram.png')
    await nextSavePath(electronApp, dest)

    const res = await exportOnDevice(mainWindow, {
      id: mermaidArtifactId,
      title: 'diagram.mmd',
      mode: 'mermaid-preview',
      format: 'png'
    })

    expect(res).toEqual({ ok: true })
    const bytes = fs.readFileSync(dest)
    expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG')
    // IHDR width: a drawn diagram, not the 10px floor of an empty page.
    expect(bytes.readUInt32BE(16)).toBeGreaterThan(50)
  })
})
