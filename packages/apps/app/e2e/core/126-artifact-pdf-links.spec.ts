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

const linkCalls = (app: ElectronApplication) =>
  app.evaluate(() => [...((globalThis as Record<string, unknown>).__pdfLinkCalls as string[])])

test.describe('PDF artifact links', () => {
  let taskId: string

  test.beforeAll(async ({ electronApp, mainWindow }) => {
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

  test('bare click on a PDF link opens it externally', async ({ electronApp, mainWindow }) => {
    const url = 'https://example.com/pdf-link'
    const s = seed(mainWindow)
    await s.createArtifact({ taskId, title: 'links.pdf', content: pdfWithFullPageLink(url) })
    await s.refreshData()
    if (
      !(await artifactsPanel(mainWindow)
        .isVisible()
        .catch(() => false))
    ) {
      await mainWindow.keyboard.press('Meta+Shift+A')
    }
    await artifactRow(mainWindow, 'links.pdf').click()
    const box = await pdfFrame(mainWindow).boundingBox()
    expect(box).not.toBeNull()

    // The viewer + main's bridge load asynchronously and expose nothing to
    // Playwright; retry the real click until the bridge routes it.
    await expect(async () => {
      await mainWindow.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
      expect(await linkCalls(electronApp)).toContain(url)
    }).toPass({ timeout: 15_000 })
    // The app window itself did not navigate to the link.
    expect(mainWindow.url()).not.toContain('example.com')
  })
})
