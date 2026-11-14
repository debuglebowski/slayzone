import {
  test,
  expect,
  seed,
  goHome,
  clickProject,
  resetApp,
  TEST_PROJECT_PATH
} from '../fixtures/electron'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import fs from 'fs'
import http from 'http'
import type { AddressInfo } from 'net'
import os from 'os'
import path from 'path'

// Artifact downloads and exports never write on the hub. The renderer reads the bytes
// in bounded pieces (`artifacts.readBytesChunk`) or the content (`readContent`) over
// tRPC, then hands them to its OWN host — `window.api.app.saveTarget*` (streamed) /
// `exportArtifact` → preload → main, which shows the dialog and writes (a zip is built
// there by archiver; export renders offscreen) — so they work the same against a
// remote hub.
//
// Downloads are driven through the artifact panel's real menus: the folder tree,
// zip and dialogs all run as they do for a person.
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

const artifactsPanel = (page: Page) => page.locator('[data-panel-id="artifacts"]:visible')
const sidebar = (page: Page) => artifactsPanel(page).locator('[data-testid="artifacts-sidebar"]')
const artifactRow = (page: Page, title: string) =>
  sidebar(page)
    .locator(`[data-testid^="artifact-row-"]`)
    .filter({ has: page.locator('span', { hasText: title }) })
    .locator('button')
    .filter({ has: page.locator('span', { hasText: title }) })
    .first()
const folderRow = (page: Page, name: string) =>
  sidebar(page)
    .locator(`[data-testid^="folder-row-"]`)
    .filter({ has: page.locator('button', { hasText: name }) })
    .locator('button')
    .filter({ hasText: name })
    .first()

async function openArtifactsPanel(page: Page): Promise<void> {
  if (
    await artifactsPanel(page)
      .isVisible()
      .catch(() => false)
  )
    return
  await page.keyboard.press('Meta+Shift+A')
  await expect(artifactsPanel(page)).toBeVisible({ timeout: 5_000 })
}

/** Right-click `target`, then pick the menu item named exactly `item`. */
async function menu(page: Page, target: Locator, item: string): Promise<void> {
  await target.click({ button: 'right' })
  await page.getByRole('menuitem', { name: item, exact: true }).click()
}

/**
 * The sidebar's own (root) menu, opened where 93-artifacts-panel opens it. A list
 * refresh can close a menu mid-open; reopen until the click lands.
 */
async function rootMenu(page: Page, item: string): Promise<void> {
  await expect(async () => {
    await page.keyboard.press('Escape')
    await sidebar(page).click({ button: 'right', position: { x: 10, y: 5 } })
    await page.getByRole('menuitem', { name: item, exact: true }).click({ timeout: 2_000 })
  }).toPass({ timeout: 15_000 })
}

