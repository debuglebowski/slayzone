import {
  test,
  expect,
  seed,
  goHome,
  clickProject,
  resetApp,
  TEST_PROJECT_PATH
} from '../fixtures/electron'
import type { ElectronApplication, Page } from '@playwright/test'

const artifactsPanel = (page: Page) => page.locator('[data-panel-id="artifacts"]:visible')
const artifactRow = (page: Page, title: string) =>
  artifactsPanel(page)
    .locator('[data-testid="artifacts-sidebar"] [data-testid^="artifact-row-"]')
    .filter({ hasText: title })
    .first()
const pdfFrame = (page: Page) => artifactsPanel(page).locator('iframe[title="PDF preview"]')

/** One-page PDF whose single link annotation covers the whole page. */
function pdfWithFullPageLink(url: string): string {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Annots [5 0 R] >>',
    '<< /Length 0 >>\nstream\n\nendstream',
    `<< /Type /Annot /Subtype /Link /Rect [0 0 612 792] /Border [0 0 0] /A << /S /URI /URI (${url}) >> >>`
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((obj, i) => {
    offsets.push(body.length)
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) body += `${String(o).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return body
}

const PDF_VIEWER_ORIGIN = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai'

const linkCalls = (app: ElectronApplication) =>
  app.evaluate(() => [...((globalThis as Record<string, unknown>).__pdfLinkCalls as string[])])

test.describe('PDF artifact links', () => {
  let taskId: string

  const LINK_URL = 'https://example.com/pdf-link'
  let linkAt: { x: number; y: number } | null = null
  const openOnce = async (app: ElectronApplication, page: Page) =>
    (linkAt ??= await openLinkPdf(app, page, 'links.pdf', LINK_URL))
  const countCalls = async (app: ElectronApplication) =>
    (await linkCalls(app)).filter((u) => u === LINK_URL).length

  test.beforeAll(async ({ electronApp, mainWindow }) => {
    linkAt = null
    await resetApp(mainWindow)
    await electronApp.evaluate(({ shell }) => {
      const g = globalThis as Record<string, unknown>
      g.__pdfLinkCalls = [] as string[]
      g.__pdfLinkOriginal = shell.openExternal.bind(shell)
      Object.defineProperty(shell, 'openExternal', {
        configurable: true,
        writable: true,
        value: async (url: string) => {
          ;(g.__pdfLinkCalls as string[]).push(url)
        }
      })
    })
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'PDF Links',
      color: '#3b82f6',
      path: TEST_PROJECT_PATH
    })
    const t = await s.createTask({ projectId: p.id, title: 'PDF links task', status: 'todo' })
    taskId = t.id
    await s.refreshData()
    await goHome(mainWindow)
    await clickProject(mainWindow, p.name.slice(0, 2).toUpperCase())
    await mainWindow.getByText('PDF links task').first().click()
    await expect(
      mainWindow.locator('[data-testid="terminal-mode-trigger"]:visible').first()
    ).toBeVisible({ timeout: 5_000 })
  })

  test.afterAll(async ({ electronApp }) => {
    await electronApp.evaluate(({ shell }) => {
      const g = globalThis as Record<string, unknown>
      if (g.__pdfLinkOriginal) {
        Object.defineProperty(shell, 'openExternal', {
          configurable: true,
          writable: true,
          value: g.__pdfLinkOriginal
        })
      }
      delete g.__pdfLinkCalls
      delete g.__pdfLinkOriginal
    })
  })

  /** Task browser-panel tab URLs, as persisted. */
  const browserTabUrls = (page: Page) =>
    page.evaluate(async (id) => {
      const tasks = await window.getTrpcVanillaClient().task.getAll.query()
      const task = tasks.find((t) => t.id === id) as
        | { browser_tabs?: { tabs?: { url: string }[] } | null }
        | undefined
      return task?.browser_tabs?.tabs?.map((t) => t.url) ?? []
    }, taskId)

  /**
   * Seed a one-link PDF, select it, and wait until main's bridge is installed in
   * its viewer frame (probed from main — the extension frame is invisible to
   * Playwright). A bare click before that would navigate the whole app window.
   *
   * Called ONCE per run: swapping one PDF artifact for another intermittently
   * re-points Playwright's main-window Page at the old viewer's extension frame
   * (measured: `page.url()` = the viewer while the app's webContents stayed on
   * index.html), after which every locator searches the wrong document.
   */
  async function openLinkPdf(app: ElectronApplication, page: Page, title: string, url: string) {
    const s = seed(page)
    const artifact = (await s.createArtifact({
      taskId,
      title,
      content: pdfWithFullPageLink(url)
    })) as { id: string }
    await s.refreshData()
    if (
      !(await artifactsPanel(page)
        .isVisible()
        .catch(() => false))
    ) {
      await page.keyboard.press('Meta+Shift+A')
    }
    await artifactRow(page, title).click()
    // THIS artifact's frame: an earlier test's viewer can still be alive (and
    // bridged) while the panel swaps documents.
    const filePath = await page.evaluate(
      (id) => window.getTrpcVanillaClient().artifacts.getFilePath.query({ id }),
      artifact.id
    )
    expect(filePath).toBeTruthy()
    // Matched by path, not full URL: selecting a PDF swaps the iframe's src
    // `?v=N` → `?v=N+1` (preview version bump), and the frame can still report
    // either one (measured: attribute `?v=2`, live bridged frame `?v=1`).
    const docUrl = `slz-file://app${filePath}`
    await expect
      .poll(
        () =>
          app.evaluate(
            async ({ webContents }, { docUrl, origin }) => {
              const viewers = webContents
                .getAllWebContents()
                .flatMap((wc) => wc.mainFrame.framesInSubtree)
                .filter((f) => f.url.split('?')[0] === docUrl)
                .flatMap((f) => f.framesInSubtree)
                .filter((f) => f.origin === origin)
              const installed = await Promise.all(
                viewers.map((f) =>
                  f.executeJavaScript('window.__slzPdfViewerLinkBridge === true').catch(() => false)
                )
              )
              return installed.some(Boolean)
            },
            { docUrl, origin: PDF_VIEWER_ORIGIN }
          ),
        { timeout: 15_000 }
      )
      .toBe(true)
    const box = await pdfFrame(page).boundingBox()
    expect(box).not.toBeNull()
    return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
  }

  /**
   * Real click with modifiers held via the keyboard: Playwright's click
   * `modifiers` don't reach MouseEvent flags in Electron. Retried because the
   * viewer can still be painting the page when the bridge is already in.
   */
  async function clickUntil(
    page: Page,
    at: { x: number; y: number },
    keys: string[],
    done: () => Promise<void>
  ) {
    await expect(async () => {
      for (const k of keys) await page.keyboard.down(k)
      try {
        await page.mouse.click(at.x, at.y)
      } finally {
        for (const k of [...keys].reverse()) await page.keyboard.up(k)
      }
      await done()
    }).toPass({ timeout: 15_000 })
  }

  test('bare click on a PDF link opens it externally', async ({ electronApp, mainWindow }) => {
    const at = await openOnce(electronApp, mainWindow)
    const before = await countCalls(electronApp)
    await clickUntil(mainWindow, at, [], async () => {
      expect(await countCalls(electronApp)).toBeGreaterThan(before)
    })
    // The app window itself did not navigate to the link.
    expect(mainWindow.url()).not.toContain('example.com')
    expect(await browserTabUrls(mainWindow)).not.toContain(LINK_URL)
  })

  test('⌘⇧ click on a PDF link opens it externally', async ({ electronApp, mainWindow }) => {
    const at = await openOnce(electronApp, mainWindow)
    const before = await countCalls(electronApp)
    await clickUntil(mainWindow, at, ['Meta', 'Shift'], async () => {
      expect(await countCalls(electronApp)).toBeGreaterThan(before)
    })
    expect(await browserTabUrls(mainWindow)).not.toContain(LINK_URL)
  })

  // Opens the browser panel — keep LAST.
  test("⌘ click on a PDF link opens it in the task's in-app browser", async ({
    electronApp,
    mainWindow
  }) => {
    const at = await openOnce(electronApp, mainWindow)
    const before = await countCalls(electronApp)
    await clickUntil(mainWindow, at, ['Meta'], async () => {
      expect(await browserTabUrls(mainWindow)).toContain(LINK_URL)
    })
    expect(await countCalls(electronApp)).toBe(before)
    await expect(mainWindow.locator('[data-browser-panel]:visible').first()).toBeVisible()
  })
})