const fileAppears = (p: string) =>
  expect.poll(() => fs.existsSync(p), { timeout: 15_000, message: `${p} written` }).toBe(true)

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
    await s.createArtifactFolder({ taskId, name: 'empty-sub', parentId: folderId })
    await s.refreshData()

    await goHome(mainWindow)
    await clickProject(mainWindow, 'DO')
    await mainWindow.getByText('Downloads task').first().click()
    await expect(mainWindow.locator('[data-testid="agent-trigger"]:visible').first()).toBeVisible({
      timeout: 5_000
    })
    await openArtifactsPanel(mainWindow)
    await expect(artifactRow(mainWindow, 'report.md')).toBeVisible({ timeout: 5_000 })
  })

  test.afterAll(async () => {
    fs.rmSync(DEST_DIR, { recursive: true, force: true })
  })

  test('download: a file lands where the person picked', async ({ mainWindow, electronApp }) => {
    const dest = path.join(DEST_DIR, 'report-copy.md')
    await nextSavePath(electronApp, dest)

    await menu(mainWindow, artifactRow(mainWindow, 'report.md'), 'Download')

    await fileAppears(dest)
    expect(fs.readFileSync(dest, 'utf-8')).toContain('Some **bold** body text.')
  })

  test('download: a dismissed dialog writes nothing and reports no error', async ({
    mainWindow,
    electronApp
  }) => {
    await nextSavePath(electronApp, null)
    const before = fs.readdirSync(DEST_DIR).length

    await menu(mainWindow, artifactRow(mainWindow, 'report.md'), 'Download')

    await mainWindow.waitForTimeout(500)
    expect(fs.readdirSync(DEST_DIR)).toHaveLength(before)
    await expect(mainWindow.getByText('Download failed')).toHaveCount(0)
  })

  test('download all as ZIP: one archive with every artifact at its folder path', async ({
    mainWindow,
    electronApp
  }) => {
    const dest = path.join(DEST_DIR, 'all.zip')
    await nextSavePath(electronApp, dest)

    await rootMenu(mainWindow, 'Download all as ZIP')

    await fileAppears(dest)
    const bytes = fs.readFileSync(dest)
    // Local file header magic — a real zip, not an empty file.
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK')
    const raw = bytes.toString('latin1')
    expect(raw).toContain('report.md')
    expect(raw).toContain('nested/inner.txt')
  })

  test('download folder: the tree lands in the chosen directory, empty folders too', async ({
    mainWindow,
    electronApp
  }) => {
    const destRoot = path.join(DEST_DIR, 'folder-dest')
    fs.mkdirSync(destRoot, { recursive: true })
    await nextOpenDir(electronApp, destRoot)

    await menu(mainWindow, folderRow(mainWindow, 'nested'), 'Download')

    const inner = path.join(destRoot, 'nested', 'inner.txt')
    await fileAppears(inner)
    expect(fs.readFileSync(inner, 'utf-8')).toBe('inner file contents')
    expect(fs.statSync(path.join(destRoot, 'nested', 'empty-sub')).isDirectory()).toBe(true)
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

  // Review 5, #5 / #14: an artifact renders where it reaches nothing of the app's, and a
  // document that never yields fails the export instead of hanging it.
  test.describe('the export window', () => {
    /** Export `content` the way the renderer does, without the hub round trip. */
    const exportContent = (
      page: Page,
      req: { content: string; mode: string; title: string; format: 'pdf' | 'png' | 'html' }
    ) =>
      page.evaluate(
        (r) =>
          (
            window as unknown as {
              api: { app: { exportArtifact: (req: unknown) => Promise<unknown> } }
            }
          ).api.app.exportArtifact(r),
        req
      )

    const windowCount = (electronApp: ElectronApplication) =>
      electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)

    test('an html artifact cannot read app storage, navigate or open windows', async ({
      mainWindow,
      electronApp
    }) => {
      test.setTimeout(60_000)
      const hits: string[] = []
      const server = http.createServer((req, res) => {
        hits.push(req.url ?? '')
        res.end('<p>reached</p>')
      })
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      try {
        await mainWindow.evaluate(() => localStorage.setItem('slz-e2e-secret', 'APP-SECRET'))
        // Every page the export opens reports its console and what it committed to.
        await electronApp.evaluate(({ app }) => {
          const g = globalThis as unknown as { __e2eExportLog?: string[] }
          g.__e2eExportLog = []
          app.on('web-contents-created', (_e, wc) => {
            wc.on('console-message', (...args: unknown[]) => {
              const first = args[0] as { message?: string }
              const msg = typeof first?.message === 'string' ? first.message : String(args[2])
              g.__e2eExportLog?.push(`console:${msg}`)
            })
            wc.on('did-navigate', (_ev, url) => g.__e2eExportLog?.push(`navigated:${url}`))
          })
        })
        const before = await windowCount(electronApp)
        const dest = path.join(DEST_DIR, 'isolated.pdf')
        await nextSavePath(electronApp, dest)
        const probe = `<p>isolated</p><script>
          var r = { origin: location.origin, node: typeof require + '/' + typeof process };
          try { r.secret = String(localStorage.getItem('slz-e2e-secret')) } catch (e) { r.secret = 'threw:' + e.name }
          try { r.cookie = document.cookie } catch (e) { r.cookie = 'threw:' + e.name }
          console.log('slz-export-probe ' + JSON.stringify(r));
          try { window.open('${base}/opened') } catch (e) {}
          location.href = '${base}/navigated';
        </script>`
        const res = await exportContent(mainWindow, {
          content: probe,
          mode: 'html-preview',
          title: 'isolated.html',
          format: 'pdf'
        })
        expect(res).toEqual({ ok: true })
        expect(fs.readFileSync(dest).subarray(0, 5).toString('latin1')).toBe('%PDF-')

        const log = () =>
          electronApp.evaluate(
            () => (globalThis as unknown as { __e2eExportLog?: string[] }).__e2eExportLog ?? []
          )
        await expect
          .poll(async () => (await log()).some((l) => l.includes('slz-export-probe')), {
            timeout: 10_000
          })
          .toBe(true)
        const line = (await log()).find((l) => l.includes('slz-export-probe')) ?? ''
        const report = JSON.parse(line.slice(line.indexOf('{'))) as Record<string, string>
        // The artifact ran (scripts work, as on main) — but in a page of its own.
        expect(report.secret).not.toBe('APP-SECRET')
        expect(report.origin).not.toMatch(/^file:/)
        expect(report.node).toBe('undefined/undefined')
        // Nothing left the document: no window, no navigation, no request for either.
        await new Promise((r) => setTimeout(r, 1_000))
        expect(hits).toEqual([])
        expect((await log()).filter((l) => l.startsWith('navigated:http'))).toEqual([])
        expect(await windowCount(electronApp)).toBe(before)
      } finally {
        server.close()
        await mainWindow.evaluate(() => localStorage.removeItem('slz-e2e-secret'))
      }
    })

    test('a document that never yields fails the export and leaves no window', async ({
      mainWindow,
      electronApp
    }) => {
      test.setTimeout(60_000)
      await electronApp.evaluate(() => {
        ;(globalThis as unknown as { __e2eExportTimings?: unknown }).__e2eExportTimings = {
          loadWaitMs: 2_000,
          unresponsiveMs: 2_000,
          readyWaitMs: 10_000
        }
      })
      try {
        const before = await windowCount(electronApp)
        const dest = path.join(DEST_DIR, 'hung.pdf')
        await nextSavePath(electronApp, dest)
        const started = Date.now()
        const res = (await exportContent(mainWindow, {
          content: '<p>x</p><script>while (true) {}</script>',
          mode: 'html-preview',
          title: 'hung.html',
          format: 'pdf'
        })) as { ok: boolean; error?: string }
        expect(res.ok).toBe(false)
        expect(res.error).toMatch(/stopped responding/)
        expect(Date.now() - started).toBeLessThan(30_000)
        expect(fs.existsSync(dest)).toBe(false)
        await expect.poll(() => windowCount(electronApp), { timeout: 10_000 }).toBe(before)
      } finally {
        await electronApp.evaluate(() => {
          delete (globalThis as unknown as { __e2eExportTimings?: unknown }).__e2eExportTimings
        })
      }
    })
  })
})
